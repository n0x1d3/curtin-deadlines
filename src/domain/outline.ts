// ── Unit outline domain logic ─────────────────────────────────────────────────
// Pure parsing and conversion functions for Curtin unit outline data.
// No Chrome APIs, no network calls, no DOM access beyond DOMParser for HTML tables.

import type { PendingDeadline } from '../types';
import { parseOrdinalDate } from '../utils/getDates';

// ── Shared outline shape ───────────────────────────────────────────────────────

/** Key fields from UobOutline in the ScreenDataSetGetNew response. */
export interface UobOutline {
  UnitNumber: string;         // e.g. "COMP1005"
  Title: string;              // e.g. "Fundamentals of Programming"
  Avail_Study_Period: string; // e.g. "Semester 1"
  Avail_Year: string;         // e.g. "2026"
  AS_TASK: string;            // pipe-delimited assessment list
  PC_TEXT: string;            // HTML table with week-by-week calendar
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
        .replace(/[,;:]+$/, '')        // strip trailing punctuation
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
