/** Base URL for all OutSystems API calls. */
export const BASE = "https://curtin.outsystems.app/UnitOutlineBuilder";

/**
 * Per-endpoint API version tokens sourced from authenticated HAR capture.
 * Each endpoint has a distinct token and returns no `data` when mismatched.
 */
export const API_VERSIONS: Record<string, string> = {
  ScreenDataSetGetFilterUnit: "axSR8n8P8MsJ41MrNViNvg",
  DataActionGetAvailabilities: "igu7+gCJcnPAU_YQy5dB4g",
  ScreenDataSetGetNew: "aDiUvMK2z_RjPnvHmPq_Wg",
};

/** OutSystems wraps every list in {List: [...]}. */
export interface OsListWrapper<T> {
  List: T[];
}

/** One unit record from ScreenDataSetGetFilterUnit. */
export interface VwOsUnit {
  UNIT_CD: number;
  UNIT_VERS: number;
  FULL_TITLE: string;
  UNIT_CD_UDC: string;
}

/** One availability entry from DataActionGetAvailabilities. */
export interface AvailEntry {
  Value: string;
  Label: string;
}

/**
 * Sends a POST request to an OutSystems screenservices endpoint and returns
 * parsed JSON. Throws a user-friendly Error on HTTP failure.
 */
export async function osPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
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

/** In-memory cache for the module version token. */
let moduleVersionCache: { token: string; fetchedAt: number } | null = null;

/** Module version token is valid for 5 minutes. */
export const MODULE_VERSION_TTL_MS = 5 * 60 * 1000;

/** Fetches and caches the OutSystems moduleVersion token. */
export async function fetchModuleVersion(): Promise<string> {
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

/** Empty dropdown list item required by OutSystems for empty dd_ lists. */
export const EMPTY_DD_ITEM = {
  Value: "",
  Label: "",
  ImageUrlOrIconClass: "",
  GroupName: "",
  Description: "",
};

/** Empty item shape for ExtractedAvails (VW_OS_UNIT schema). */
export const EMPTY_AVAIL_ITEM = {
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

/** Anonymous-user clientVariables block required by OutSystems requests. */
export const ANON_CLIENT_VARS = {
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

/** Builds a minimal screenservices request body with required default shapes. */
export function buildMinimalBody(
  moduleVersion: string,
  apiVersion: string,
  variables: Record<string, unknown>,
): unknown {
  return {
    versionInfo: { moduleVersion, apiVersion },
    viewName: "Public.OutlineHub",
    screenData: {
      variables: {
        filterList_units: { List: [], EmptyListItem: EMPTY_DD_ITEM },
        selectionList_units: { List: [], EmptyListItem: EMPTY_DD_ITEM },
        filterList_avails: { List: [], EmptyListItem: EMPTY_DD_ITEM },
        selectionList_avails: { List: [], EmptyListItem: EMPTY_DD_ITEM },
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
        ...variables,
      },
    },
    inputParameters: {},
    clientVariables: ANON_CLIENT_VARS,
  };
}

/** Helper: build a standard OutSystems dropdown list item with blank labels. */
export function osListItem(value: string): Record<string, string> {
  return {
    Value: value,
    Label: "",
    ImageUrlOrIconClass: "",
    GroupName: "",
    Description: "",
  };
}
