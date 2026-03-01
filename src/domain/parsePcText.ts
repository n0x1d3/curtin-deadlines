import type { PendingDeadline } from "../types";
import { parseOrdinalDate } from "../utils/getDates";

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

  for (let r = 1; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll("td, th"));
    if (cells.length === 0) continue;

    if (useTwEmbeddedDate) {
      const twRaw = weekCol < cells.length ? cellText(cells[weekCol]) : "";
      if (!twRaw || !/^\d/.test(twRaw)) continue; // sub-row → skip

      const twDateMatch = twRaw.match(/\d+\s+(\d{1,2})\s+([A-Za-z]+)/);
      if (twDateMatch) {
        const d = parseInt(twDateMatch[1]);
        const mIdx = MONTH_MAP[twDateMatch[2].toLowerCase()];
        if (mIdx !== undefined) twCurrentDate = new Date(year, mIdx, d);
      }
      const wm = twRaw.match(/\d+/);
      twCurrentWeekNum = wm ? parseInt(wm[0]) : undefined;

      if (NON_TEACHING_RE.test(twRaw)) continue;
    }

    let baseDate: Date;
    let rowWeekLabel: string | undefined;

    if (useTwEmbeddedDate) {
      if (!twCurrentDate) continue;
      baseDate = twCurrentDate;
      rowWeekLabel =
        twCurrentWeekNum !== undefined ? `Week ${twCurrentWeekNum}` : undefined;
    } else {
      const beginDateText = cellText(cells[beginDateCol]);
      if (!beginDateText || NON_TEACHING_RE.test(beginDateText)) continue;
      const dateParts = beginDateText.match(/^(\d{1,2})\s+(\w+)/);
      if (!dateParts) continue;

      const day = parseInt(dateParts[1]);
      const monthIdx = MONTH_MAP[dateParts[2].toLowerCase()];
      if (monthIdx === undefined) continue;
      baseDate = new Date(year, monthIdx, day);

      const weekRaw = weekCol >= 0 ? cellText(cells[weekCol]) : "";
      const weekMatch = weekRaw.match(/\d+/);
      const weekNum =
        weekMatch && !isNaN(parseInt(weekMatch[0]))
          ? parseInt(weekMatch[0])
          : undefined;
      rowWeekLabel = weekNum !== undefined ? `Week ${weekNum}` : undefined;
    }

    for (const colIdx of assessmentCols) {
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

/**
 * Scans ALL columns of the PC_TEXT table (not just assessmentCols) to build:
 *  - hints: cell-content → teaching week number (for title matching)
 *  - weekDates: teaching week number → actual begin Date extracted from the TW cell
 */
export function buildWeekHints(
  pcText: string,
  year: number,
): { hints: Map<string, number>; weekDates: Map<number, Date> } {
  const hints = new Map<string, number>();
  const weekDates = new Map<number, Date>();
  if (!pcText) return { hints, weekDates };

  const doc = new DOMParser().parseFromString(pcText, "text/html");
  const rows = Array.from(doc.querySelectorAll("tr"));
  if (rows.length < 2) return { hints, weekDates };

  const cellText = (el: Element | undefined): string =>
    (el?.textContent ?? "").replace(/\u00A0/g, " ").trim();

  const headerCells = Array.from(rows[0].querySelectorAll("th, td"));
  let weekCol = -1;
  let beginDateCol = -1;
  headerCells.forEach((cell, i) => {
    const text = cellText(cell).toLowerCase();
    if (weekCol === -1 && (text.includes("week") || text.trim() === "tw"))
      weekCol = i;
    if (text.includes("begin") && text.includes("date")) beginDateCol = i;
  });

  if (weekCol === -1) return { hints, weekDates };

  for (let r = 1; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll("td, th"));
    if (cells.length === 0) continue;

    const weekText = cellText(cells[weekCol]);
    if (!weekText) continue;
    if (NON_TEACHING_RE.test(weekText)) continue;

    const weekMatch = weekText.match(/\d+/);
    if (!weekMatch) continue;
    const weekNum = parseInt(weekMatch[0]);
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 20) continue;

    if (!weekDates.has(weekNum)) {
      const twDateMatch = weekText.match(/\d+\s+(\d{1,2})\s+([A-Za-z]+)/);
      if (twDateMatch) {
        const day = parseInt(twDateMatch[1]);
        const monthIdx = MONTH_MAP[twDateMatch[2].toLowerCase()];
        if (monthIdx !== undefined) {
          weekDates.set(weekNum, new Date(year, monthIdx, day));
        }
      }
    }

    for (let c = 0; c < cells.length; c++) {
      if (c === weekCol || c === beginDateCol) continue;

      const raw = cellText(cells[c]);
      if (!raw || raw === "-" || raw === "–") continue;

      const normalized = raw
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\(\d+%\)[^(]*/g, "")
        .replace(/\(\d{1,2}:\d{2}[^)]*\)/g, "")
        .replace(/[,;:]+$/, "")
        .trim();

      if (normalized.length < 4 || /^\d{1,2}\s+\w+$/.test(normalized)) continue;
      hints.set(normalized.toLowerCase(), weekNum);
    }
  }

  return { hints, weekDates };
}
