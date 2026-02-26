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

import type { PendingDeadline } from "../types";
import {
  type UobOutline,
  parseAsTask,
  outlineToDeadlines,
} from "../domain/outline";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Base URL for all OutSystems API calls. */
const BASE = "https://curtin.outsystems.app/UnitOutlineBuilder";

/**
 * Per-endpoint API version tokens sourced from authenticated HAR capture.
 * Each OutSystems screen action has its own distinct apiVersion baked into the
 * client JS bundle. Using the wrong token causes `hasApiVersionChanged: true`
 * in the response and the `data` key is withheld entirely.
 * These tokens change only when the server is redeployed.
 */
const API_VERSIONS: Record<string, string> = {
  ScreenDataSetGetFilterUnit: "axSR8n8P8MsJ41MrNViNvg",
  DataActionGetAvailabilities: "igu7+gCJcnPAU_YQy5dB4g",
  ScreenDataSetGetNew: "aDiUvMK2z_RjPnvHmPq_Wg",
};

/** chrome.storage.local key for the unit code → {cd, vers} lookup cache. */
const UNIT_CACHE_KEY = "outlineApiUnitLookup";

// (No avails cache key — avails are always fetched fresh per unit; see note above.)

/** How long to keep each cache before re-fetching (30 days). */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single unit's numeric identifiers used in API requests. */
interface UnitEntry {
  cd: number; // UNIT_CD — OutSystems primary key
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

// ── POST helper ───────────────────────────────────────────────────────────────

/**
 * Sends a POST request to an OutSystems screenservices endpoint and returns
 * the parsed JSON response. Throws a user-friendly Error on HTTP failure.
 */
async function osPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    // Set Referer to the OutSystems page URL so the server's CSRF/aggregate checks pass.
    // OutSystems only runs data aggregates when the request looks like it originates from
    // its own page. Without a matching Referer, the response contains only version metadata
    // and no `data` key. The fetch `referrer` option is the standard way to set Referer
    // programmatically (unlike the `Referer` header name, which is forbidden in fetch).
    referrer: `${BASE}/OutlineHub`,
    referrerPolicy: "unsafe-url",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `API request failed (HTTP ${res.status}). Please try again.`,
    );
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
  if (
    moduleVersionCache &&
    Date.now() - moduleVersionCache.fetchedAt < MODULE_VERSION_TTL_MS
  ) {
    return moduleVersionCache.token;
  }
  const res = await fetch(`${BASE}/moduleservices/moduleversioninfo`);
  if (!res.ok) {
    throw new Error(
      `Failed to reach Curtin API (HTTP ${res.status}). Check your connection.`,
    );
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
  Value: "",
  Label: "",
  ImageUrlOrIconClass: "",
  GroupName: "",
  Description: "",
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
  FULL_TITLE: "",
  ABBREV_TITLE: "",
  STAGE: "",
  AVAILABLE_YEAR: -2147483648,
  UNIT_LEVEL: "",
  CREDIT_VALUE: "-79228162514264337593543950335",
  RESULT_TYPE: "",
  COORDINATOR: "",
  ADMIN_DETAILS: "",
  OWNING_ORG_CD: "",
  FACULTY_CD: "",
  ACTIVE_FG: "",
  CREATED_DATE: "1900-01-01T00:00:00",
  CHANGED_DATE: "1900-01-01T00:00:00",
  EFFECTIVE_DATE: "1900-01-01T00:00:00",
  DEACTIVATION_DATE: "1900-01-01T00:00:00",
  STAGE_DESC: "",
  SPK_CAT_CD: "",
  UNIT_CD_UDC: "",
  FACULTY_ORG_CODE: "",
  FACULTY_ORG_NAME: "",
  FACULTY_ORG_SHORT_NAME: "",
  FACULTY_ORG_TYPE: "",
  FACULTY_TOP_ORG_CODE: "",
  FACULTY_TOP_ORG: "",
  FACULTY_DATA_YEAR: -2147483648,
  FACULTY_IS_CURRENT: "",
  FACULTY_CREATED_DATE: "1900-01-01T00:00:00",
  FACULTY_CHANGED_DATE: "1900-01-01T00:00:00",
  AREA_ORG_CODE: "",
  AREA_ORG_NAME: "",
  AREA_ORG_SHORT_NAME: "",
  AREA_ORG_TYPE: "",
  AREA_TOP_ORG_CODE: "",
  AREA_TOP_ORG: "",
  AREA_DATA_YEAR: -2147483648,
  AREA_IS_CURRENT: "",
  AREA_CREATED_DATE: "1900-01-01T00:00:00",
  AREA_CHANGED_DATE: "1900-01-01T00:00:00",
  AVAIL_KEY_NO: -2147483648,
  AVAIL_NO: -2147483648,
  AVAIL_DESCRIPTION: "",
  AVAIL_YEAR: -2147483648,
  AVAIL_STUDYPERIOD_CD: "",
  AVAIL_STUDY_PERIOD: "",
  AVAIL_TO_STU_FG: "",
  AVAIL_LOCATION_CD: "",
  AVAIL_LOCATION: "",
  AVAIL_CURR_NO_ENROLLED: -2147483648,
  AVAIL_START_DATE: "1900-01-01T00:00:00",
  AVAIL_END_DATE: "1900-01-01T00:00:00",
  AVAIL_ACTIVE_FG: "",
  AVAIL_CREATED_DATE: "1900-01-01T00:00:00",
  AVAIL_CHANGE_DATE: "1900-01-01T00:00:00",
  AVAIL_ATT_MODE_AVAIL_KEY_NO: -2147483648,
  ATTNDC_MODE_CD: "",
  ATTENDANCE_MODE: "",
  AVAIL_ATT_CREATED_DATE: "1900-01-01T00:00:00",
  AVAIL_ATT_CHANGED_DATE: "1900-01-01T00:00:00",
  HR_EMPLOYEE: "",
  SURNAME: "",
  TITLE: "",
  FIRST_NAME: "",
  PREFERRED_NAME: "",
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
  UserPhotoURL: "",
  IsUserStandard: false,
  LastURL: "",
  UserName: "",
  IsAllowedFlag: false,
  IsUserSchool: false,
  IsUserLibrary: false,
  CurtinID: "",
  IsUserFaculty: false,
  User_OS_id: "",
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
    viewName: "Public.OutlineHub",
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
        SelectedAttcModeCD: "",
        ResultFile: { FileName: "", File: null, Link: "" },
        legacyFilename: "",
        IsLegacy: false,
        IsDirectDownload: false,
        IsDirectDwFailed: false,
        IsDirectDwFetching: false,
        // ExtractedAvails uses the full VW_OS_UNIT schema in EmptyListItem
        ExtractedAvails: { List: [], EmptyListItem: EMPTY_AVAIL_ITEM },
        IsSearchingAvails: false,
        GUID: "",
        _gUIDInDataFetchStatus: 1,
        unitcd: 0,
        _unitcdInDataFetchStatus: 1,
        availcd: 0,
        _availcdInDataFetchStatus: 1,
        GetSettings: {
          CutDate: "2024-09-27",
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
  return {
    Value: value,
    Label: "",
    ImageUrlOrIconClass: "",
    GroupName: "",
    Description: "",
  };
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
  if (
    cached &&
    Object.keys(cached.entries).length > 0 &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS
  ) {
    return cached.entries;
  }

  // Cache is missing, empty, or stale — fetch fresh unit list
  const moduleVersion = await fetchModuleVersion();
  const body = buildMinimalBody(
    moduleVersion,
    API_VERSIONS.ScreenDataSetGetFilterUnit,
    {},
  );
  const rawResp = await osPost(
    "screenservices/UnitOutlineBuilder/Public/OutlineHub/ScreenDataSetGetFilterUnit",
    body,
  );

  // Each list element wraps a single VW_OS_UNIT object:
  // resp.data.List.List[n] = { VW_OS_UNIT: { UNIT_CD, UNIT_VERS, UNIT_CD_UDC, ... } }
  const resp = rawResp as {
    data?: { List?: OsListWrapper<{ VW_OS_UNIT: VwOsUnit }> };
  };
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
  const body = buildMinimalBody(
    moduleVersion,
    API_VERSIONS.DataActionGetAvailabilities,
    {
      IsSearchingAvails: true,
      SelectedUnitCD: unitCd,
      SelectedUnitVers: unitVers,
    },
  );
  const resp = (await osPost(
    "screenservices/UnitOutlineBuilder/Public/OutlineHub/DataActionGetAvailabilities",
    body,
  )) as { data?: { Avails_dd?: OsListWrapper<AvailEntry> } };

  // All availability entries for this unit (all campuses + semesters)
  const allItems = resp?.data?.Avails_dd?.List ?? [];

  // Find the Bentley Perth Internal entry for the requested semester + year
  let value: string | undefined;
  for (const avail of allItems) {
    const label = avail.Label ?? "";
    if (!label.includes("Bentley Perth")) continue;

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
  const { value: availValue, allItems: allAvailItems } =
    await getAvailabilityResult(semester, year, unitEntry.cd, unitEntry.vers);

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
  const availId = parseInt(availValue.split(",")[0]);
  const availMode = availValue.split(",")[1] ?? "INT";

  const allUnitsFilter = Object.values(lookup).map((u) =>
    osListItem(`${u.cd},${u.vers}`),
  );
  const allAvailsFilter = allAvailItems.map((a) => osListItem(a.Value));

  const body = buildMinimalBody(
    moduleVersion,
    API_VERSIONS.ScreenDataSetGetNew,
    {
      filterList_units: { List: allUnitsFilter },
      selectionList_units: { List: [osListItem(unitValue)] },
      filterList_avails: { List: allAvailsFilter },
      selectionList_avails: { List: [osListItem(availValue)] },
      SelectedUnitCD: unitEntry.cd,
      SelectedUnitVers: unitEntry.vers,
      SelectedAvailKeyNo: availId,
      SelectedAttcModeCD: availMode,
    },
  );

  // Step 5: POST to ScreenDataSetGetNew
  const resp = (await osPost(
    "screenservices/UnitOutlineBuilder/Public/OutlineHub/ScreenDataSetGetNew",
    body,
  )) as {
    hasModuleVersionChanged?: boolean;
    hasApiVersionChanged?: boolean;
    data?: { List?: OsListWrapper<{ UobOutline?: UobOutline }> };
  };

  if (resp.hasModuleVersionChanged || resp.hasApiVersionChanged) {
    console.warn(
      "[outlineApi] API version mismatch detected in response; " +
        "data should still be valid. Consider updating HARDCODED_API_VERSION.",
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
  /** AS_TASK parsed into {title, weight?, outcomes?} objects. */
  asTaskItems: Array<{ title: string; weight?: number; outcomes?: string }>;
  /** Final merged PendingDeadline array (same as what the confirmation UI receives). */
  parsed: PendingDeadline[];
  /**
   * All fields returned by the API for this outline — includes AS_TASK and PC_TEXT
   * plus any additional fields (e.g. extra schedule tables) that the UI exposes
   * but are not yet extracted by the parser. Used by the test panel for discovery.
   */
  rawOutline: Record<string, unknown>;
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
    asTask: outline.AS_TASK ?? "",
    pcText: outline.PC_TEXT ?? "",
    asTaskItems: parseAsTask(outline.AS_TASK ?? ""),
    parsed: outlineToDeadlines(outline, code, semester, year),
    rawOutline: outline as unknown as Record<string, unknown>,
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
