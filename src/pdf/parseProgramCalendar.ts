// ── Program Calendar parser ──────────────────────────────────────────────────
// Parses the "Program Calendar" section from Curtin unit outline PDFs.

import type { PendingDeadline } from "../types";
import { weekToDate } from "../utils/getDates";

/**
 * Parse the "Program Calendar" section at the bottom of Curtin unit outline PDFs.
 *
 * The Program Calendar is a per-week table listing the week start date and any
 * assessments due that week. It complements the assessment schedule by providing
 * week numbers for all activities, including recurring ones like weekly worksheets.
 *
 * @param text         Full extracted text from all PDF pages
 * @param defaultUnit  Unit code (e.g. "COMP1005")
 * @param year         Academic year (e.g. 2026)
 * @param semester     1 or 2
 * @returns            PendingDeadline items with resolved week numbers
 */
export function parseProgramCalendar(
  text: string,
  defaultUnit: string,
  year: number,
  semester: 1 | 2,
): PendingDeadline[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Find the "Program Calendar" section header
  const calStart = lines.findIndex(
    (l) => /\bprogram\s+calendar\b/i.test(l) && l.length < 60,
  );
  if (calStart === -1) return [];

  // ── Week-row patterns ──────────────────────────────────────────────────
  // Two-digit numbers appear in two forms depending on the PDF/decoding path:
  //   Pre-decode (null-byte PDFs without ActualText): "# #" (space-separated hashes)
  //   Post-decode (ActualText decoded + digit-collapsed):  "16"  (single 2-char token)
  // NUM matches both: \d{1,2} covers "1"–"31"; #(?:\s#)? covers "#" and "# #".
  const NUM = /(?:\d{1,2}|#(?:\s#)?)/;
  const WEEK_ROW_FULL = new RegExp(
    `^${NUM.source}\\s*\\.\\s+${NUM.source}\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)`,
    "i",
  );

  const WEEK_ROW_SHORT = new RegExp(`^${NUM.source}\\s*\\.\\s*$`);

  const NON_TEACHING =
    /tuition[\s-]*free|study\s*week|orientation\s*week|examinations?\b/i;

  // Dot-free non-teaching week row (PRRE1003 style: "# April Tuition Free Week")
  const NO_DOT_WEEK_ROW = new RegExp(
    `^${NUM.source}\\s{2,}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)`,
    "i",
  );

  const SKIP_LINE =
    /program\s+calendar|CRICOS|The only authoritative|Faculty of|School of|WASM:|Bentley Perth|^Page\s*\d|^Week\s*$|^Begin\s*$|^Assessment\s*$|^Teaching\s*Week\s*$|^Semester\s*\d/i;

  // Assessment keyword patterns — most specific to least specific
  const ASSESSMENT_DEFS: Array<{
    re: RegExp;
    getTitle: (m: RegExpMatchArray) => string;
  }> = [
    {
      re: /Mid[\s-]+[Ss]em(ester)?\s*[\s-]*Test/i,
      getTitle: () => "Mid-Semester Test",
    },
    { re: /Workshop[\s-]*Quiz/i, getTitle: () => "Workshop Quiz" },
    { re: /eTest\b/i, getTitle: () => "eTest" },
    { re: /Practical\s+Test|Prac\s*Test/i, getTitle: () => "Practical Test" },
    { re: /Assignment\b/i, getTitle: () => "Assignment" },
    {
      re: /Lab\s+[A-Z]\s*Report/i,
      getTitle: (m) => m[0].replace(/\s+/g, " ").trim(),
    },
    { re: /Lab\s+Report/i, getTitle: () => "Lab Report" },
    { re: /Worksheet\b/i, getTitle: () => "Worksheet" },
    { re: /\bQuiz\b/i, getTitle: () => "Quiz" },
    { re: /\bExam\b/i, getTitle: () => "Exam" },
  ];

  const results: PendingDeadline[] = [];
  let calendarWeekCount = 0;
  const semStart = weekToDate(semester, year, 1, 0);

  /**
   * Check a content string for known assessment keywords and push a result
   * for each unique (unit + title + week) combination found.
   */
  function extractFromContent(
    rawContent: string,
    weekNum: number,
    weekDate: Date,
    weekLabelOverride?: string | null,
  ): void {
    const content = rawContent
      .replace(/#/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (content.length < 3) return;

    const matchedTitles: string[] = [];

    for (const { re, getTitle } of ASSESSMENT_DEFS) {
      const m = content.match(re);
      if (!m) continue;

      const title = getTitle(m);

      // Subsumption: skip if a previously matched title contains this one
      if (matchedTitles.some((t) => t.includes(title))) continue;
      matchedTitles.push(title);

      // Deduplicate across multiple calls for the same week
      const isDup = results.some(
        (r) =>
          r.unit === defaultUnit && r.title === title && r.week === weekNum,
      );
      if (isDup) continue;

      const resolvedWeekLabel =
        weekLabelOverride === undefined
          ? `Week ${weekNum}`
          : weekLabelOverride === null
            ? undefined
            : weekLabelOverride;

      results.push({
        title,
        unit: defaultUnit,
        weekLabel: resolvedWeekLabel,
        week: weekNum,
        semester,
        year,
        resolvedDate: weekDate,
        isTBA: false,
        calSource: true,
      });
    }
  }

  // ── Scan lines from after the "Program Calendar" header ────────────────
  // IMPORTANT: WEEK_ROW checks come BEFORE the standalone NON_TEACHING check
  // so calendarWeekCount is incremented for every week row including breaks.
  let i = calStart + 1;
  while (i < lines.length) {
    const line = lines[i];

    if (SKIP_LINE.test(line)) {
      i++;
      continue;
    }

    if (WEEK_ROW_FULL.test(line)) {
      calendarWeekCount++;

      const inlineContent = line.replace(
        new RegExp(
          `^${NUM.source}\\s*\\.\\s+${NUM.source}\\s+[A-Za-z]{3,9}\\s*`,
        ),
        "",
      );

      const contentParts: string[] = [inlineContent];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (WEEK_ROW_FULL.test(next) || WEEK_ROW_SHORT.test(next)) break;
        if (SKIP_LINE.test(next)) {
          i++;
          break;
        }
        if (NO_DOT_WEEK_ROW.test(next) && NON_TEACHING.test(next)) break;
        if (NON_TEACHING.test(next)) {
          i++;
          break;
        }
        contentParts.push(next);
        i++;
      }

      if (NON_TEACHING.test(line)) continue;

      const weekDate = new Date(
        semStart.getTime() + (calendarWeekCount - 1) * 7 * 86_400_000,
      );
      extractFromContent(contentParts.join(" "), calendarWeekCount, weekDate);
      continue;
    }

    if (WEEK_ROW_SHORT.test(line)) {
      calendarWeekCount++;

      const contentParts: string[] = [];
      let isNonTeachingRow = false;
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (WEEK_ROW_FULL.test(next) || WEEK_ROW_SHORT.test(next)) break;
        if (SKIP_LINE.test(next)) {
          i++;
          break;
        }
        if (NO_DOT_WEEK_ROW.test(next) && NON_TEACHING.test(next)) break;
        if (NON_TEACHING.test(next)) {
          isNonTeachingRow = true;
          i++;
          break;
        }
        contentParts.push(next);
        i++;
      }

      if (isNonTeachingRow) continue;

      const joined = contentParts.join(" ");
      if (NON_TEACHING.test(joined)) continue;

      const weekDate = new Date(
        semStart.getTime() + (calendarWeekCount - 1) * 7 * 86_400_000,
      );
      extractFromContent(joined, calendarWeekCount, weekDate);
      continue;
    }

    // Dot-free non-teaching week row (PRRE1003 style)
    if (NO_DOT_WEEK_ROW.test(line) && NON_TEACHING.test(line)) {
      calendarWeekCount++;

      // Strip prefix + NT keyword and check remaining content for assessments
      const ntTrailing = line
        .replace(/^[#\d](?:\s[#\d])?\s{2,}[A-Za-z]+\s*/i, "")
        .replace(/tuition[\s-]*free[\s-]*week\s*/i, "")
        .replace(/study\s*week\s*/i, "")
        .replace(/orientation\s*week\s*/i, "")
        .replace(/examination[s]?\s*/i, "")
        .trim();
      if (ntTrailing.length > 2) {
        const ntWeekDate = new Date(
          semStart.getTime() + (calendarWeekCount - 1) * 7 * 86_400_000,
        );
        extractFromContent(ntTrailing, calendarWeekCount, ntWeekDate, null);
      }

      i++;
      continue;
    }

    if (NON_TEACHING.test(line)) {
      i++;
      continue;
    }

    i++;
  }

  return results;
}
