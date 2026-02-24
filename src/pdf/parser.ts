// ── PDF parsing functions ──────────────────────────────────────────────────────
// Extracted from sidePanel.ts so both the side panel and the test panel can
// import them without duplicating code.
//
// This module is pure — no DOM access, no Chrome storage. The only Chrome API
// used is chrome.runtime.getURL() inside initPdfWorker(), which the caller must
// invoke once before calling extractPDFText().

import * as pdfjsLib from 'pdfjs-dist';
import type { PendingDeadline } from '../types';
import { weekToDate, parseOrdinalDate } from '../utils/getDates';

// ── Worker setup ──────────────────────────────────────────────────────────────

/**
 * Point pdf.js at the worker file bundled into the extension.
 * Must be called once per page before the first extractPDFText() call.
 * Pass chrome.runtime.getURL('pdf.worker.min.js') as the argument.
 */
export function initPdfWorker(workerSrc: string): void {
  (pdfjsLib as any).GlobalWorkerOptions.workerSrc = workerSrc;
}

// ── Unit name extraction ───────────────────────────────────────────────────────

/**
 * Attempt to extract the full unit name from the PDF header.
 *
 * Curtin OASIS unit outlines consistently place the unit name immediately
 * after the unit code near the top of the first page. Two common layouts:
 *   a) Same line:  "COMP1005 Introduction to Computing"
 *   b) Next line:  "COMP1005\n" followed by "Introduction to Computing"
 *
 * We scan only the first 40 non-empty lines (the header area), so we don't
 * accidentally match assessment titles or table content deeper in the PDF.
 *
 * Candidate rejection rules:
 *   - Must be ≥ 5 characters and contain at least one space (multi-word)
 *   - Must start with a capital letter (after stripping null-byte '#' chars)
 *   - Must not look like a school/faculty/compliance line, a date, or other noise
 *
 * @param text      Full extracted PDF text (with '#' null-byte placeholders)
 * @param unitCode  Known unit code from filename, e.g. "COMP1005"
 * @returns         Unit name string, or undefined if not found
 */
export function parseUnitName(text: string, unitCode: string): string | undefined {
  if (!unitCode) return undefined;

  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  // Only look at the first 20 lines — the unit name is always in the header
  const header = lines.slice(0, 20);

  // Curtin OASIS unit outlines consistently format the header line as:
  //   "COMP # # # #   (V. # ) Fundamentals of Programming"
  //
  // Digits in the unit code and version number are null-byte encoded → '#' with
  // spaces between them. The version string "(V. #)" acts as a reliable delimiter:
  // the unit name is everything that follows it on the same line.
  //
  // Regex: match "(V." + optional spaces/digits/'#' + ")" then capture the rest.
  const VERSION_DELIM = /\(V\.\s*[#\d][^)]*\)\s*(.+)$/i;

  for (const line of header) {
    const m = line.match(VERSION_DELIM);
    if (!m) continue;

    // Strip '#' placeholders and collapse whitespace from the captured name
    const candidate = m[1].replace(/#/g, '').replace(/\s{2,}/g, ' ').trim();

    // Accept names that are multi-word, start with a capital, and are not noise
    if (
      candidate.length >= 5 &&
      candidate.includes(' ') &&
      /^[A-Z]/.test(candidate)
    ) {
      return candidate;
    }
  }

  return undefined;
}

// ── Text extraction ────────────────────────────────────────────────────────────

/**
 * Extract all text from a PDF file using pdf.js.
 * Uses the y-coordinate of each text item to detect line breaks, which
 * preserves the visual line structure of the original document.
 */
export async function extractPDFText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const typedArray = new Uint8Array(arrayBuffer);

  const loadingTask = (pdfjsLib as any).getDocument({ data: typedArray });
  const pdfDoc = await loadingTask.promise;

  let fullText = '';

  // Process each page in sequence
  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();

    let pageText = '';
    let lastY: number | null = null;

    // Items are TextItem or TextMarkedContent — only TextItem has .str
    for (const item of textContent.items) {
      if (!('str' in item)) continue;
      const textItem = item as { str: string; transform: number[]; hasEOL?: boolean };
      const y = textItem.transform[5]; // vertical baseline position

      // When the baseline shifts significantly, insert a newline
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        pageText += '\n';
      }
      // Replace null bytes (\u0000) with '#' placeholders rather than stripping.
      // Some Curtin PDFs encode digit glyphs as null bytes. Using '#' preserves
      // the digit count, which lets parseOrdinalDate recover deterministic dates:
      //   "#rd May" (1 null + "rd") → 3rd May
      //   "##rd May" (2 nulls + "rd") → 23rd May
      // isPercentLine / isNoiseLine see '#' as non-significant (correct behaviour).
      pageText += textItem.str.replace(/\u0000/g, '#') + ' ';
      lastY = y;
    }

    fullText += pageText + '\n\n';
  }

  return fullText;
}

