import type { UobOutline } from "../domain/outline";
import {
  API_VERSIONS,
  type AvailEntry,
  buildMinimalBody,
  fetchModuleVersion,
  type OsListWrapper,
  osListItem,
  osPost,
  type VwOsUnit,
} from "./outlineHttp";

/** chrome.storage.local key for the unit code → {cd, vers} lookup cache. */
const UNIT_CACHE_KEY = "outlineApiUnitLookup";

/** How long to keep each cache before re-fetching (30 days). */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A single unit's numeric identifiers used in API requests. */
interface UnitEntry {
  cd: number;
  vers: number;
}

/** Persistent cache: unit code string → UnitEntry. */
interface UnitLookupCache {
  entries: Record<string, UnitEntry>;
  fetchedAt: number;
}

/**
 * Returns the cached unit code → {cd, vers} lookup map.
 * Refreshes from API when cache is missing, empty, or stale.
 */
export async function getUnitLookup(): Promise<Record<string, UnitEntry>> {
  const stored = await chrome.storage.local.get(UNIT_CACHE_KEY);
  const cached = stored[UNIT_CACHE_KEY] as UnitLookupCache | undefined;
  if (
    cached &&
    Object.keys(cached.entries).length > 0 &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS
  ) {
    return cached.entries;
  }

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

  const resp = rawResp as {
    data?: { List?: OsListWrapper<{ VW_OS_UNIT: VwOsUnit }> };
  };
  const listItems = resp?.data?.List?.List ?? [];

  const entries: Record<string, UnitEntry> = {};
  for (const item of listItems) {
    const u = item?.VW_OS_UNIT;
    if (!u?.UNIT_CD_UDC) continue;
    const code = u.UNIT_CD_UDC.trim().toUpperCase();
    if (!code || /^\d+$/.test(code)) continue;
    entries[code] = { cd: u.UNIT_CD, vers: u.UNIT_VERS };
  }

  const newCache: UnitLookupCache = { entries, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [UNIT_CACHE_KEY]: newCache });
  return entries;
}

/**
 * Fetches availability data for the given unit and semester/year.
 * Returns the selected availability value and full list for this unit.
 */
export async function getAvailabilityResult(
  semester: 1 | 2,
  year: number,
  unitCd: number,
  unitVers: number,
): Promise<{ value: string; allItems: AvailEntry[] }> {
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

  const allItems = resp?.data?.Avails_dd?.List ?? [];

  let value: string | undefined;
  for (const avail of allItems) {
    const label = avail.Label ?? "";
    if (!label.includes("Bentley Perth")) continue;

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

/**
 * Internal helper: unit lookup → module version → availability → ScreenDataSetGetNew.
 * Returns the UobOutline payload for the requested unit offering.
 */
export async function fetchUobOutline(
  code: string,
  semester: 1 | 2,
  year: number,
): Promise<UobOutline> {
  const lookup = await getUnitLookup();
  const unitEntry = lookup[code];
  if (!unitEntry) {
    throw new Error(
      `Unit "${code}" not found in the Curtin unit list. ` +
        `Check the code is correct (e.g. COMP1005) and try again.`,
    );
  }

  const moduleVersion = await fetchModuleVersion();
  const { value: availValue, allItems: allAvailItems } =
    await getAvailabilityResult(semester, year, unitEntry.cd, unitEntry.vers);

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

  const outlineItem = resp?.data?.List?.List?.[0];
  if (!outlineItem?.UobOutline) {
    throw new Error(
      `No outline found for ${code} Semester ${semester} ${year}. ` +
        `The unit may not be offered in this semester at Bentley Perth.`,
    );
  }

  return outlineItem.UobOutline;
}
