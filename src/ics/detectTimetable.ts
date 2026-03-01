import type { IcsEvent, TimetableInfo, TimetableSession } from "../types";

/**
 * Broad keywords used for ICS event confidence boosting — if the same keyword
 * appears in both the ICS event summary and the deadline title, the match is
 * 'high'. Intentionally broad (includes "test", "quiz") for similarity detection.
 */
export const EXAM_KEYWORDS = [
  "exam",
  "final",
  "test",
  "quiz",
  "assessment",
  "mid-sem",
  "mid sem",
  "midsem",
];

/**
 * Analyse parsed ICS events to detect whether they represent a Curtin class
 * timetable, and if so, which unit codes and semester/year are involved.
 *
 * Unit codes are extracted from SUMMARY fields.
 * Semester is inferred from the month of the earliest event:
 *   Feb–Jun → Semester 1,  Jul–Nov → Semester 2 (everything else defaults to 2).
 */
export function detectTimetableUnits(events: IcsEvent[]): TimetableInfo {
  // Collect unique unit codes across all events
  const units = [
    ...new Set(events.map((e) => e.unitCode).filter((c): c is string => !!c)),
  ].sort();

  // Find the earliest event date to infer semester and year
  const earliest =
    events.reduce<Date | null>(
      (min, e) => (!min || e.dtstart < min ? e.dtstart : min),
      null,
    ) ?? new Date();

  const year = earliest.getFullYear();
  const month = earliest.getMonth() + 1; // 1-based

  // Semester 1 runs Feb–Jun, Semester 2 runs Jul–Nov
  const semester: 1 | 2 = month >= 2 && month <= 6 ? 1 : 2;

  return { units, semester, year };
}

const SESSION_TYPE_KEYWORDS = [
  "lab",
  "laboratory",
  "tutorial",
  "workshop",
  "lecture",
  "practical",
  "seminar",
] as const;

/**
 * Convert a calendar date to a semester week number (1-based).
 * Returns null if the date is outside the semester.
 */
function dateToSemesterWeek(date: Date, semStart: Date): number | null {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const diff = date.getTime() - semStart.getTime();
  if (diff < 0) return null;
  const week = Math.floor(diff / msPerWeek) + 1;
  return week >= 1 && week <= 20 ? week : null;
}

/**
 * Extract recurring session info (unit + type + day-of-week + weeks) from timetable events.
 * Groups by unit + type, collecting all occurrence weeks and using the most common day.
 * Used to pre-fill week inputs and day offsets for recurring assessments.
 */
export function extractTimetableSessions(
  events: IcsEvent[],
): TimetableSession[] {
  // Detect semester start from the earliest event (mirrors detectTimetableUnits logic)
  const earliest = events.reduce<Date | null>(
    (min, e) => (!min || e.dtstart < min ? e.dtstart : min),
    null,
  );
  if (!earliest) return [];

  // Find the semester start by walking from the earliest event back to Monday of that week
  const semStart = new Date(earliest);
  while (semStart.getDay() !== 1) semStart.setDate(semStart.getDate() - 1); // back to Monday
  // Walk back further to week 1 — use the first Monday on or after the semester's nominal start
  // Simplest: treat the Monday of the earliest event as week 1 reference and offset from there
  // Instead, find the true week 1 Monday by going to the earliest event's week and subtracting
  // weeks until we hit the semester start month boundary.
  // Practical approach: find the Monday of the earliest timetable week.
  const minEventMonday = new Date(earliest);
  while (minEventMonday.getDay() !== 1)
    minEventMonday.setDate(minEventMonday.getDate() - 1);

  // Accumulate per unit+type: { dayOfWeek, weeks[] }
  const map = new Map<string, { dayOfWeek: number; weeks: number[] }>();

  for (const event of events) {
    if (!event.unitCode) continue;
    const summary = event.summary.toLowerCase();
    const type = SESSION_TYPE_KEYWORDS.find((k) => summary.includes(k));
    if (!type) continue;

    const key = `${event.unitCode}::${type}`;
    const dayOfWeek = (event.dtstart.getDay() + 6) % 7; // JS 0=Sun → 0=Mon

    // Calculate week number relative to the earliest timetable Monday (= week 1)
    const week = dateToSemesterWeek(event.dtstart, minEventMonday);
    if (week === null) continue;

    if (!map.has(key)) {
      map.set(key, { dayOfWeek, weeks: [] });
    }
    const entry = map.get(key)!;
    if (!entry.weeks.includes(week)) entry.weeks.push(week);
  }

  const sessions: TimetableSession[] = [];
  for (const [key, { dayOfWeek, weeks }] of map) {
    const [unit, type] = key.split("::");
    sessions.push({
      unit,
      type,
      dayOfWeek,
      weeks: weeks.sort((a, b) => a - b),
    });
  }
  return sessions;
}
