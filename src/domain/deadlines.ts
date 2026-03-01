// ── Deadline domain logic ─────────────────────────────────────────────────────
// Pure functions for classifying, filtering, sorting, and grouping deadlines.
// No Chrome APIs, no DOM access — all inputs and outputs are plain data.

import type { Deadline } from "../types";

// ── Series / week utilities ───────────────────────────────────────────────────

/**
 * Derive the series group key for a deadline.
 * Titles ending in " N" (space + number) share a key; e.g. "Practical Test 1"
 * and "Practical Test 3" both map to "COMP1005|Practical Test".
 * Non-numbered titles form singleton keys so they never accidentally merge.
 */
export function seriesKey(unit: string, title: string): string {
  if (/\s+\d+$/.test(title)) {
    return `${unit}|${title.replace(/\s+\d+$/, "").trim()}`;
  }
  return `${unit}|${title}`;
}

/**
 * Parse a free-text week input into an array of individual week numbers.
 *   "5"        → [5]
 *   "5-7"      → [5, 6, 7]     (inclusive range)
 *   "1,3,5,7"  → [1, 3, 5, 7] (comma-separated)
 * All values are clamped to 1–20 (maximum sane semester length).
 */
export function parseWeekInput(raw: string): number[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Detect a simple range like "1-13" or "1–13" (no commas)
  const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    const weeks: number[] = [];
    for (let w = Math.min(start, end); w <= Math.max(start, end); w++) {
      if (w >= 1 && w <= 20) weeks.push(w);
    }
    return weeks;
  }

  // Comma/space-separated list (or a single plain number)
  return trimmed
    .split(/[\s,]+/)
    .map((p) => parseInt(p.trim(), 10))
    .filter((w) => !isNaN(w) && w >= 1 && w <= 20);
}

// ── Deadline classification ───────────────────────────────────────────────────

/**
 * Returns true only when the title represents a FINAL EXAM scheduled in the
 * official exam period. In-semester assessments return false.
 *
 * Examples:
 *   "Final Examination" → true    "Mid-Semester Test" → false
 *   "Examination"       → true    "Online Test"       → false
 *   "Final Exam"        → true    "Practical Test"    → false
 */
export function isFinalExamType(title: string): boolean {
  const lower = title.toLowerCase();
  // In-semester disqualifiers — these are never scheduled in the exam period
  if (
    /\b(mid[\s-]?sem(ester)?|midterm|prac(tical)?\b|lab\b|quiz\b|worksheet|workshop|tutorial|tut\b|online\s+test|weekly|e-?test|midsem)\b/.test(
      lower,
    )
  )
    return false;
  // "final" signals end-of-semester regardless of the noun that follows
  if (/\bfinal\b/.test(lower)) return true;
  // Standalone "exam" or "examination" without any in-semester qualifier
  return /\b(exam|examination)\b/.test(lower);
}

/**
 * Extract a single teaching week number from a weekLabel string.
 * Returns null when no single week is found (ranges like "Weeks 2–12", blank, etc.).
 *
 *   "Week 7"                          → 7
 *   "During Week 5 lab"               → 5
 *   "Teaching weeks 2-12"             → null  (plural "weeks" doesn't match)
 *   "Fortnightly"                     → null
 */
export function extractSingleWeek(
  weekLabel: string | undefined,
): number | null {
  if (!weekLabel) return null;
  const m = /\bweek\s+(\d{1,2})\b/i.exec(weekLabel);
  return m ? parseInt(m[1], 10) : null;
}

// ── Deadline grouping ─────────────────────────────────────────────────────────

/** A labelled group of deadlines for rendering as a section in the list. */
export interface DeadlineSection {
  label: string | null;
  items: Deadline[];
}

/**
 * Filter, sort, and group a deadline array ready for rendering.
 *
 * Returns:
 *   sections — labelled groups in display order (TBA sub-groups → upcoming → overdue)
 *   display  — flat array of all included items (used for the filter-empty check)
 */
