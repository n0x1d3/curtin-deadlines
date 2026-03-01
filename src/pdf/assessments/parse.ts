import type { PendingDeadline } from "../../types";
import { weekToDate, parseOrdinalDate } from "../../utils/getDates";
import {
  isPercentLine,
  endsWithPercent,
  extractTitleFromPercentLine,
  isNoiseLine,
  isTBAValue,
  isOutcomesLine,
  isYesNoLine,
  isCombinedYesNo,
  isMetaValue,
} from "./classify";
import { extractAllWeeks, normalizeWeekLabel } from "./week";

interface RowMeta {
  outcomes?: string;
  lateAccepted?: boolean;
  extensionConsidered?: boolean;
}

/** Parse a flat list of meta-value lines into per-row (outcomes, late, ext) triplets. */
function parseTriplets(candidates: string[]): RowMeta[] {
  const result: RowMeta[] = [];
  let i = 0;

  while (i < candidates.length) {
    const line = candidates[i];

    if (isOutcomesLine(line)) {
      const outcomes = line.replace(/\s/g, "");
      i++;
      if (i >= candidates.length) {
        result.push({ outcomes });
        continue;
      }
      const next = candidates[i];
      if (isCombinedYesNo(next)) {
        const m = next.match(/^(yes|no)\s+(yes|no)/i)!;
        result.push({
          outcomes,
          lateAccepted: /^yes$/i.test(m[1]),
          extensionConsidered: /^yes$/i.test(m[2]),
        });
        i++;
      } else if (isYesNoLine(next)) {
        const lateAccepted = /^yes$/i.test(next);
        i++;
        const ext = i < candidates.length ? candidates[i] : undefined;
        if (ext && isYesNoLine(ext)) {
          result.push({
            outcomes,
            lateAccepted,
            extensionConsidered: /^yes$/i.test(ext),
          });
          i++;
        } else {
          result.push({ outcomes, lateAccepted });
        }
      } else {
        result.push({ outcomes });
      }
      continue;
    }

    if (isCombinedYesNo(line)) {
      const m = line.match(/^(yes|no)\s+(yes|no)/i)!;
      result.push({
        lateAccepted: /^yes$/i.test(m[1]),
        extensionConsidered: /^yes$/i.test(m[2]),
      });
      i++;
      continue;
    }

    if (isYesNoLine(line)) {
      const lateAccepted = /^yes$/i.test(line);
      i++;
      const ext = i < candidates.length ? candidates[i] : undefined;
      if (ext && isYesNoLine(ext)) {
        result.push({ lateAccepted, extensionConsidered: /^yes$/i.test(ext) });
        i++;
      } else {
        result.push({ lateAccepted });
      }
      continue;
    }

    i++; // skip unrecognised line
  }

  return result;
}

/**
 * Pre-extract the per-row meta block from a section's lines.
 *
 * The PDF renderer places right-column values (outcomes, late, ext) for ALL rows
 * as a grouped block between the first Day: and first Time: in the section.
 * Returns one RowMeta entry per assessment row, in row order.
 */
function extractMetaTriplets(sectionLines: string[]): RowMeta[] {
  let firstDayIdx = -1;
  let firstTimeIdx = -1;

  for (let i = 0; i < sectionLines.length; i++) {
    if (firstDayIdx === -1 && /^Day:\s*/i.test(sectionLines[i])) {
      firstDayIdx = i;
    } else if (firstDayIdx !== -1 && /^Time:\s*/i.test(sectionLines[i])) {
      firstTimeIdx = i;
      break;
    }
  }

  if (firstDayIdx === -1 || firstTimeIdx === -1) return [];

  // Column header text is filtered out; only outcomes/yes-no lines remain
  const block = sectionLines
    .slice(firstDayIdx + 1, firstTimeIdx)
    .filter(isMetaValue);
  return parseTriplets(block);
}

