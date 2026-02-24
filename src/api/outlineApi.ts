// ── Curtin OutSystems API — Unit Outline integration ──────────────────────────
// Fetches unit outline data from the publicly accessible OutSystems API at
// curtin.outsystems.app/UnitOutlineBuilder. No authentication is required —
// the /Public/ route is an unauthenticated OutSystems endpoint.
//
// Data flow:
//   1. getUnitLookup()        → cached map of unit code → {cd, vers}
//   2. getAvailabilityResult() → cached semester/year → availability "Value" string + full list
//   3. fetchModuleVersion()   → fresh deployment token (changes on each deploy)
//   4. POST ScreenDataSetGetNew → UobOutline with AS_TASK + PC_TEXT
//   5. outlineToDeadlines()   → array of PendingDeadline for the confirmation UI

import type { PendingDeadline } from '../types';
import { parseOrdinalDate } from '../utils/getDates';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Base URL for all OutSystems API calls. */
const BASE = 'https://curtin.outsystems.app/UnitOutlineBuilder';

/**
 * Per-endpoint API version tokens sourced from authenticated HAR capture.
 * Each OutSystems screen action has its own distinct apiVersion baked into the
 * client JS bundle. Using the wrong token causes `hasApiVersionChanged: true`
 * in the response and the `data` key is withheld entirely.
 * These tokens change only when the server is redeployed.
 */
const API_VERSIONS: Record<string, string> = {
  ScreenDataSetGetFilterUnit: 'axSR8n8P8MsJ41MrNViNvg',
  DataActionGetAvailabilities: 'igu7+gCJcnPAU_YQy5dB4g',
  ScreenDataSetGetNew: 'aDiUvMK2z_RjPnvHmPq_Wg',
};

/** chrome.storage.local key for the unit code → {cd, vers} lookup cache. */
const UNIT_CACHE_KEY = 'outlineApiUnitLookup';

// (No avails cache key — avails are always fetched fresh per unit; see note above.)

/** How long to keep each cache before re-fetching (30 days). */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single unit's numeric identifiers used in API requests. */
interface UnitEntry {
  cd: number;   // UNIT_CD — OutSystems primary key
  vers: number; // UNIT_VERS — version number (usually 1)
}

/** Persistent cache: unit code string → UnitEntry. */
interface UnitLookupCache {
  entries: Record<string, UnitEntry>;
  fetchedAt: number; // Date.now() timestamp
}

// Note: availability IDs are per-unit (each unit has its own ID for the same
// semester + campus), so they cannot be cached across units. The avails fetch
// is lightweight (~18 KB) and is always performed fresh per fetchOutline call.

/** OutSystems wraps every list in {List: [...]}. */
interface OsListWrapper<T> {
  List: T[];
}

/** One unit record from ScreenDataSetGetFilterUnit. */
interface VwOsUnit {
  UNIT_CD: number;
  UNIT_VERS: number;
  FULL_TITLE: string;
  UNIT_CD_UDC: string; // human-readable code, e.g. "COMP1005"
}

/** One availability entry from DataActionGetAvailabilities. */
interface AvailEntry {
  Value: string; // e.g. "834718,INT"
  Label: string; // e.g. "2026 Semester 1, [Internal] Bentley Perth Campus"
}

/** Key fields from UobOutline in the ScreenDataSetGetNew response. */
interface UobOutline {
  UnitNumber: string;        // e.g. "COMP1005"
  Title: string;             // e.g. "Fundamentals of Programming"
  Avail_Study_Period: string; // e.g. "Semester 1"
  Avail_Year: string;        // e.g. "2026"
  AS_TASK: string;           // pipe-delimited assessment list
  PC_TEXT: string;           // HTML table with week-by-week calendar
}

// ── POST helper ───────────────────────────────────────────────────────────────

/**
 * Sends a POST request to an OutSystems screenservices endpoint and returns
 * the parsed JSON response. Throws a user-friendly Error on HTTP failure.
 */
