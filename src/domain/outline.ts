// ── Unit outline domain logic ─────────────────────────────────────────────────
// Pure parsing and conversion functions for Curtin unit outline data.
// No Chrome APIs, no network calls, no DOM access beyond DOMParser for HTML tables.

import type { PendingDeadline } from "../types";
import { parseOrdinalDate, weekToDate } from "../utils/getDates";

// ── Shared outline shape ───────────────────────────────────────────────────────

/** Key fields from UobOutline in the ScreenDataSetGetNew response. */
export interface UobOutline {
  UnitNumber: string; // e.g. "COMP1005"
  Title: string; // e.g. "Fundamentals of Programming"
  Avail_Study_Period: string; // e.g. "Semester 1"
  Avail_Year: string; // e.g. "2026"
  AS_TASK: string; // pipe-delimited assessment list
  PC_TEXT: string; // HTML table with week-by-week calendar
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
 * Returns [{title, weight?, outcomes?}, ...] for each assessment row.
 * Weight and outcomes are absent when the relevant columns are missing.
 * Note: late/extension flags are not present in the API response — PDF-only.
 */
export function parseAsTask(
  asTask: string,
): Array<{ title: string; weight?: number; outcomes?: string }> {
  if (!asTask) return [];

  // Split into individual assessment rows on ";\n" or trailing ";"
  const rows = asTask.split(/;\s*\n|;\s*$/).filter((r) => r.trim());
  const results: Array<{ title: string; weight?: number; outcomes?: string }> =
    [];

  for (const row of rows) {
    // Columns: [num, title, weight_description, ULO_refs...]
    const cols = row.split(/\|\s*/);
    if (cols.length < 2) continue;

    const title = cols[1]?.trim() ?? "";
    if (!title) continue;

    // Extract numeric weight from "40 percent" format
    const weightStr = cols[2] ?? "";
    const weightMatch = weightStr.match(/(\d+)\s*percent/i);
    const weight = weightMatch ? parseInt(weightMatch[1]) : undefined;

    // Extract ULO numbers from cols[3..n].
    // cols[3] = "ULOs assessed 1" (first number embedded in text),
    // subsequent cols = bare numbers ("2", "4", …) or empty strings.
    const uloNums: string[] = [];
    for (const col of cols.slice(3)) {
      const raw = col
        .trim()
        .replace(/^ULOs?\s+assessed\s*/i, "")
        .replace(/[;|]+$/, "")
        .trim();
      if (/^\d+$/.test(raw)) uloNums.push(raw);
    }
    const outcomes = uloNums.length > 0 ? uloNums.join(",") : undefined;

    results.push({ title, weight, outcomes });
  }

  return results;
}

// ── PC_TEXT parser ────────────────────────────────────────────────────────────

/** Month name (lowercase, full or 3-letter abbreviation) → 0-based JS month index. */
const MONTH_MAP: Record<string, number> = {
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
const NON_TEACHING_RE =
  /tuition\s+free|study\s+week|examination|mid[- ]semester\s+break/i;

/**
 * Parses the PC_TEXT HTML table from the unit outline into PendingDeadline items.
 *
 * Column detection is flexible to handle the variety of table layouts used by
 * different units:
 *  - "Begin Date" column: detected by header containing both "begin" and "date"
 *  - Assessment columns: any header containing "assessment", a standalone
 *    "workshop" (not "Lecture/Workshop"), "lab" (not "lecture"), or "quiz"
 *
 * TW-embedded date format (e.g. ELEN1000):
 *  Some units have no "Begin Date" column; instead the TW cell contains both
 *  the week number and the begin date ("1\n16 Feb"). When this is detected,
 *  parsePcText reads dates from TW cells and skips continuation (sub) rows
 *  that have fewer cells due to the variable-width row structure.
 *  Lab/Quiz items extracted this way are prefixed with their column header
 *  ("Lab", "Quiz") so titlesOverlap can link them to AS_TASK entries.
 *
 * If no date source and no assessment columns are found the function
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
  const doc = new DOMParser().parseFromString(pcText, "text/html");
  const rows = Array.from(doc.querySelectorAll("tr"));
  if (rows.length === 0) return [];

  // Helper: get clean text from a DOM cell, converting non-breaking spaces
  // (\u00A0 from &nbsp;) to regular spaces so blank cells trim to empty string.
  const cellText = (el: Element | undefined): string =>
    (el?.textContent ?? "").replace(/\u00A0/g, " ").trim();

  // ── Detect column indices from the header row ──────────────────────────────
  let beginDateCol = -1;
  let weekCol = -1;
  const assessmentCols: number[] = [];

  const headerCells = Array.from(rows[0].querySelectorAll("th, td"));
  const headerCount = headerCells.length;
  headerCells.forEach((cell, i) => {
    const text = cellText(cell).toLowerCase();
    if (text.includes("begin") && text.includes("date")) beginDateCol = i;
    if (weekCol === -1 && (text.includes("week") || text.trim() === "tw"))
      weekCol = i;
    if (text.includes("assessment")) {
      assessmentCols.push(i); // "Assessment", "Assessment Due"
    } else if (
      text.includes("workshop") &&
      !text.includes("lecture") &&
      !text.includes("tut")
    ) {
      assessmentCols.push(i); // "Workshop" but not "Lecture/Workshop"
    } else if (text.includes("lab") && !text.includes("lecture")) {
      assessmentCols.push(i); // "Lab" column → lab session / report submissions
    } else if (text.includes("quiz")) {
      assessmentCols.push(i); // "Tut. and Quiz", "Quiz" → online tests / quizzes
    }
  });

  // ── Detect TW-embedded date format ────────────────────────────────────────
  // Some units (e.g. ELEN1000) have no "Begin Date" column — instead the TW
  // cell contains both the week number and the begin date ("1\n16 Feb").
  // Detect this by checking whether the first data row's TW cell matches that
  // pattern; if so, we read dates from TW cells instead of a dedicated column.
  let useTwEmbeddedDate = false;
  if (beginDateCol === -1 && weekCol >= 0 && rows.length > 1) {
    const firstCells = Array.from(rows[1].querySelectorAll("td, th"));
    const twText =
      weekCol < firstCells.length ? cellText(firstCells[weekCol]) : "";
    useTwEmbeddedDate = /\d+\s+\d{1,2}\s+[A-Za-z]+/.test(twText);
  }

  if (
    (beginDateCol === -1 && !useTwEmbeddedDate) ||
    assessmentCols.length === 0
  )
    return [];

  // For TW-embedded tables, build a column-header prefix map so extracted item
  // titles carry enough context for titlesOverlap to link them to AS_TASK entries.
  // "Lab 1 DC concepts" → prefix "lab" → prefix-matches "laboratory" in "Laboratory Report"
  // "Quiz 2 DC analysis" → prefix "quiz" → synonym-matches "test" in "Online tests"
  const colHeaderPrefix = new Map<number, string>();
  if (useTwEmbeddedDate) {
    headerCells.forEach((cell, i) => {
      if (!assessmentCols.includes(i)) return;
      const text = cellText(cell).toLowerCase();
      if (text.includes("lab")) colHeaderPrefix.set(i, "Lab");
      else if (text.includes("quiz") || text.includes("tut"))
        colHeaderPrefix.set(i, "Quiz");
      else colHeaderPrefix.set(i, cellText(cell).trim().split(/\s+/)[0]);
    });
  }

  const results: PendingDeadline[] = [];

  // In TW-embedded mode, teaching-week date is carried across the sub-rows
  // that belong to the same week (they have no TW cell of their own).
  let twCurrentDate: Date | undefined;
  let twCurrentWeekNum: number | undefined;

  // ── Process each data row (skip the header row at index 0) ─────────────────
  for (let r = 1; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll("td, th"));
    if (cells.length === 0) continue;

    // ── TW-embedded mode: identify and skip continuation (sub) rows ──────────
    // Each teaching week starts with a "header row" whose TW cell begins with a
    // digit (e.g. "1\n16 Feb"). Continuation rows carry the same week's extra
    // topic lines — their first cell shifts left, causing column misalignment.
    if (useTwEmbeddedDate) {
      const twRaw = weekCol < cells.length ? cellText(cells[weekCol]) : "";
      if (!twRaw || !/^\d/.test(twRaw)) continue; // sub-row → skip

      // Update current week date from the TW cell
      const twDateMatch = twRaw.match(/\d+\s+(\d{1,2})\s+([A-Za-z]+)/);
      if (twDateMatch) {
        const d = parseInt(twDateMatch[1]);
        const mIdx = MONTH_MAP[twDateMatch[2].toLowerCase()];
        if (mIdx !== undefined) twCurrentDate = new Date(year, mIdx, d);
      }
      const wm = twRaw.match(/\d+/);
      twCurrentWeekNum = wm ? parseInt(wm[0]) : undefined;

      // Skip non-teaching weeks (tuition-free, study break, etc.)
      if (NON_TEACHING_RE.test(twRaw)) continue;
    }

    // ── Resolve base date and week label for this row ─────────────────────────
    let baseDate: Date;
    let rowWeekLabel: string | undefined;

    if (useTwEmbeddedDate) {
      if (!twCurrentDate) continue;
      baseDate = twCurrentDate;
      rowWeekLabel =
        twCurrentWeekNum !== undefined ? `Week ${twCurrentWeekNum}` : undefined;
    } else {
      // Standard layout: dedicated Begin Date column
      const beginDateText = cellText(cells[beginDateCol]);
      if (!beginDateText || NON_TEACHING_RE.test(beginDateText)) continue;
      const dateParts = beginDateText.match(/^(\d{1,2})\s+(\w+)/);
      if (!dateParts) continue;
      const day = parseInt(dateParts[1]);
      const monthIdx = MONTH_MAP[dateParts[2].toLowerCase()];
      if (monthIdx === undefined) continue;
      baseDate = new Date(year, monthIdx, day);

      // Week label from dedicated week column (if present)
      const weekRaw = weekCol >= 0 ? cellText(cells[weekCol]) : "";
      const weekMatch = weekRaw.match(/\d+/);
      const weekNum =
        weekMatch && !isNaN(parseInt(weekMatch[0]))
          ? parseInt(weekMatch[0])
          : undefined;
      rowWeekLabel = weekNum !== undefined ? `Week ${weekNum}` : undefined;
    }

    // ── Check every assessment-source column for this row ──────────────────
    for (const colIdx of assessmentCols) {
      // Alignment guard: for TW-embedded tables with variable-width rows,
      // columns at index ≥ 3 are unreliable unless the row has a full cell
      // complement (matching the header count).
      if (useTwEmbeddedDate && colIdx >= 3 && cells.length < headerCount)
        continue;
      if (cells.length <= colIdx) continue;

      const assessmentRaw = cellText(cells[colIdx]);
      if (!assessmentRaw || assessmentRaw === "-") continue;

      const timeMatch = assessmentRaw.match(EXACT_TIME_RE);
      const exactTime = timeMatch ? timeMatch[1] : undefined;
      const exactDateStr = timeMatch ? timeMatch[2] : undefined;

      const pctMatch = assessmentRaw.match(WEIGHT_PCT_RE);
      const weight = pctMatch ? parseInt(pctMatch[1]) : undefined;

      // Build title — for TW-embedded tables, prefix with the column-header
      // keyword so titlesOverlap can match cell content to AS_TASK entries.
      const rawTitle = assessmentRaw
        .replace(/\[[^\]]*\]/g, "")
        .replace(EXACT_TIME_RE, "")
        .replace(/\(\d+%\)[^(]*/g, "")
        .trim()
        .replace(/[,;:]+$/, "")
        .trim();
      if (!rawTitle) continue;