export function buildDeadlineSections(
  deadlines: Deadline[],
  opts: {
    filterUnit: string;
    filterStatus: "all" | "upcoming" | "overdue" | "tba";
    sortBy: "date" | "unit";
    overduePosition: "top" | "bottom";
  },
): { sections: DeadlineSection[]; display: Deadline[] } {
  const now = new Date();
  let display = deadlines;

  // ── Apply unit filter ───────────────────────────────────────────────────────
  if (opts.filterUnit) {
    display = display.filter((d) => d.unit === opts.filterUnit);
  }

  // ── Apply status filter ─────────────────────────────────────────────────────
  if (opts.filterStatus === "upcoming") {
    display = display.filter((d) => !d.dateTBA && new Date(d.dueDate) > now);
  } else if (opts.filterStatus === "tba") {
    display = display.filter((d) => !!d.dateTBA);
  } else if (opts.filterStatus === "overdue") {
    display = display.filter((d) => !d.dateTBA && new Date(d.dueDate) <= now);
  }

  // ── Split TBA items into three sub-groups ───────────────────────────────────
  const allTba = display.filter((d) => d.dateTBA);

  // Exam-type TBAs: date depends on the official exam timetable release
  const examTba = allTba.filter((d) => isFinalExamType(d.title));

  // Week-known TBAs: weekLabel has a single parseable week (and not a final exam)
  const weekKnownTba = allTba.filter(
    (d) => !isFinalExamType(d.title) && extractSingleWeek(d.weekLabel) !== null,
  );

  // Fully unknown TBAs: no week info and not a final exam
  const fullyTba = allTba.filter(
    (d) => !isFinalExamType(d.title) && extractSingleWeek(d.weekLabel) === null,
  );

  const upcoming = display.filter(
    (d) => !d.dateTBA && new Date(d.dueDate) > now,
  );
  const overdue = display.filter(
    (d) => !d.dateTBA && new Date(d.dueDate) <= now,
  );

  // ── Sort each group ─────────────────────────────────────────────────────────
  // Exam TBAs sorted by unit (predictable order — exam timetable determines actual date)
  examTba.sort((a, b) => a.unit.localeCompare(b.unit));

  if (opts.sortBy === "unit") {
    weekKnownTba.sort((a, b) => {
      const wa = extractSingleWeek(a.weekLabel) ?? 99;
      const wb = extractSingleWeek(b.weekLabel) ?? 99;
      return wa - wb || a.unit.localeCompare(b.unit);
    });
    fullyTba.sort((a, b) => a.unit.localeCompare(b.unit));
    upcoming.sort(
      (a, b) =>
        a.unit.localeCompare(b.unit) || a.dueDate.localeCompare(b.dueDate),
    );
    overdue.sort(
      (a, b) =>
        a.unit.localeCompare(b.unit) || a.dueDate.localeCompare(b.dueDate),
    );
  } else {
    // Date sort — week-known TBAs sorted by week number so earlier weeks appear first
    weekKnownTba.sort((a, b) => {
      const wa = extractSingleWeek(a.weekLabel) ?? 99;
      const wb = extractSingleWeek(b.weekLabel) ?? 99;
      return wa - wb || a.unit.localeCompare(b.unit);
    });
    fullyTba.sort((a, b) => a.unit.localeCompare(b.unit));
    upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  // ── Build ordered section list ──────────────────────────────────────────────
  // Section labels are only shown when there are multiple TBA sub-groups present
  const tbaSectionCount = [examTba, weekKnownTba, fullyTba].filter(
    (g) => g.length > 0,
  ).length;
  const showTbaLabels = tbaSectionCount > 1;

  const sections: DeadlineSection[] = [];

  if (examTba.length > 0) {
    sections.push({
      label: showTbaLabels ? "Exam period · date TBC" : null,
      items: examTba,
    });
  }
  if (weekKnownTba.length > 0) {
    sections.push({
      label: showTbaLabels ? "Week scheduled · date TBC" : null,
      items: weekKnownTba,
    });
  }
  if (fullyTba.length > 0) {
    sections.push({
      label: showTbaLabels ? "Date unknown" : null,
      items: fullyTba,
    });
  }

  // Overdue position (top/bottom) is a user preference
  if (opts.overduePosition === "top" && overdue.length > 0) {
    sections.push({ label: null, items: overdue });
  }
  if (upcoming.length > 0) {
    sections.push({ label: null, items: upcoming });
  }
  if (opts.overduePosition !== "top" && overdue.length > 0) {
    sections.push({ label: null, items: overdue });
  }

  return { sections, display: sections.flatMap((s) => s.items) };
}