async function osPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    // Set Referer to the OutSystems page URL so the server's CSRF/aggregate checks pass.
    // OutSystems only runs data aggregates when the request looks like it originates from
    // its own page. Without a matching Referer, the response contains only version metadata
    // and no `data` key. The fetch `referrer` option is the standard way to set Referer
    // programmatically (unlike the `Referer` header name, which is forbidden in fetch).
    referrer: `${BASE}/OutlineHub`,
    referrerPolicy: 'unsafe-url',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API request failed (HTTP ${res.status}). Please try again.`);
  }
  return res.json();
}

// ── Module version ────────────────────────────────────────────────────────────

/** In-memory cache for the module version token. */
let moduleVersionCache: { token: string; fetchedAt: number } | null = null;

/** Module version token is valid for 5 minutes — it only changes on server deploys. */
const MODULE_VERSION_TTL_MS = 5 * 60 * 1000;

/**
 * Fetches the moduleVersion token from the OutSystems deployment endpoint.
 * The token is cached in memory for 5 minutes — it changes only on server
 * deploys, not between requests, so a short cache is safe and avoids
 * unnecessary round-trips during bulk operations (e.g. Grab All).
 */
async function fetchModuleVersion(): Promise<string> {
  // Return cached token if still fresh
  if (moduleVersionCache && Date.now() - moduleVersionCache.fetchedAt < MODULE_VERSION_TTL_MS) {
    return moduleVersionCache.token;
  }
  const res = await fetch(`${BASE}/moduleservices/moduleversioninfo`);
  if (!res.ok) {
    throw new Error(`Failed to reach Curtin API (HTTP ${res.status}). Check your connection.`);
  }
  const data = (await res.json()) as { versionToken: string };
  moduleVersionCache = { token: data.versionToken, fetchedAt: Date.now() };
  return data.versionToken;
}

// ── Shared request body builder ───────────────────────────────────────────────

/**
 * Empty dropdown list item shape required by OutSystems for all dd_ lists.
 * Must be present even when the List array is empty, otherwise the server
 * returns HTTP 400 (it uses EmptyListItem to know the schema of the list).
 */
const EMPTY_DD_ITEM = {
  Value: '',
  Label: '',
  ImageUrlOrIconClass: '',
  GroupName: '',
  Description: '',
};

/**
 * Empty item shape for the ExtractedAvails list (VW_OS_UNIT aggregate schema).
 * Uses OutSystems sentinel values: MinInt for integers, 1900-01-01 for dates,
 * and the MinDecimal string for the CREDIT_VALUE decimal field.
 * Required alongside List: [] when ExtractedAvails is not populated.
 */
const EMPTY_AVAIL_ITEM = {
  UNIT_CD: -2147483648,
  UNIT_VERS: -2147483648,
  FULL_TITLE: '',
  ABBREV_TITLE: '',
  STAGE: '',
  AVAILABLE_YEAR: -2147483648,
  UNIT_LEVEL: '',
  CREDIT_VALUE: '-79228162514264337593543950335',
  RESULT_TYPE: '',
  COORDINATOR: '',
  ADMIN_DETAILS: '',
  OWNING_ORG_CD: '',
  FACULTY_CD: '',
  ACTIVE_FG: '',
  CREATED_DATE: '1900-01-01T00:00:00',
  CHANGED_DATE: '1900-01-01T00:00:00',
  EFFECTIVE_DATE: '1900-01-01T00:00:00',
  DEACTIVATION_DATE: '1900-01-01T00:00:00',
  STAGE_DESC: '',
  SPK_CAT_CD: '',
  UNIT_CD_UDC: '',
  FACULTY_ORG_CODE: '',
  FACULTY_ORG_NAME: '',
  FACULTY_ORG_SHORT_NAME: '',
  FACULTY_ORG_TYPE: '',
  FACULTY_TOP_ORG_CODE: '',
  FACULTY_TOP_ORG: '',
  FACULTY_DATA_YEAR: -2147483648,
  FACULTY_IS_CURRENT: '',
  FACULTY_CREATED_DATE: '1900-01-01T00:00:00',
  FACULTY_CHANGED_DATE: '1900-01-01T00:00:00',
  AREA_ORG_CODE: '',
  AREA_ORG_NAME: '',
  AREA_ORG_SHORT_NAME: '',
  AREA_ORG_TYPE: '',
  AREA_TOP_ORG_CODE: '',
  AREA_TOP_ORG: '',
  AREA_DATA_YEAR: -2147483648,
  AREA_IS_CURRENT: '',
  AREA_CREATED_DATE: '1900-01-01T00:00:00',
  AREA_CHANGED_DATE: '1900-01-01T00:00:00',
  AVAIL_KEY_NO: -2147483648,
  AVAIL_NO: -2147483648,
  AVAIL_DESCRIPTION: '',
  AVAIL_YEAR: -2147483648,
  AVAIL_STUDYPERIOD_CD: '',
  AVAIL_STUDY_PERIOD: '',
  AVAIL_TO_STU_FG: '',
  AVAIL_LOCATION_CD: '',
  AVAIL_LOCATION: '',
  AVAIL_CURR_NO_ENROLLED: -2147483648,
  AVAIL_START_DATE: '1900-01-01T00:00:00',
  AVAIL_END_DATE: '1900-01-01T00:00:00',
  AVAIL_ACTIVE_FG: '',
  AVAIL_CREATED_DATE: '1900-01-01T00:00:00',
  AVAIL_CHANGE_DATE: '1900-01-01T00:00:00',
  AVAIL_ATT_MODE_AVAIL_KEY_NO: -2147483648,
  ATTNDC_MODE_CD: '',
  ATTENDANCE_MODE: '',
  AVAIL_ATT_CREATED_DATE: '1900-01-01T00:00:00',
  AVAIL_ATT_CHANGED_DATE: '1900-01-01T00:00:00',
  HR_EMPLOYEE: '',
  SURNAME: '',
  TITLE: '',
  FIRST_NAME: '',
  PREFERRED_NAME: '',
};

/**
 * Anonymous-user clientVariables block. All permission flags are false and
 * all identity fields are empty — the Public endpoint does not require auth.
 * The block itself must be present or OutSystems returns HTTP 400.
 */
const ANON_CLIENT_VARS = {
  IsAllowedFlag_Expired: true,
  IsUserAdmin: false,
  RedirectTimer: 0,
  UserPhotoURL: '',
  IsUserStandard: false,
  LastURL: '',
  UserName: '',
  IsAllowedFlag: false,
  IsUserSchool: false,
  IsUserLibrary: false,
  CurtinID: '',
  IsUserFaculty: false,
  User_OS_id: '',
};

/**
 * Constructs a minimal screenservices request body matching the structure
 * confirmed working in the authenticated HAR capture.
 *
 * Key requirements (learned from HAR analysis):
 * - Every empty List must include an EmptyListItem matching its schema —
 *   OutSystems uses this to validate the list's field types (HTTP 400 without it).
 * - clientVariables must be present (use empty/false defaults for anonymous access).
 * - inputParameters: {} must be present for screen data endpoints.
 * - Each endpoint has its own distinct apiVersion — pass from API_VERSIONS.
 *
 * The `variables` object is spread last so callers can override any default
 * (e.g. filterList_units with actual data, SelectedUnitCD, IsSearchingAvails).
 * When overriding a list with populated data, omit EmptyListItem from the override.
 */
function buildMinimalBody(
  moduleVersion: string,
  apiVersion: string,
  variables: Record<string, unknown>,
): unknown {
  return {
    versionInfo: { moduleVersion, apiVersion },
    viewName: 'Public.OutlineHub',
    screenData: {
      variables: {
        // Dropdown lists — each needs EmptyListItem even when empty
        filterList_units: { List: [], EmptyListItem: EMPTY_DD_ITEM },
        selectionList_units: { List: [], EmptyListItem: EMPTY_DD_ITEM },
        filterList_avails: { List: [], EmptyListItem: EMPTY_DD_ITEM },
        selectionList_avails: { List: [], EmptyListItem: EMPTY_DD_ITEM },
        // Scalar selection fields
        SelectedUnitCD: 0,
        SelectedUnitVers: 0,
        SelectedAvailKeyNo: 0,
        SelectedAttcModeCD: '',
        ResultFile: { FileName: '', File: null, Link: '' },
        legacyFilename: '',
        IsLegacy: false,
        IsDirectDownload: false,
        IsDirectDwFailed: false,
        IsDirectDwFetching: false,
        // ExtractedAvails uses the full VW_OS_UNIT schema in EmptyListItem
        ExtractedAvails: { List: [], EmptyListItem: EMPTY_AVAIL_ITEM },
        IsSearchingAvails: false,
        GUID: '',
        _gUIDInDataFetchStatus: 1,
        unitcd: 0,
        _unitcdInDataFetchStatus: 1,
        availcd: 0,
        _availcdInDataFetchStatus: 1,
        GetSettings: {
          CutDate: '2024-09-27',
          IsTodayBeforeCutDate: false,
          DataFetchStatus: 1,
        },
        // Caller overrides — placed last so they win over defaults above
        ...variables,
      },
    },
    inputParameters: {},
    clientVariables: ANON_CLIENT_VARS,
  };
}

/** Helper: build a standard OutSystems dropdown list item with blank labels. */
function osListItem(value: string): Record<string, string> {
  return { Value: value, Label: '', ImageUrlOrIconClass: '', GroupName: '', Description: '' };
}

// ── Unit lookup cache ─────────────────────────────────────────────────────────

/**
 * Returns the cached unit code → {cd, vers} lookup map.
 *
 * On first call (or when the 30-day cache has expired), fetches ALL ~12 k active
 * Curtin units from ScreenDataSetGetFilterUnit (~8 MB response) and persists a
 * compact lookup (~280 KB) to chrome.storage.local.
 *
 * Subsequent calls within the TTL are instant (cache hit, no network request).
 */
async function getUnitLookup(): Promise<Record<string, UnitEntry>> {
  // Check for a valid, non-empty cache hit.
  // An empty entries object means the previous fetch parsed incorrectly — treat as stale.
  const stored = await chrome.storage.local.get(UNIT_CACHE_KEY);
  const cached = stored[UNIT_CACHE_KEY] as UnitLookupCache | undefined;
  if (cached && Object.keys(cached.entries).length > 0 && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.entries;
  }

  // Cache is missing, empty, or stale — fetch fresh unit list
  const moduleVersion = await fetchModuleVersion();
  const body = buildMinimalBody(moduleVersion, API_VERSIONS.ScreenDataSetGetFilterUnit, {});
  const rawResp = await osPost(
    'screenservices/UnitOutlineBuilder/Public/OutlineHub/ScreenDataSetGetFilterUnit',
    body,
  );

  // Each list element wraps a single VW_OS_UNIT object:
  // resp.data.List.List[n] = { VW_OS_UNIT: { UNIT_CD, UNIT_VERS, UNIT_CD_UDC, ... } }
  const resp = rawResp as { data?: { List?: OsListWrapper<{ VW_OS_UNIT: VwOsUnit }> } };
  const listItems = resp?.data?.List?.List ?? [];

  // Build compact {UNIT_CODE → {cd, vers}} map from the full unit list
  const entries: Record<string, UnitEntry> = {};
  for (const item of listItems) {
    const u = item?.VW_OS_UNIT;
    if (!u?.UNIT_CD_UDC) continue;
    const code = u.UNIT_CD_UDC.trim().toUpperCase();
    // Skip purely numeric UDC codes (legacy units use their UNIT_CD as UDC string)
    if (!code || /^\d+$/.test(code)) continue;
    entries[code] = { cd: u.UNIT_CD, vers: u.UNIT_VERS };
  }

  // Persist the compact lookup with a fresh timestamp (even if empty — will retry next call)
  const newCache: UnitLookupCache = { entries, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [UNIT_CACHE_KEY]: newCache });
  return entries;
}

// ── Availability lookup ───────────────────────────────────────────────────────

/**
 * Fetches availability data for the given unit and semester/year.
 *
 * Returns the availability "Value" string (e.g. "835025,INT") for Bentley
 * Perth AND the full list of all availability entries for this unit.
 *
 * Availability IDs are per-unit — ELEN1000 S1 2026 Bentley has a different ID
 * than COMP1005 S1 2026 Bentley. Caching across units would return the wrong ID,
 * so this function always fetches fresh (~18 KB, fast). No cache is used.
 *
 * The full allItems list is required for filterList_avails in ScreenDataSetGetNew:
 * the server only returns the correct unit when the avails filter includes all of
 * the unit's offerings (it uses filterList_avails as a scope for the query).
 *
 * unitCd and unitVers must be the selected unit — the server returns an empty
 * Avails_dd.List when SelectedUnitCD is zero.
 */
async function getAvailabilityResult(
  semester: 1 | 2,
  year: number,
  unitCd: number,
  unitVers: number,
): Promise<{ value: string; allItems: AvailEntry[] }> {
  // Always fetch fresh — availability IDs are unit-specific and cannot be shared
  const moduleVersion = await fetchModuleVersion();
  const body = buildMinimalBody(moduleVersion, API_VERSIONS.DataActionGetAvailabilities, {
    IsSearchingAvails: true,
    SelectedUnitCD: unitCd,
    SelectedUnitVers: unitVers,
  });
  const resp = (await osPost(
    'screenservices/UnitOutlineBuilder/Public/OutlineHub/DataActionGetAvailabilities',
    body,
  )) as { data?: { Avails_dd?: OsListWrapper<AvailEntry> } };

  // All availability entries for this unit (all campuses + semesters)
  const allItems = resp?.data?.Avails_dd?.List ?? [];

  // Find the Bentley Perth Internal entry for the requested semester + year
  let value: string | undefined;
  for (const avail of allItems) {
    const label = avail.Label ?? '';
    if (!label.includes('Bentley Perth')) continue;

    // Match labels like: "2026 Semester 1, [Internal] Bentley Perth Campus"
    const semMatch = label.match(/(\d{4})\s+Semester\s+(\d)/);
    if (!semMatch) continue;

    if (parseInt(semMatch[1]) === year && parseInt(semMatch[2]) === semester) {
      value = avail.Value;
      break;
    }
  }

  if (!value) {
    throw new Error(
      `No Bentley Perth offering found for Semester ${semester} ${year}. ` +
        `The semester may not be published yet.`,
    );
  }
  return { value, allItems };
}

// ── AS_TASK parser ────────────────────────────────────────────────────────────

/**
 * Parses the pipe-delimited AS_TASK field from the unit outline.
 *
 * Format (one row per line, semicolon-terminated):
 *   "1| Assignment| 40 percent| ULOs assessed 1|2|4;\n"
 *   "2| Practical Test| 20 percent| ULOs assessed 2|3;\n"
 *   "3| Final Examination| 40 percent| ULOs assessed 1|2|3|4|"
 *
 * Returns [{title, weight}, ...] for each assessment row.
 * Weight is absent when the field doesn't contain "N percent".
 */
export function parseAsTask(asTask: string): Array<{ title: string; weight?: number }> {
  if (!asTask) return [];

  // Split into individual assessment rows on ";\n" or trailing ";"
  const rows = asTask.split(/;\s*\n|;\s*$/).filter((r) => r.trim());
  const results: Array<{ title: string; weight?: number }> = [];

  for (const row of rows) {
    // Columns: [num, title, weight_description, ULO_refs...]
    const cols = row.split(/\|\s*/);
    if (cols.length < 2) continue;

    const title = cols[1]?.trim() ?? '';
    if (!title) continue;

    // Extract numeric weight from "40 percent" format
    const weightStr = cols[2] ?? '';
    const weightMatch = weightStr.match(/(\d+)\s*percent/i);
    const weight = weightMatch ? parseInt(weightMatch[1]) : undefined;

    results.push({ title, weight });
  }

  return results;
}

// ── PC_TEXT parser ────────────────────────────────────────────────────────────

/** Month name (lowercase) → 0-based JS month index. */
const MONTH_MAP: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Matches an exact time + ordinal date override in an assessment cell.
 * Example: "(23:59 3rd May)" → groups: ["23:59", "3rd May"]
 */
const EXACT_TIME_RE = /\((\d{1,2}:\d{2})\s+(\d+\w*\s+\w+)\)/;

/**
 * Matches a percentage weight annotation in an assessment cell.
 * Example: "(40%)" → group: "40"
 */
const WEIGHT_PCT_RE = /\((\d+)%\)/;

/**
 * Keywords that identify non-teaching weeks to skip when parsing PC_TEXT.
 * These rows have a begin date but no actual assessments.
 */
const NON_TEACHING_RE = /tuition\s+free|study\s+week|examination|mid[- ]semester\s+break/i;

/**
 * Parses the PC_TEXT HTML table from the unit outline into PendingDeadline items.
 *
 * Column detection is flexible to handle the variety of table layouts used by
 * different units:
 *  - "Begin Date" column: detected by header containing both "begin" and "date"
 *  - Assessment columns: any header containing "assessment", PLUS any header
 *    that is solely "workshop" (not mixed "Lecture/Workshop") — catches units
 *    like PRRE1003 that put weekly worksheets in a Workshop column
 *
 * If no Begin Date column or no assessment columns are found the function
 * returns an empty array; AS_TASK provides the TBA fallback for those units.
 *
 * For each teaching week with a non-empty assessment cell:
 *  - Uses the Begin Date as the default due date
 *  - Overrides with the exact date if an annotation like "(23:59 3rd May)" is present
 *  - Extracts the weight from "(N%)" annotations
 *  - Cleans up bracketed notes [like this] and weight/time annotations from the title
 */
export function parsePcText(
  pcText: string,
  unitCode: string,
  semester: 1 | 2,
  year: number,
): PendingDeadline[] {
  if (!pcText) return [];

  // Parse the raw HTML string into a live DOM so we can query it with standard APIs
  const doc = new DOMParser().parseFromString(pcText, 'text/html');
  const rows = Array.from(doc.querySelectorAll('tr'));
  if (rows.length === 0) return [];

  // Helper: get clean text from a DOM cell, converting non-breaking spaces
  // (\u00A0 from &nbsp;) to regular spaces so blank cells trim to empty string.
  const cellText = (el: Element | undefined): string =>
    (el?.textContent ?? '').replace(/\u00A0/g, ' ').trim();

  // ── Detect column indices from the header row ──────────────────────────────
  // beginDateCol: -1 means not found → we can't resolve dates → return nothing
  let beginDateCol = -1;

  // assessmentCols: all columns that may carry assessed items for a given week.
  // We read every one and emit a separate PendingDeadline per non-empty cell.
  const assessmentCols: number[] = [];

  const headerCells = Array.from(rows[0].querySelectorAll('th, td'));
  headerCells.forEach((cell, i) => {
    const text = cellText(cell).toLowerCase();
    if (text.includes('begin') && text.includes('date')) {
      beginDateCol = i;
    }
    if (text.includes('assessment')) {
      // e.g. "Assessment", "Assessment Due"
      assessmentCols.push(i);
    } else if (text.includes('workshop') && !text.includes('lecture') && !text.includes('tut')) {
      // e.g. "Workshop" but NOT "Lecture/Workshop" (which is a content column, not submissions)
      assessmentCols.push(i);
    }
  });

  // Without a Begin Date column we can't attach real dates — give up and let
  // AS_TASK supply TBA items instead (e.g. ELEN1000's "TW | Topic | Lab" layout)
  if (beginDateCol === -1 || assessmentCols.length === 0) return [];

  const results: PendingDeadline[] = [];

  // ── Process each data row (skip the header row at index 0) ─────────────────
  for (let r = 1; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll('td, th'));
    if (cells.length === 0) continue;

    // Get the Begin Date text (e.g. "9 February", "2 March")
    const beginDateText = cellText(cells[beginDateCol]);

    // Skip rows with no date or non-teaching keywords in the begin-date cell
    if (!beginDateText || NON_TEACHING_RE.test(beginDateText)) continue;

    // Pre-parse the Begin Date so it can be reused for each assessment column
    const dateParts = beginDateText.match(/^(\d{1,2})\s+(\w+)/);
    if (!dateParts) continue; // cell doesn't start with a date — skip row

    const day = parseInt(dateParts[1]);
    const monthIdx = MONTH_MAP[dateParts[2].toLowerCase()];
    if (monthIdx === undefined) continue;
    const baseDate = new Date(year, monthIdx, day);

    // ── Check every assessment-source column for this row ──────────────────
    for (const colIdx of assessmentCols) {
      const assessmentRaw = cellText(cells[colIdx]);

      // Skip empty cells or explicit "no assessment" dashes
      if (!assessmentRaw || assessmentRaw === '-') continue;

      // ── Extract time + date override, e.g. "(23:59 3rd May)" ─────────────
      const timeMatch = assessmentRaw.match(EXACT_TIME_RE);
      const exactTime = timeMatch ? timeMatch[1] : undefined;   // e.g. "23:59"
      const exactDateStr = timeMatch ? timeMatch[2] : undefined; // e.g. "3rd May"

      // ── Extract percentage weight, e.g. "(40%)" ───────────────────────────
      const pctMatch = assessmentRaw.match(WEIGHT_PCT_RE);
      const weight = pctMatch ? parseInt(pctMatch[1]) : undefined;

      // ── Clean up the assessment title ─────────────────────────────────────
      let title = assessmentRaw
        .replace(/\[[^\]]*\]/g, '')    // remove [Pracs 0-1] style notes
        .replace(EXACT_TIME_RE, '')    // remove (23:59 3rd May) time override
        .replace(/\(\d+%\)[^(]*/g, '') // remove (40%) and any text after it
        .trim()
        .replace(/[,;:]+$/, '')         // strip trailing punctuation
        .trim();

      if (!title) continue;

      // ── Resolve the due date ──────────────────────────────────────────────
      let resolvedDate: Date = baseDate;

      if (exactDateStr) {
        // Exact override like "3rd May" — parseOrdinalDate handles "Nth Month" format
        const parsed = parseOrdinalDate(exactDateStr, year);
        if (parsed) resolvedDate = parsed;
      }

      // Apply exact time to the resolved date so dueDate.toISOString() is correct
      if (exactTime) {
        resolvedDate = new Date(resolvedDate); // clone to avoid mutating baseDate
        const [hours, minutes] = exactTime.split(':').map(Number);
        resolvedDate.setHours(hours, minutes, 0, 0);
      }

      results.push({
        title,
        unit: unitCode,
        semester,
        year,
        exactTime,
        resolvedDate,
        isTBA: false, // always has a date (derived from Begin Date or exact override)
        weight,
        calSource: true,
      });
    }
  }

  return results;
}

// ── Week hint extraction ──────────────────────────────────────────────────────

/**
 * Scans ALL columns of the PC_TEXT table (not just assessmentCols) to build a
 * cell-content → teaching week number map.
 *
 * parsePcText only reads assessment-designated columns; when an assessment title
 * appears in a different column (e.g. "Lecture/Workshop" for MATH1019 mid-sem test)
 * or when parsePcText returns [] entirely (e.g. ELEN1000), this map lets
 * outlineToDeadlines attach a best-guess weekLabel to TBA fallback items so the
 * user at least knows which week to target.
 */
function buildWeekHints(pcText: string): Map<string, number> {
  const hints = new Map<string, number>();
  if (!pcText) return hints;

  const doc = new DOMParser().parseFromString(pcText, 'text/html');
  const rows = Array.from(doc.querySelectorAll('tr'));
  if (rows.length < 2) return hints;

  // Helper: normalise cell text (shared with parsePcText pattern)
  const cellText = (el: Element | undefined): string =>
    (el?.textContent ?? '').replace(/\u00A0/g, ' ').trim();

  // Detect key columns from the header row
  const headerCells = Array.from(rows[0].querySelectorAll('th, td'));
  let weekCol = -1;
  let beginDateCol = -1;
  headerCells.forEach((cell, i) => {
    const text = cellText(cell).toLowerCase();
    // "Week", "Teaching Week" contain "week"; "TW" is ELEN1000's abbreviation
    if (weekCol === -1 && (text.includes('week') || text.trim() === 'tw')) weekCol = i;
    if (text.includes('begin') && text.includes('date')) beginDateCol = i;
  });

  // No week column → can't determine teaching week numbers
  if (weekCol === -1) return hints;

  for (let r = 1; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll('td, th'));
    if (cells.length === 0) continue;

    const weekText = cellText(cells[weekCol]);
    if (!weekText) continue;

    // Skip non-teaching rows (tuition-free, study, exam period)
    if (NON_TEACHING_RE.test(weekText)) continue;

    // Extract the teaching week number — handles "Week 5", "Teaching Week 3", "5", "TW5"
    const weekMatch = weekText.match(/\d+/);
    if (!weekMatch) continue;
    const weekNum = parseInt(weekMatch[0]);
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 20) continue;

    // Scan every content cell in this row for assessment title text
    for (let c = 0; c < cells.length; c++) {
      if (c === weekCol || c === beginDateCol) continue;

      const raw = cellText(cells[c]);
      if (!raw || raw === '-' || raw === '–') continue;

      // Normalise: strip bracket notes, weight annotations, time overrides, trailing punctuation
      const normalized = raw
        .replace(/\[[^\]]*\]/g, '')             // [Pracs 0-1]
        .replace(/\(\d+%\)[^(]*/g, '')          // (40%) and any trailing text
        .replace(/\(\d{1,2}:\d{2}[^)]*\)/g, '') // (23:59 3rd May)
        .replace(/[,;:]+$/, '')
        .trim();

      // Skip very short strings or pure date strings ("9 February")
      if (normalized.length < 4 || /^\d{1,2}\s+\w+$/.test(normalized)) continue;

      // Store lowercased for case-insensitive titlesOverlap lookup
      hints.set(normalized.toLowerCase(), weekNum);
    }
  }

  return hints;
}

// ── Title fuzzy matching ──────────────────────────────────────────────────────

/**
 * Returns true if two assessment titles likely refer to the same assessment.
 * Uses three strategies in order:
 *
 * 1. First-word prefix — handles abbreviated forms:
 *      "Laboratory" / "Lab", "Practical" / "Prac", "Worksheets" / "Worksheet"
 * 2. Full-string normalised exact match — handles same word written differently:
 *      "eTest" ↔ "E-Test" (both normalise to "etest")
 * 3. Single-word lookup — handles word-order differences:
 *      "Quiz" ↔ "Workshop Quiz" (the single word "quiz" appears in the longer title)
 *      Requires 4+ chars to avoid noise from short common words.
 */
function titlesOverlap(a: string, b: string): boolean {
  // Extract words of 3+ chars from a title (strips punctuation, digits, short noise)
  const words = (s: string): string[] =>
    s.toLowerCase().replace(/[^a-z]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);

  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return false;

  // 1. First-word prefix match
  const [firstA] = wa;
  const [firstB] = wb;
  if (firstA.startsWith(firstB) || firstB.startsWith(firstA)) return true;

  // 2. Full-string normalised exact match: "eTest" → "etest", "E-Test" → "etest"
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  if (norm(a) === norm(b)) return true;

  // 3. Single-word lookup (4-char min to avoid short-word false positives):
  //    if the shorter title is a single significant word, check whether it
  //    appears anywhere in the longer title's word list.
  const shortWords = wa.length <= wb.length ? wa : wb;
  const longWords = wa.length <= wb.length ? wb : wa;
  if (shortWords.length === 1 && shortWords[0].length >= 4) {
    const key = shortWords[0];
    return longWords.some((w) => w.startsWith(key) || key.startsWith(w));
  }

  return false;
}

// ── Outline → PendingDeadline conversion ─────────────────────────────────────

/**
 * Converts a UobOutline API object into an array of PendingDeadline items.
 *
 * PC_TEXT (the program calendar HTML table) is the primary source: it provides
 * actual calendar dates per teaching week. AS_TASK (the pipe-delimited assessment
 * list) is the authoritative list of ALL assessments — anything not represented
 * in the calendar is appended as a TBA item.
 *
 * Weight propagation: if an AS_TASK item matches one or more PC_TEXT items that
 * lack a weight annotation in the calendar cell, the AS_TASK weight is copied
 * across so no assessment appears weightless in the UI.
 *
 * Diagnostic logging: open the side panel's DevTools console (right-click panel
 * → Inspect) to see exactly what was parsed for each unit.
 */
function outlineToDeadlines(
  outline: UobOutline,
  unitCode: string,
  semester: 1 | 2,
  year: number,
): PendingDeadline[] {
  const unitName = outline.Title;

  // Primary: parse the week-by-week program calendar for actual dates
  const pcItems = parsePcText(outline.PC_TEXT, unitCode, semester, year);

  // Attach the full unit name to all PC items
  for (const item of pcItems) {
    item.unitName = unitName;
  }

  // Secondary: parse the full assessment list — this is the source of truth for
  // WHAT assessments exist; PC_TEXT only provides dates
  const asItems = parseAsTask(outline.AS_TASK);

  // Log for diagnostics — open side panel DevTools (right-click → Inspect) to view
  console.group(`[outlineApi] ${unitCode} S${semester} ${year} — "${unitName}"`);
  console.log(
    'AS_TASK assessments:',
    asItems.map((i) => `${i.title}${i.weight !== undefined ? ` (${i.weight}%)` : ''}`),
  );
  console.log(
    'PC_TEXT calendar items:',
    pcItems.map(
      (i) =>
        `${i.title}${i.weight !== undefined ? ` (${i.weight}%)` : ''} — ${i.resolvedDate?.toLocaleDateString() ?? 'no date'}`,
    ),
  );

  // Build week hints from ALL PC_TEXT columns so TBA fallback items can get a
  // weekLabel even when the assessment doesn't appear in the assessment-designated columns.
  const weekHints = buildWeekHints(outline.PC_TEXT);

  const tbaAdded: string[] = [];

  for (const asItem of asItems) {
    // Find all PC_TEXT items that match this AS_TASK entry (may be multiple — e.g.
    // one AS_TASK "Practical Test" → many PC_TEXT "Prac Test 1", "Prac Test 2", …)
    const matched = pcItems.filter((pc) => titlesOverlap(pc.title, asItem.title));

    if (matched.length > 0) {
      // Propagate the AS_TASK weight to any matched calendar items that didn't
      // capture it from their cell annotation (e.g. cells without a "(40%)" tag)
      if (asItem.weight !== undefined) {
        for (const pc of matched) {
          if (pc.weight === undefined) pc.weight = asItem.weight;
        }
      }
      continue; // already covered by dated calendar items
    }

    // Not found in calendar — add as TBA (user fills in date from the card).
    // Try to infer a teaching week from the weekHints map (any PC_TEXT column).
    // A week-approximate date is better than nothing; the user can confirm/adjust.
    let hintWeekLabel: string | undefined;
    for (const [hintTitle, hintWeek] of weekHints) {
      if (titlesOverlap(hintTitle, asItem.title)) {
        hintWeekLabel = `Week ${hintWeek}`;
        break;
      }
    }

    tbaAdded.push(
      `${asItem.title}${asItem.weight !== undefined ? ` (${asItem.weight}%)` : ''}` +
      (hintWeekLabel ? ` [hint: ${hintWeekLabel}]` : ''),
    );
    pcItems.push({
      title: asItem.title,
      unit: unitCode,
      unitName,
      semester,
      year,
      isTBA: true,
      weight: asItem.weight,
      weekLabel: hintWeekLabel, // "Week N" if found in any column; undefined otherwise
    });
  }

  console.log('TBA items (not in calendar):', tbaAdded.length ? tbaAdded : 'none');
  console.log(`Total items returned: ${pcItems.length}`);
  console.groupEnd();

  return pcItems;
}

// ── Internal fetch helper ─────────────────────────────────────────────────────

/**
 * Internal helper that handles steps 1–6: unit lookup → module version →
 * availability → POST → extract UobOutline. Shared by fetchOutline and
 * fetchOutlineData so neither duplicates the expensive filter-list construction.
 *
 * Throws a user-friendly Error on any failure.
 */
async function fetchUobOutline(
  code: string,
  semester: 1 | 2,
  year: number,
): Promise<UobOutline> {
  // Step 1: look up the numeric UNIT_CD + UNIT_VERS for this unit code
  const lookup = await getUnitLookup();
  const unitEntry = lookup[code];
  if (!unitEntry) {
    throw new Error(
      `Unit "${code}" not found in the Curtin unit list. ` +
        `Check the code is correct (e.g. COMP1005) and try again.`,
    );
  }

  // Step 2: get a fresh module version token (must be up-to-date per deployment)
  const moduleVersion = await fetchModuleVersion();

  // Step 3: get the availability Value string AND the full avails list for this unit.
  // The unit CD is required so the server populates Avails_dd in the response.
  const { value: availValue, allItems: allAvailItems } = await getAvailabilityResult(
    semester,
    year,
    unitEntry.cd,
    unitEntry.vers,
  );

  // Step 4: build the request body.
  //
  // CRITICAL: ScreenDataSetGetNew only returns unit-specific data when
  // filterList_units contains a sufficiently large set of units (the full
  // list from ScreenDataSetGetFilterUnit). With a small or empty filter list
  // the server falls through to COMP1005 as a default.
  //
  // We reconstruct the full filter list from the compact unit lookup cache
  // (~6k items). filterList_avails must also contain all the unit's avail
  // entries; selectionList_* fields then narrow to the target offering.
  const unitValue = `${unitEntry.cd},${unitEntry.vers}`;
  const availId = parseInt(availValue.split(',')[0]);
  const availMode = availValue.split(',')[1] ?? 'INT';

  const allUnitsFilter = Object.values(lookup).map((u) => osListItem(`${u.cd},${u.vers}`));
  const allAvailsFilter = allAvailItems.map((a) => osListItem(a.Value));

  const body = buildMinimalBody(moduleVersion, API_VERSIONS.ScreenDataSetGetNew, {
    filterList_units: { List: allUnitsFilter },
    selectionList_units: { List: [osListItem(unitValue)] },
    filterList_avails: { List: allAvailsFilter },
    selectionList_avails: { List: [osListItem(availValue)] },
    SelectedUnitCD: unitEntry.cd,
    SelectedUnitVers: unitEntry.vers,
    SelectedAvailKeyNo: availId,
    SelectedAttcModeCD: availMode,
  });

  // Step 5: POST to ScreenDataSetGetNew
  const resp = (await osPost(
    'screenservices/UnitOutlineBuilder/Public/OutlineHub/ScreenDataSetGetNew',
    body,
  )) as {
    hasModuleVersionChanged?: boolean;
    hasApiVersionChanged?: boolean;
    data?: { List?: OsListWrapper<{ UobOutline?: UobOutline }> };
  };

  if (resp.hasModuleVersionChanged || resp.hasApiVersionChanged) {
    console.warn(
      '[outlineApi] API version mismatch detected in response; ' +
        'data should still be valid. Consider updating HARDCODED_API_VERSION.',
    );
  }

  // Step 6: extract the UobOutline from the nested response structure
  const outlineItem = resp?.data?.List?.List?.[0];
  if (!outlineItem?.UobOutline) {
    throw new Error(
      `No outline found for ${code} Semester ${semester} ${year}. ` +
        `The unit may not be offered in this semester at Bentley Perth.`,
    );
  }

  return outlineItem.UobOutline;
}

// ── Public exports ────────────────────────────────────────────────────────────

/**
 * Fetches the unit outline for the given unit code, semester, and year, and
 * returns an array of PendingDeadline objects ready for the confirmation UI.
 *
 * Throws a user-friendly Error for any failure (unit not found, API down, etc.).
 */
export async function fetchOutline(
  unitCode: string,
  semester: 1 | 2,
  year: number,
): Promise<PendingDeadline[]> {
  const code = unitCode.trim().toUpperCase();
  const outline = await fetchUobOutline(code, semester, year);
  return outlineToDeadlines(outline, code, semester, year);
}

/** Rich outline data returned by fetchOutlineData for the test panel. */
export interface OutlineData {
  /** Raw pipe-delimited AS_TASK string from the API (clean text, no null bytes). */
  asTask: string;
  /** Raw PC_TEXT HTML table string from the API. */
  pcText: string;
  /** AS_TASK parsed into {title, weight?} objects. */
  asTaskItems: Array<{ title: string; weight?: number }>;
  /** Final merged PendingDeadline array (same as what the confirmation UI receives). */
  parsed: PendingDeadline[];
}

/**
 * Like fetchOutline but also returns raw AS_TASK + PC_TEXT strings and the
 * parsed asTaskItems array. Used by the test panel to inspect API output.
 *
 * Throws a user-friendly Error for any failure.
 */
export async function fetchOutlineData(
  unitCode: string,
  semester: 1 | 2,
  year: number,
): Promise<OutlineData> {
  const code = unitCode.trim().toUpperCase();
  const outline = await fetchUobOutline(code, semester, year);
  return {
    asTask: outline.AS_TASK ?? '',
    pcText: outline.PC_TEXT ?? '',
    asTaskItems: parseAsTask(outline.AS_TASK ?? ''),
    parsed: outlineToDeadlines(outline, code, semester, year),
  };
}

/**
 * Returns every known Curtin unit code, sorted alphabetically.
 *
 * Triggers a unit lookup cache fetch on first call (or cache miss), then
 * returns instantly from the 30-day cache on subsequent calls.
 * Used by the test panel's Grab All feature to enumerate all available units.
 */
export async function getAllUnitCodes(): Promise<string[]> {
  const lookup = await getUnitLookup();
  return Object.keys(lookup).sort();
}