      const prefix = colHeaderPrefix.get(colIdx);
      const title = prefix ? `${prefix} ${rawTitle}` : rawTitle;

      // ── Resolve the due date ────────────────────────────────────────────
      let resolvedDate: Date = baseDate;
      if (exactDateStr) {
        const parsed = parseOrdinalDate(exactDateStr, year);
        if (parsed) resolvedDate = parsed;
      }
      if (exactTime) {
        resolvedDate = new Date(resolvedDate);
        const [hours, minutes] = exactTime.split(":").map(Number);
        resolvedDate.setHours(hours, minutes, 0, 0);
      }

      results.push({
        title,
        unit: unitCode,
        semester,
        year,
        exactTime,
        resolvedDate,
        isTBA: false,
        weight,
        weekLabel: rowWeekLabel,
        calSource: true,
      });
    }
  }

  return results;
}

// ── Week hint extraction ──────────────────────────────────────────────────────

/**
 * Scans ALL columns of the PC_TEXT table (not just assessmentCols) to build:
 *  - hints: cell-content → teaching week number (for title matching)
 *  - weekDates: teaching week number → actual begin Date extracted from the TW cell
 *
 * parsePcText only reads assessment-designated columns; when an assessment title
 * appears in a different column (e.g. "Lecture/Workshop" for MATH1019 mid-sem test)
 * or when parsePcText returns [] entirely (e.g. ELEN1000), this map lets
 * outlineToDeadlines attach a best-guess weekLabel and resolvedDate to TBA fallback
 * items.
 *
 * TW cells may embed the begin date alongside the week number, e.g. "1\n16 Feb".
 * When found, that date is stored in weekDates so callers can use the actual
 * table date rather than the weekToDate() approximation.
 */
