// ── Date helpers ──────────────────────────────────────────────────────────────
// Copied and extended from curtincalendar/src/utils/format/getDates.ts.
// Added: weekToDate() for converting a semester week number to a calendar Date.

/** Returns the nth Monday on or after the given date. */
function getnthMonday(date: Date, n: number): Date {
  const newDate = new Date(date);
  // Advance to the nearest Monday
  while (newDate.getDay() !== 1) {
    newDate.setDate(newDate.getDate() + 1);
  }
  // Jump forward by (n - 1) additional weeks
  newDate.setDate(newDate.getDate() + 7 * (n - 1));
  return newDate;
}

/** Returns a new date n weeks after the given date. */
function addnWeeks(date: Date, n: number): Date {
  const newDate = new Date(date);
  newDate.setDate(newDate.getDate() + 7 * n);
  return newDate;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type SemesterEntry = {
  start: { month: number; day: number };
  end: { month: number; day: number };
  /** Total calendar weeks in the semester (teaching + any mid-semester breaks) */
  weeks: number;
};

type SemesterDates = {
  1: SemesterEntry;
  2: SemesterEntry;
  currentYear: number;
};

// ── Known year overrides ──────────────────────────────────────────────────────

/**
 * Exact semester start/end dates confirmed against the official Curtin academic
 * calendar PDF (Academic-Calendar-2025-2028-17062025.pdf, approved 27 June 2025).
 * These override formula-based dates for the listed years.
 */
const knownYearOverrides: { [year: number]: SemesterDates } = {
  2026: {
    1: { start: { month: 2, day: 16 }, end: { month: 5, day: 22 }, weeks: 14 },
    2: { start: { month: 7, day: 20 }, end: { month: 10, day: 23 }, weeks: 14 },
    currentYear: 2026,
  },
  2027: {
    1: { start: { month: 2, day: 15 }, end: { month: 5, day: 21 }, weeks: 14 },
    2: { start: { month: 7, day: 19 }, end: { month: 10, day: 22 }, weeks: 14 },
    currentYear: 2027,
  },
  2028: {
    1: { start: { month: 2, day: 14 }, end: { month: 5, day: 19 }, weeks: 14 },
    2: { start: { month: 7, day: 17 }, end: { month: 10, day: 20 }, weeks: 14 },
    currentYear: 2028,
  },
};

// ── Formula-based fallbacks ───────────────────────────────────────────────────

/**
 * Pre-2026 pattern: S1 starts on the 4th Monday of February; 13 teaching weeks;
 * 8-week mid-year break; S2 follows.
 */
function calculateDatesPre2026(year: number): SemesterDates {
  const february = new Date(`February 1, ${year}`);
  const startSem1 = getnthMonday(february, 4);
  const endSem1 = addnWeeks(startSem1, 13);
  const startSem2 = addnWeeks(endSem1, 8);
  const endSem2 = addnWeeks(startSem2, 13);

  // Subtract one day from each Monday to get the last Sunday of the semester
  const lastDaySem1 = new Date(endSem1);
  lastDaySem1.setDate(lastDaySem1.getDate() - 1);
  const lastDaySem2 = new Date(endSem2);
  lastDaySem2.setDate(lastDaySem2.getDate() - 1);

  return {
    1: {
      start: { month: 2, day: startSem1.getDate() },
      end: { month: lastDaySem1.getMonth() + 1, day: lastDaySem1.getDate() },
      weeks: 13,
    },
    2: {
      start: { month: 7, day: startSem2.getDate() },
      end: { month: lastDaySem2.getMonth() + 1, day: lastDaySem2.getDate() },
      weeks: 13,
    },
    currentYear: year,
  };
}

/**
 * 2026+ pattern: S1 starts on the first Monday on or after Feb 14;
 * S2 starts on the 3rd Monday of July; 14 weeks each.
 */
function calculateDates2026Plus(year: number): SemesterDates {
  const startSem1 = getnthMonday(new Date(year, 1, 14), 1);
  const endSem1 = addnWeeks(startSem1, 14);
  const startSem2 = getnthMonday(new Date(year, 6, 1), 3);
  const endSem2 = addnWeeks(startSem2, 14);

  const lastDaySem1 = new Date(endSem1);
  lastDaySem1.setDate(lastDaySem1.getDate() - 1);
  const lastDaySem2 = new Date(endSem2);
  lastDaySem2.setDate(lastDaySem2.getDate() - 1);

  return {
    1: {
      start: { month: 2, day: startSem1.getDate() },
      end: { month: lastDaySem1.getMonth() + 1, day: lastDaySem1.getDate() },
      weeks: 14,
    },
    2: {
      start: { month: 7, day: startSem2.getDate() },
      end: { month: lastDaySem2.getMonth() + 1, day: lastDaySem2.getDate() },
      weeks: 14,
    },
    currentYear: year,
  };
}

function calculateDates(year: number): SemesterDates {
  return year >= 2026
    ? calculateDates2026Plus(year)
    : calculateDatesPre2026(year);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns semester start/end data for the given year.
 * Uses verified override table where available, falls back to formula.
 */
export function getDates(year: number): SemesterDates {
  return knownYearOverrides[year] ?? calculateDates(year);
}

/**
 * Returns the total number of navigable weeks for a semester in a given year.
 */
export function getSemesterWeeks(year: number, semester: 1 | 2): number {
  return getDates(year)[semester].weeks;
}

/**
 * Converts a semester week number to a calendar Date.
 *
 * @param semester  1 or 2
 * @param year      Academic year, e.g. 2026
 * @param week      Week number (1-based)
 * @param dayOffset Day within the week: 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat
 * @returns         Date object for the start of that week (Monday by default)
 *
 * Example: weekToDate(1, 2026, 5) → Mon 16 Mar 2026
 */
export function weekToDate(
  semester: 1 | 2,
  year: number,
  week: number,
  dayOffset = 0,
): Date {
  const semData = getDates(year)[semester];
  // Build semester start date from the {month, day} stored in overrides/formula
  const semStart = new Date(year, semData.start.month - 1, semData.start.day);
  // Advance by (week - 1) full weeks plus the intra-week day offset
  semStart.setDate(semStart.getDate() + (week - 1) * 7 + dayOffset);
  return semStart;
}

/** Month abbreviations for parsing date strings like "3rd May 23:59". */
export const MONTH_NAMES: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

/**
 * Parses a date string into a Date for the given year.
 *
 * Handles two input forms:
 *
 * 1. Normal ordinal dates: "3rd May", "12th April", "21st June"
 *    — straightforward digit + optional suffix + month name.
 *
 * 2. Null-byte-placeholder dates: some Curtin PDFs encode digit glyphs as
 *    \u0000 (null bytes), which we replace with '#' during text extraction.
 *    For the ordinal suffixes "st", "nd", "rd" the day number is deterministic:
 *
 *      "#st Month"  → 1st   (only single-digit number ending in "st")
 *      "#nd Month"  → 2nd
 *      "#rd Month"  → 3rd
 *      "##nd Month" → 22nd  (only two-digit number ending in "nd")
 *      "##rd Month" → 23rd
 *
 *    "##st" is ambiguous (21st or 31st) and "##th" / "#th" are ambiguous,
 *    so those remain unresolved and the function returns null.
 *
 * Returns null when the date cannot be determined with confidence.
 */
export function parseOrdinalDate(dayStr: string, year: number): Date | null {
  const s = dayStr.trim();

  // ── 1. Standard ordinal date ────────────────────────────────────────────────
  // Matches: "3rd May", "12 April", "21st June", "3rd May 23:59"
  const standard = s.match(/(\d{1,2})\s*(st|nd|rd|th)?\s+([A-Za-z]+)/i);
  if (standard) {
    const day = parseInt(standard[1], 10);
    const monthIdx = MONTH_NAMES[standard[3].slice(0, 3).toLowerCase()];
    if (monthIdx !== undefined && day >= 1 && day <= 31) {
      return new Date(year, monthIdx, day);
    }
  }

  // ── 2. Space-separated double-hash placeholder ("# #rd May") ────────────────
  // Checked BEFORE the consecutive-hash pattern below — the consecutive-hash
  // regex would otherwise grab the second '#' alone (e.g. matching '#nd May'
  // inside '# #nd May'), producing the wrong single-digit result.
  // Some Curtin PDFs emit two-digit null-byte days with a space between the two
  // placeholder chars (e.g. "# #rd May" instead of "##rd May").
  // Only "nd" (→ 22nd) and "rd" (→ 23rd) are unambiguous for two-digit cases.
  const spacedPlaceholder = s.match(/#\s+#\s*(st|nd|rd)\s+([A-Za-z]+)/i);
  if (spacedPlaceholder) {
    const suffix = spacedPlaceholder[1].toLowerCase();
    const monthIdx =
      MONTH_NAMES[spacedPlaceholder[2].slice(0, 3).toLowerCase()];
    if (monthIdx !== undefined) {
      if (suffix === "nd") return new Date(year, monthIdx, 22);
      if (suffix === "rd") return new Date(year, monthIdx, 23);
      // "st" → 21 or 31: ambiguous — return null immediately so the
      // consecutive-hash pattern below cannot grab the second '#' alone.
      return null;
    }
  }

  // ── 3. Null-byte-placeholder ordinal date (consecutive hashes) ──────────────
  // Matches: "#rd May", "##nd June", etc. — '#' chars are null-byte placeholders
  const placeholder = s.match(/(#+)\s*(st|nd|rd)\s+([A-Za-z]+)/i);
  if (placeholder) {
    const count = placeholder[1].length;
    const suffix = placeholder[2].toLowerCase();
    const monthIdx = MONTH_NAMES[placeholder[3].slice(0, 3).toLowerCase()];
    if (monthIdx !== undefined) {
      let day: number | null = null;
      if (count === 1) {
        if (suffix === "st") day = 1;
        else if (suffix === "nd") day = 2;
        else if (suffix === "rd") day = 3;
      } else if (count === 2) {
        // Two-digit numbers: only "nd" and "rd" are unambiguous
        if (suffix === "nd") day = 22;
        else if (suffix === "rd") day = 23;
        // "st" → 21 or 31: ambiguous, skip
      }
      if (day !== null) return new Date(year, monthIdx, day);
    }
  }

  return null;
}