// ── Assessment schedule parser ─────────────────────────────────────────────────

/**
 * Parse extracted PDF text looking for Curtin OASIS unit outline assessment entries.
 *
 * The Curtin OASIS template has consistent labeled fields for each assessment item:
 *   Week: Teaching weeks 1, 2, 3...   (or "Week: Week 5", "Week: Exam week", etc.)
 *   Day:  24 hours after workshop      (or "Day: 3rd May", "Day: TBA")
 *   Time: 23:59                        (or "Time: 5.00 PM", "Time: TBA")
 *
 * @param text         Full extracted text from all PDF pages
 * @param defaultUnit  Unit code from filename (e.g. "PRRE1003")
 * @param year         Academic year for date resolution (e.g. 2026)
 * @param semester     Default semester inferred from filename (1 or 2)
 */
export function parseAssessments(
  text: string,
  defaultUnit: string,
  year: number,
  semester: 1 | 2,
): PendingDeadline[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const results: PendingDeadline[] = [];

  // Match ANY "Week:" label line, including empty values
  const WEEK_LINE = /^Week:\s*(.*)$/i;
  const DAY_LINE = /^Day:\s*(.+)$/i;
  const TIME_LINE = /^Time:\s*(.+)$/i;

  /** True when a line IS purely a percentage value. */
  function isPercentLine(line: string): boolean {
    return /^\s*[\d#\s]*%\s*$/.test(line);
  }

  /** True when a line ENDS with a percentage value but has text before it. */
  function endsWithPercent(line: string): boolean {
    return /\S.*\s*[\d#\s]*%\s*$/.test(line);
  }

  /** Strip the trailing percentage value from a combined "title + %" line. */
  function extractTitleFromPercentLine(line: string): string {
    return line.replace(/\s*[\d#\s]*%\s*$/, '').trim();
  }

  /** True when a line is structural noise (headers, footers, garbled sequences). */
  function isNoiseLine(line: string): boolean {
    const significant = line.replace(/[\s,#]/g, '');
    if (significant.length <= 1 && line.length > 3) return true;

    return (
      /^(Week:|Day:|Time:)/i.test(line) ||
      /^(Task\s*$|Value\s*$|Date Due|Unit\s*$|Outcome|Late\s*$|Extension|Accepted|Considered)/i.test(line) ||
      /^(Assessment Schedule|Assessment$|Faculty of|WASM:|CRICOS|Page\s+\d|The only auth)/i.test(line) ||
      /\b(No\s+No|Yes\s+Yes|Yes\s+No|No\s+Yes)\b/i.test(line) ||
      /^\*/.test(line) ||
      /^[*\s]+$/.test(line)
    );
  }

  /**
   * True when the week or day value indicates the deadline is not a fixed date.
   * Covers TBA markers, descriptive week phrases, and relative day phrases.
   */
  function isTBAValue(val: string): boolean {
    return /\b(TBA|TBC|exam(ination)? (week|period)|teaching week|study week|flexible|as per|schedule|after your|hours after|centrally|one week after|during|fortnightly|weekly|bi-?weekly)\b/i.test(val);
  }

  /** Extract the last digit-only week number from a string. */
  function extractLastWeek(s: string): number | undefined {
    const nums = s.match(/\b(\d{1,2})\b/g);
    if (!nums || nums.length === 0) return undefined;
    const last = parseInt(nums[nums.length - 1], 10);
    return last >= 1 && last <= 20 ? last : undefined;
  }

  /**
   * Extract ALL week numbers from a string like "Teaching weeks 2,3,...,12"
   * or "Weeks 1-13". Returns a sorted, deduplicated array of valid week numbers.
   */
  function extractAllWeeks(s: string): number[] {
    const rangeMatch = s.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      const weeks: number[] = [];
      for (let w = Math.min(start, end); w <= Math.max(start, end); w++) {
        if (w >= 1 && w <= 20) weeks.push(w);
      }
      return weeks;
    }
    const all = (s.match(/\b(\d{1,2})\b/g) ?? [])
      .map((n) => parseInt(n, 10))
      .filter((n) => n >= 1 && n <= 20);
    return [...new Set(all)].sort((a, b) => a - b);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const weekMatch = line.match(WEEK_LINE);
    if (!weekMatch) continue;

    const weekStr = (weekMatch[1] ?? '').trim();

    // ── Collect multi-line task title + assessment weight ──────────────────
    const titleParts: string[] = [];
    let foundPercent = false;
    let extractedWeight: number | undefined;

    for (let back = 1; back <= 12 && i - back >= 0; back++) {
      const prev = lines[i - back];

      if (WEEK_LINE.test(prev) || /^(Assessment Schedule|Learning Activities)/i.test(prev)) break;
      if (/^(Day:|Time:)/i.test(prev)) break;

      if (isPercentLine(prev)) {
        foundPercent = true;
        const pctMatch = prev.match(/(\d+)\s*%/);
        if (pctMatch) {
          const pct = parseInt(pctMatch[1], 10);
          if (pct > 0 && pct <= 100) extractedWeight = pct;
        }
        continue;
      }

      if (!foundPercent && endsWithPercent(prev)) {
        foundPercent = true;
        const pctMatch = prev.match(/(\d+)\s*%/);
        if (pctMatch) {
          const pct = parseInt(pctMatch[1], 10);
          if (pct > 0 && pct <= 100) extractedWeight = pct;
        }
        const tp = extractTitleFromPercentLine(prev);
        if (tp && !isNoiseLine(tp)) titleParts.unshift(tp);
        continue;
      }

      if (foundPercent) {
        if (!isNoiseLine(prev) && prev.length > 1) {
          titleParts.unshift(prev);
        } else if (isNoiseLine(prev) && titleParts.length > 0) {
          break;
        }
      }
    }

    // Fallback: grab 1-3 non-noise lines immediately above the Week: line
    if (titleParts.length === 0) {
      for (let back = 1; back <= 5 && i - back >= 0; back++) {
        const prev = lines[i - back];
        if (WEEK_LINE.test(prev) || /^(Assessment Schedule)/i.test(prev)) break;
        if (!isNoiseLine(prev) && !isPercentLine(prev) && prev.length > 2) {
          titleParts.unshift(prev);
          if (titleParts.length >= 3) break;
        }
      }
    }

    // Build and clean the final title string
    const rawTitle = titleParts.join(' ').replace(/\s+/g, ' ').trim();
    const title = rawTitle
      .replace(/^[,*#\s]+|[,*#\s]+$/g, '')
      .replace(/\s*\([x×][\s#]*\)\s*/gi, '')
      .replace(/#/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || 'Unknown task';

    // ── Look ahead for Day: and Time: ──────────────────────────────────────
    let exactDay = '';
    let exactTime = '';

    for (let fwd = 1; fwd <= 10 && i + fwd < lines.length; fwd++) {
      const ahead = lines[i + fwd];
      if (WEEK_LINE.test(ahead)) break;

      if (!exactDay) {
        const m = ahead.match(DAY_LINE);
        if (m) {
          exactDay = m[1].trim();
          for (let d = 1; d <= 3 && i + fwd + d < lines.length; d++) {
            const cont = lines[i + fwd + d];
            if (TIME_LINE.test(cont) || WEEK_LINE.test(cont) || isNoiseLine(cont)) break;
            exactDay += ' ' + cont.trim();
          }
          continue;
        }
      }

      if (!exactTime) {
        const m = ahead.match(TIME_LINE);
        if (m) {
          exactTime = m[1].trim();
          continue;
        }
      }
    }

    // ── Date resolution ────────────────────────────────────────────────────
    const parsedExactDate = exactDay ? parseOrdinalDate(exactDay, year) : null;
    const allWeeks = extractAllWeeks(weekStr);
    const noUsableData = allWeeks.length === 0 && !parsedExactDate;

    const isTBA =
      noUsableData ||
      (isTBAValue(weekStr) && allWeeks.length === 0) ||
      (weekStr === '' && !parsedExactDate) ||
      (exactDay === '' && allWeeks.length === 0) ||
      isTBAValue(exactDay);

    // ── Multi-week expansion ───────────────────────────────────────────────
    if (!isTBA && allWeeks.length > 1) {
      for (const wk of allWeeks) {
        results.push({
          title,
          unit: defaultUnit,
          weekLabel: `Week ${wk}`,
          week: wk,
          semester,
          year,
          exactDay: exactDay || undefined,
          exactTime: exactTime || undefined,
          resolvedDate: weekToDate(semester, year, wk, 0),
          isTBA: false,
          weight: extractedWeight,
        });
      }
      continue;
    }

    // ── Single-item date resolution ────────────────────────────────────────
    let resolvedDate: Date | undefined;

    if (!isTBA) {
      if (parsedExactDate) {
        resolvedDate = parsedExactDate;
        if (exactTime) {
          const hhmm = exactTime.match(/(\d{1,2})[:.]\s*(\d{2})\s*(AM|PM)?/i);
          if (hhmm) {
            let h = parseInt(hhmm[1], 10);
            const m = parseInt(hhmm[2], 10);
            const ampm = hhmm[3]?.toUpperCase();
            if (ampm === 'PM' && h < 12) h += 12;
            if (ampm === 'AM' && h === 12) h = 0;
            resolvedDate.setHours(h, m, 0, 0);
          }
        }
      }
      if (!resolvedDate && allWeeks.length > 0) {
        resolvedDate = weekToDate(semester, year, allWeeks[allWeeks.length - 1], 0);
      }
    }

    results.push({
      title,
      unit: defaultUnit,
      weekLabel: weekStr.replace(/#/g, '').replace(/\s{2,}/g, ' ').trim() || undefined,
      week: allWeeks.length > 0 ? allWeeks[allWeeks.length - 1] : undefined,
      semester,
      year,
      exactDay: exactDay || undefined,
      exactTime: exactTime || undefined,
      resolvedDate,
      isTBA,
      weight: extractedWeight,
    });
  }

  return results;
}

// ── Program Calendar parser ────────────────────────────────────────────────────

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
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  // Find the "Program Calendar" section header
  const calStart = lines.findIndex(
    (l) => /\bprogram\s+calendar\b/i.test(l) && l.length < 60,
  );
  if (calStart === -1) return [];

  // ── Week-row patterns ──────────────────────────────────────────────────
  // Null bytes → '#' placeholders. Single-digit: lone '#'; two-digit: "##" or "# #".
  const WEEK_ROW_FULL =
    /^[#\d](?:\s[#\d])?\s*\.\s+[#\d](?:\s[#\d])?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

  const WEEK_ROW_SHORT = /^[#\d](?:\s[#\d])?\s*\.\s*$/;

  const NON_TEACHING =
    /tuition[\s-]*free|study\s*week|orientation\s*week|examinations?\b/i;

  // Dot-free non-teaching week row (PRRE1003 style: "# April Tuition Free Week")
  const NO_DOT_WEEK_ROW =
    /^[#\d](?:\s[#\d])?\s{2,}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

  const SKIP_LINE =
    /program\s+calendar|CRICOS|The only authoritative|Faculty of|School of|WASM:|Bentley Perth|^Page\s*\d|^Week\s*$|^Begin\s*$|^Assessment\s*$|^Teaching\s*Week\s*$|^Semester\s*\d/i;

  // Assessment keyword patterns — most specific to least specific
  const ASSESSMENT_DEFS: Array<{
    re: RegExp;
    getTitle: (m: RegExpMatchArray) => string;
  }> = [
    { re: /Mid[\s-]+[Ss]em(ester)?\s*[\s-]*Test/i, getTitle: () => 'Mid-Semester Test' },
    { re: /Workshop[\s-]*Quiz/i,                    getTitle: () => 'Workshop Quiz' },
    { re: /eTest\b/i,                               getTitle: () => 'eTest' },
    { re: /Practical\s+Test|Prac\s*Test/i,          getTitle: () => 'Practical Test' },
    { re: /Assignment\b/i,                          getTitle: () => 'Assignment' },
    { re: /Lab\s+[A-Z]\s*Report/i,                  getTitle: (m) => m[0].replace(/\s+/g, ' ').trim() },
    { re: /Lab\s+Report/i,                          getTitle: () => 'Lab Report' },
    { re: /Worksheet\b/i,                           getTitle: () => 'Worksheet' },
    { re: /\bQuiz\b/i,                              getTitle: () => 'Quiz' },
    { re: /\bExam\b/i,                              getTitle: () => 'Exam' },
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
    const content = rawContent.replace(/#/g, '').replace(/\s{2,}/g, ' ').trim();
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
        (r) => r.unit === defaultUnit && r.title === title && r.week === weekNum,
      );
      if (isDup) continue;

      const resolvedWeekLabel =
        weekLabelOverride === undefined
          ? `Week ${weekNum}`
          : (weekLabelOverride === null ? undefined : weekLabelOverride);

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

    if (SKIP_LINE.test(line)) { i++; continue; }

    if (WEEK_ROW_FULL.test(line)) {
      calendarWeekCount++;

      const inlineContent = line.replace(
        /^[#\d](?:\s[#\d])?\s*\.\s+[#\d](?:\s[#\d])?\s+[A-Za-z]{3,9}\s*/,
        '',
      );

      const contentParts: string[] = [inlineContent];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (WEEK_ROW_FULL.test(next) || WEEK_ROW_SHORT.test(next)) break;
        if (SKIP_LINE.test(next)) { i++; break; }
        if (NO_DOT_WEEK_ROW.test(next) && NON_TEACHING.test(next)) break;
        if (NON_TEACHING.test(next)) { i++; break; }
        contentParts.push(next);
        i++;
      }

      if (NON_TEACHING.test(line)) continue;

      const weekDate = new Date(semStart.getTime() + (calendarWeekCount - 1) * 7 * 86_400_000);
      extractFromContent(contentParts.join(' '), calendarWeekCount, weekDate);
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
        if (SKIP_LINE.test(next)) { i++; break; }
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

      const joined = contentParts.join(' ');
      if (NON_TEACHING.test(joined)) continue;

      const weekDate = new Date(semStart.getTime() + (calendarWeekCount - 1) * 7 * 86_400_000);
      extractFromContent(joined, calendarWeekCount, weekDate);
      continue;
    }

    // Dot-free non-teaching week row (PRRE1003 style)
    if (NO_DOT_WEEK_ROW.test(line) && NON_TEACHING.test(line)) {
      calendarWeekCount++;

      // Strip prefix + NT keyword and check remaining content for assessments
      const ntTrailing = line
        .replace(/^[#\d](?:\s[#\d])?\s{2,}[A-Za-z]+\s*/i, '')
        .replace(/tuition[\s-]*free[\s-]*week\s*/i, '')
        .replace(/study\s*week\s*/i, '')
        .replace(/orientation\s*week\s*/i, '')
        .replace(/examination[s]?\s*/i, '')
        .trim();
      if (ntTrailing.length > 2) {
        const ntWeekDate = new Date(semStart.getTime() + (calendarWeekCount - 1) * 7 * 86_400_000);
        extractFromContent(ntTrailing, calendarWeekCount, ntWeekDate, null);
      }

      i++;
      continue;
    }

    if (NON_TEACHING.test(line)) { i++; continue; }

    i++;
  }

  return results;
}

// ── Merge + sequence numbering ─────────────────────────────────────────────────

/**
 * Merge program calendar items into the assessment schedule item list.
 *
 * Strategy:
 *   1. Upgrade TBA schedule items that match a calendar item (fill in week + date)
 *   2. Append calendar items that don't match any existing schedule item
 *   3. Drop calendar items that duplicate an already-resolved schedule item
 */
export function mergeWithCalendar(
  scheduleItems: PendingDeadline[],
  calendarItems: PendingDeadline[],
): PendingDeadline[] {
  const merged = [...scheduleItems];

  // Normalise: expand "Sem" → "Semester", then lowercase + strip non-alphanumeric
  const norm = (s: string) =>
    s.replace(/\bSem\b/gi, 'Semester').toLowerCase().replace(/[^a-z0-9]/g, '');

  const titlesMatch = (a: string, b: string): boolean => {
    const na = norm(a), nb = norm(b);
    return na === nb || na.startsWith(nb) || nb.startsWith(na) ||
      na.includes(nb) || nb.includes(na);
  };

  for (const calItem of calendarItems) {
    const tbaIdx = merged.findIndex(
      (s) => s.isTBA && titlesMatch(s.title, calItem.title),
    );

    if (tbaIdx >= 0) {
      // Upgrade the TBA entry; prefer calendar's canonical title (from ASSESSMENT_DEFS)
      merged[tbaIdx] = {
        ...merged[tbaIdx],
        title: calItem.title,
        week: calItem.week,
        weekLabel: calItem.weekLabel,
        resolvedDate: calItem.resolvedDate,
        isTBA: false,
        calSource: true,
      };
    } else {
      // No TBA match — skip if a resolved item already covers this week + title
      const resolvedDup = merged.some(
        (s) => !s.isTBA && titlesMatch(s.title, calItem.title) && (!s.week || s.week === calItem.week),
      );
      if (!resolvedDup) {
        merged.push(calItem);
      }
    }
  }

  return merged;
}

/**
 * Post-process a merged item list to add sequential numbering to recurring
 * assessments (e.g. 5× "Practical Test" → "Practical Test 1" … "Practical Test 5").
 * Items that appear only once keep their original title unchanged.
 */
export function addSequenceNumbers(items: PendingDeadline[]): PendingDeadline[] {
  function baseTitle(t: string): string {
    return t
      .replace(/\s*[-–—]\s+\S.*$/, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const normKey = (unit: string, t: string) =>
    `${unit}|${baseTitle(t).toLowerCase().replace(/\s+/g, ' ')}`;

  // Count occurrences per (unit, base title)
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = normKey(item.unit, item.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Number items in groups of 2+
  const seqMap = new Map<string, number>();
  return items.map((item) => {
    const key = normKey(item.unit, item.title);
    if ((counts.get(key) ?? 0) <= 1) return item;

    const seq = (seqMap.get(key) ?? 0) + 1;
    seqMap.set(key, seq);

    return { ...item, title: `${baseTitle(item.title)} ${seq}` };
  });
}
