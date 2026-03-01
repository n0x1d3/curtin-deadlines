import type { PendingDeadline } from "../types";
import { weekToDate } from "../utils/getDates";
import { parseAsTask } from "./parseAsTask";
import { parsePcText, buildWeekHints } from "./parsePcText";

/** Key fields from UobOutline in the ScreenDataSetGetNew response. */
export interface UobOutline {
  UnitNumber: string; // e.g. "COMP1005"
  Title: string; // e.g. "Fundamentals of Programming"
  Avail_Study_Period: string; // e.g. "Semester 1"
  Avail_Year: string; // e.g. "2026"
  AS_TASK: string; // pipe-delimited assessment list
  PC_TEXT: string; // HTML table with week-by-week calendar
}

/**
 * Returns true if two assessment titles likely refer to the same assessment.
 * Uses first-word prefix matching, normalized exact matching, and compact
 * single-word matching for concise titles.
 */
function titlesOverlap(a: string, b: string): boolean {
  const words = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^a-z]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3);

  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return false;

  const [firstA] = wa;
  const [firstB] = wb;
  if (firstA.startsWith(firstB) || firstB.startsWith(firstA)) return true;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  if (norm(a) === norm(b)) return true;

  const shortWords = wa.length <= wb.length ? wa : wb;
  const longWords = wa.length <= wb.length ? wb : wa;
  if (shortWords.length === 1 && shortWords[0].length >= 4) {
    if (longWords.length > 2) return false;
    const key = shortWords[0];
    return longWords.some((w) => w.startsWith(key) || key.startsWith(w));
  }

  return false;
}

/**
 * Converts a UobOutline API object into an array of PendingDeadline items.
 * PC_TEXT is the primary dated source; AS_TASK provides full coverage fallback.
 */
export function outlineToDeadlines(
  outline: UobOutline,
  unitCode: string,
  semester: 1 | 2,
  year: number,
): PendingDeadline[] {
  const unitName = outline.Title;

  const pcItems = parsePcText(outline.PC_TEXT, unitCode, semester, year);
  for (const item of pcItems) {
    item.unitName = unitName;
  }

  const asItems = parseAsTask(outline.AS_TASK);
  const { hints: weekHints, weekDates } = buildWeekHints(outline.PC_TEXT, year);

  for (const asItem of asItems) {
    const matched = pcItems.filter((pc) =>
      titlesOverlap(pc.title, asItem.title),
    );

    if (matched.length > 0) {
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
      continue;
    }

    let hintWeek: number | undefined;
    for (const [hintTitle, weekNum] of weekHints) {
      if (titlesOverlap(hintTitle, asItem.title)) {
        hintWeek = weekNum;
        break;
      }
    }

    const hintWeekLabel =
      hintWeek !== undefined ? `Week ${hintWeek}` : undefined;
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
      isTBA: hintResolvedDate === undefined,
      resolvedDate: hintResolvedDate,
      weight: asItem.weight,
      outcomes: asItem.outcomes,
      weekLabel: hintWeekLabel,
    });
  }

  return pcItems;
}

export { parseAsTask } from "./parseAsTask";
export { parsePcText } from "./parsePcText";