function buildWeekHints(
  pcText: string,
  year: number,
): { hints: Map<string, number>; weekDates: Map<number, Date> } {
  const hints = new Map<string, number>();
  const weekDates = new Map<number, Date>();
  if (!pcText) return { hints, weekDates };

  const doc = new DOMParser().parseFromString(pcText, "text/html");
  const rows = Array.from(doc.querySelectorAll("tr"));
  if (rows.length < 2) return { hints, weekDates };

  // Helper: normalise cell text (shared with parsePcText pattern)
  const cellText = (el: Element | undefined): string =>
    (el?.textContent ?? "").replace(/\u00A0/g, " ").trim();

  // Detect key columns from the header row
  const headerCells = Array.from(rows[0].querySelectorAll("th, td"));
  let weekCol = -1;
  let beginDateCol = -1;
  headerCells.forEach((cell, i) => {
    const text = cellText(cell).toLowerCase();
    // "Week", "Teaching Week" contain "week"; "TW" is ELEN1000's abbreviation
    if (weekCol === -1 && (text.includes("week") || text.trim() === "tw"))
      weekCol = i;
    if (text.includes("begin") && text.includes("date")) beginDateCol = i;
  });

  // No week column → can't determine teaching week numbers
  if (weekCol === -1) return { hints, weekDates };

  for (let r = 1; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll("td, th"));
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

    // Extract embedded begin date when the TW cell contains both week and date,
    // e.g. "1\n16 Feb" or "2 23 Feb". The date digits follow the first number.
    if (!weekDates.has(weekNum)) {
      // Match: first number (weekNum) + whitespace + day + whitespace + month
      const twDateMatch = weekText.match(/\d+\s+(\d{1,2})\s+([A-Za-z]+)/);
      if (twDateMatch) {
        const day = parseInt(twDateMatch[1]);
        const monthIdx = MONTH_MAP[twDateMatch[2].toLowerCase()];
        if (monthIdx !== undefined) {
          weekDates.set(weekNum, new Date(year, monthIdx, day));
        }
      }
    }

    // Scan every content cell in this row for assessment title text
    for (let c = 0; c < cells.length; c++) {
      if (c === weekCol || c === beginDateCol) continue;

      const raw = cellText(cells[c]);
      if (!raw || raw === "-" || raw === "–") continue;

      // Normalise: strip bracket notes, weight annotations, time overrides, trailing punctuation
      const normalized = raw
        .replace(/\[[^\]]*\]/g, "") // [Pracs 0-1]
        .replace(/\(\d+%\)[^(]*/g, "") // (40%) and any trailing text
        .replace(/\(\d{1,2}:\d{2}[^)]*\)/g, "") // (23:59 3rd May)
        .replace(/[,;:]+$/, "")
        .trim();

      // Skip very short strings or pure date strings ("9 February")
      if (normalized.length < 4 || /^\d{1,2}\s+\w+$/.test(normalized)) continue;

      // Store lowercased for case-insensitive titlesOverlap lookup
      hints.set(normalized.toLowerCase(), weekNum);
    }
  }

  return { hints, weekDates };
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
    s
      .toLowerCase()
      .replace(/[^a-z]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3);

  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return false;

  // 1. First-word prefix match
  const [firstA] = wa;
  const [firstB] = wb;
  if (firstA.startsWith(firstB) || firstB.startsWith(firstA)) return true;

  // 2. Full-string normalised exact match: "eTest" → "etest", "E-Test" → "etest"
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  if (norm(a) === norm(b)) return true;

  // 3. Single-word lookup (4-char min to avoid short-word false positives):
  //    if the shorter title is a single significant word, check whether it
  //    appears anywhere in the longer title's word list.
  //    Guard: only match when the longer title is concise (≤ 2 words) —
  //    a bare keyword like "test" must not match a full title such as
  //    "Mid-Semester Test" where "test" is incidental, but can match
  //    "Workshop Quiz" (2 words) where "Quiz" is the main subject.
  const shortWords = wa.length <= wb.length ? wa : wb;
  const longWords = wa.length <= wb.length ? wb : wa;
  if (shortWords.length === 1 && shortWords[0].length >= 4) {
    if (longWords.length > 2) return false;
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
export function outlineToDeadlines(
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

  // Build week hints from ALL PC_TEXT columns so TBA fallback items can get a
  // weekLabel and resolvedDate even when the assessment doesn't appear in the
  // assessment-designated columns.
  const { hints: weekHints, weekDates } = buildWeekHints(outline.PC_TEXT, year);

  for (const asItem of asItems) {
    // Find all PC_TEXT items that match this AS_TASK entry (may be multiple — e.g.
    // one AS_TASK "Practical Test" → many PC_TEXT "Prac Test 1", "Prac Test 2", …)
    const matched = pcItems.filter((pc) =>
      titlesOverlap(pc.title, asItem.title),
    );

    if (matched.length > 0) {
      // Propagate AS_TASK weight and outcomes to matched calendar items that
      // didn't capture them from their cell annotation (e.g. no "(40%)" tag).
      // Propagate weight and outcomes to matched calendar items.
      // For 1:1 matches, apply the full weight directly.
      // For 1:N matches (e.g. "Worksheets" group → 11 individual sheets),
      // divide the group weight equally so per-item weights are meaningful
      // without inflating the sum (36% ÷ 11 → 3.3% each, not 36% × 11).
      // Outcomes are always propagated regardless of match count.
      const perItemWeight =
        asItem.weight !== undefined
          ? parseFloat((asItem.weight / matched.length).toFixed(1))
          : undefined;
      for (const pc of matched) {
        if (perItemWeight !== undefined && pc.weight === undefined)
          pc.weight = perItemWeight;
        if (asItem.outcomes !== undefined && pc.outcomes === undefined)
          pc.outcomes = asItem.outcomes;
      }
      continue; // already covered by dated calendar items
    }

    // Not found in the Assessment Due column — check all other PC_TEXT columns
    // via weekHints (e.g. "Mid-Semester Test" in Lecture/Workshop at week 5).
    // If a week is found, compute the begin-date of that teaching week so the
    // item gets a real calendar date rather than staying TBA.
    let hintWeek: number | undefined;
    for (const [hintTitle, weekNum] of weekHints) {
      if (titlesOverlap(hintTitle, asItem.title)) {
        hintWeek = weekNum;
        break;
      }
    }

    const hintWeekLabel =
      hintWeek !== undefined ? `Week ${hintWeek}` : undefined;
    // Prefer the actual begin date extracted from the TW cell (e.g. ELEN1000 "1\n16 Feb");
    // fall back to weekToDate() approximation when no embedded date is available.
    const hintResolvedDate =
      hintWeek !== undefined
        ? (weekDates.get(hintWeek) ?? weekToDate(semester, year, hintWeek))
        : undefined;

    pcItems.push({
      title: asItem.title,
      unit: unitCode,
      unitName,
      semester,
      year,
      isTBA: hintResolvedDate === undefined, // dated if week hint found; TBA otherwise
      resolvedDate: hintResolvedDate,
      weight: asItem.weight,
      outcomes: asItem.outcomes,
      weekLabel: hintWeekLabel,
    });
  }

  return pcItems;
}