/**
 * Parse the "Assessment Schedule" section from Curtin OASIS unit outline PDFs.
 *
 * The section contains one assessment item per row with labeled fields:
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
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Find the "Assessment Schedule" section header
  const schedStart = lines.findIndex((l) =>
    /^Assessment\s+Schedule\b/i.test(l),
  );
  if (schedStart === -1) return [];

  // Stop before "Detailed Information on assessment tasks" or "Program Calendar"
  let schedEnd = lines.length;
  for (let j = schedStart + 1; j < lines.length; j++) {
    if (
      /^Detailed\s+Information/i.test(lines[j]) ||
      /\bprogram\s+calendar\b/i.test(lines[j])
    ) {
      schedEnd = j;
      break;
    }
  }

  const sectionLines = lines.slice(schedStart, schedEnd);

  // ── Patterns ──────────────────────────────────────────────────────────────
  const WEEK_LINE = /^Week:\s*(.*)$/i;
  const DAY_LINE = /^Day:\s*(.+)$/i;
  const TIME_LINE = /^Time:\s*(.+)$/i;

  // ── Pass 1: Pre-extract per-row meta block ─────────────────────────────────
  // The PDF groups outcomes/late/ext for ALL rows into a block between the
  // first Day: and Time: labels. Extract once and assign to rows by index.
  const metaBlock = extractMetaTriplets(sectionLines);

  // ── Pass 2: Scan Week: anchors and build results ───────────────────────────
  const results: PendingDeadline[] = [];
  let rowIndex = 0;
  let i = 1; // skip the "Assessment Schedule" header line

  while (i < sectionLines.length) {
    const line = sectionLines[i];
    const weekMatch = line.match(WEEK_LINE);

    if (!weekMatch) {
      i++;
      continue;
    }

    const weekStr = (weekMatch[1] ?? "").trim();

    // ── Collect multi-line task title + assessment weight ──────────────────
    const titleParts: string[] = [];
    let foundPercent = false;
    let extractedWeight: number | undefined;

    for (let back = 1; back <= 12 && i - back >= 0; back++) {
      const prev = sectionLines[i - back];
      if (
        WEEK_LINE.test(prev) ||
        /^(Assessment Schedule|Learning Activities)/i.test(prev)
      )
        break;
      if (/^(Day:|Time:)/i.test(prev)) break;

      if (isPercentLine(prev)) {
        foundPercent = true;
        const pct = parseInt((prev.match(/(\d+)\s*%/) ?? [])[1] ?? "0", 10);
        if (pct > 0 && pct <= 100) extractedWeight = pct;
        continue;
      }
      if (!foundPercent && endsWithPercent(prev)) {
        foundPercent = true;
        const pct = parseInt((prev.match(/(\d+)\s*%/) ?? [])[1] ?? "0", 10);
        if (pct > 0 && pct <= 100) extractedWeight = pct;
        const tp = extractTitleFromPercentLine(prev);
        if (tp && !isNoiseLine(tp)) titleParts.unshift(tp);
        continue;
      }
      if (foundPercent) {
        if (!isNoiseLine(prev) && prev.length > 1) titleParts.unshift(prev);
        else if (isNoiseLine(prev) && titleParts.length > 0) break;
      }
    }

    // Fallback: grab non-noise lines immediately above the Week: line
    if (titleParts.length === 0) {
      for (let back = 1; back <= 5 && i - back >= 0; back++) {
        const prev = sectionLines[i - back];
        if (WEEK_LINE.test(prev) || /^Assessment Schedule/i.test(prev)) break;
        if (!isNoiseLine(prev) && !isPercentLine(prev) && prev.length > 2) {
          titleParts.unshift(prev);
          if (titleParts.length >= 3) break;
        }
      }
    }

    const rawTitle = titleParts.join(" ").replace(/\s+/g, " ").trim();
    const title =
      rawTitle
        .replace(/^[,*#\s]+|[,*#\s]+$/g, "")
        // Strip leading item number ("1 Assignment", "3 Final Exam", etc.)
        .replace(/^\d{1,2}\s+/, "")
        // Strip "(x N)" repeat-count annotations — "#" for pre-decode, "\d+" for post-decode
        .replace(/\s*\([x×][\s\d#]*\)\s*/gi, "")
        // Strip " - description" suffix (multi-line PDF titles include clarifying text after the dash)
        .replace(/\s+-\s+.+$/, "")
        .replace(/#/g, "")
        .replace(/\s{2,}/g, " ")
        .trim() || "Unknown task";

    // ── Look ahead for Day: and Time: ─────────────────────────────────────
    // Scan forward to the next Week: (row boundary). Meta values that appear
    // between Day: and Time: are skipped here — already in metaBlock above.
    let exactDay = "";
    let exactTime = "";

    for (let fwd = 1; i + fwd < sectionLines.length; fwd++) {
      const ahead = sectionLines[i + fwd];
      if (WEEK_LINE.test(ahead)) break;

      if (!exactDay) {
        const m = ahead.match(DAY_LINE);
        if (m) {
          exactDay = m[1].trim();
          // Day value may wrap to the next line — stop at Time:, next Week:, noise, or meta
          for (let d = 1; d <= 5 && i + fwd + d < sectionLines.length; d++) {
            const cont = sectionLines[i + fwd + d];
            if (
              TIME_LINE.test(cont) ||
              WEEK_LINE.test(cont) ||
              isNoiseLine(cont)
            )
              break;
            if (isMetaValue(cont)) break;
            exactDay += " " + cont.trim();
          }
          continue;
        }
      }

      if (!exactTime) {
        const m = ahead.match(TIME_LINE);
        if (m) {
          exactTime = m[1].trim();
          break;
        }
      }
    }

    // Attach pre-extracted metadata for this row by position in the section
    const meta: RowMeta = metaBlock[rowIndex] ?? {};
    rowIndex++;

    // ── Date resolution ────────────────────────────────────────────────────
    const parsedExactDate = exactDay ? parseOrdinalDate(exactDay, year) : null;
    const allWeeks = extractAllWeeks(weekStr);
    const noUsableData = allWeeks.length === 0 && !parsedExactDate;
    // An exact calendar date in the Day: field always wins — do not force TBA
    // just because the Week: label is descriptive (e.g. "Study week", "Exam week").
    const isTBA =
      noUsableData ||
      (isTBAValue(weekStr) && allWeeks.length === 0 && !parsedExactDate) ||
      (weekStr === "" && !parsedExactDate) ||
      (exactDay === "" && allWeeks.length === 0) ||
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
          ...meta,
        });
      }
      i++;
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
            if (ampm === "PM" && h < 12) h += 12;
            if (ampm === "AM" && h === 12) h = 0;
            resolvedDate.setHours(h, m, 0, 0);
          }
        }
      }
      if (!resolvedDate && allWeeks.length > 0)
        resolvedDate = weekToDate(
          semester,
          year,
          allWeeks[allWeeks.length - 1],
          0,
        );
    }

    results.push({
      title,
      unit: defaultUnit,
      weekLabel: normalizeWeekLabel(weekStr),
      week: allWeeks.length > 0 ? allWeeks[allWeeks.length - 1] : undefined,
      semester,
      year,
      exactDay: exactDay || undefined,
      exactTime: exactTime || undefined,
      resolvedDate,
      isTBA,
      weight: extractedWeight,
      ...meta,
    });

    i++;
  }

  return results;
}
