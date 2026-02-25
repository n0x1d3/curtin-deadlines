// ── ICS (iCalendar) parser and deadline matcher ───────────────────────────────
// Pure parsing + matching logic. No Chrome APIs, no DOM access.

import type { IcsEvent, IcsMatch, TimetableInfo, Deadline } from '../types';
import { extractSingleWeek } from '../domain/deadlines';
import { weekToDate } from '../utils/getDates';

// ── Keyword list ──────────────────────────────────────────────────────────────

/**
 * Broad keywords used for ICS event confidence boosting — if the same keyword
 * appears in both the ICS event summary and the deadline title, the match is
 * 'high'. Intentionally broad (includes "test", "quiz") for similarity detection.
 */
export const EXAM_KEYWORDS = [
  'exam', 'final', 'test', 'quiz', 'assessment', 'mid-sem', 'mid sem', 'midsem',
];

// ── ICS parsing ───────────────────────────────────────────────────────────────

/**
 * Parse an iCalendar (.ics) text string and return a list of events.
 *
 * Handles three DTSTART formats:
 *   - `DTSTART:20261109T090000Z`                    → UTC datetime
 *   - `DTSTART;TZID=Australia/Perth:20261109T090000` → Perth local (UTC+8, no DST)
 *   - `DTSTART;VALUE=DATE:20261109`                 → all-day date (midnight local)
 */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];

  // Split on VEVENT boundaries — each block is one calendar event
  const blocks = text.split('BEGIN:VEVENT');
  for (let b = 1; b < blocks.length; b++) {
    const block = blocks[b].split('END:VEVENT')[0];
    const lines = block.split(/\r?\n/);

    let summary = '';
    let dtstart: Date | null = null;
    let dtend: Date | undefined;

    for (const rawLine of lines) {
      // Handle iCal line folding: continuation lines start with a space/tab
      const line = rawLine.trimEnd();

      if (line.startsWith('SUMMARY:')) {
        summary = line.slice('SUMMARY:'.length).trim();
      } else if (line.startsWith('DTSTART')) {
        dtstart = parseIcsDate(line);
      } else if (line.startsWith('DTEND')) {
        const parsed = parseIcsDate(line);
        if (parsed) dtend = parsed;
      }
    }

    if (!summary || !dtstart) continue;

    // Extract the first Curtin unit code from the summary (e.g. "COMP1005")
    const unitCodeMatch = /\b([A-Z]{4}\d{4})\b/.exec(summary);

    events.push({
      summary,
      dtstart,
      dtend,
      unitCode: unitCodeMatch?.[1],
    });
  }

  return events;
}

/**
 * Parse a DTSTART or DTEND property line from an iCal block.
 * Returns null if the format is unrecognised.
 *
 * Supported formats:
 *   DTSTART:20261109T090000Z                    → UTC
 *   DTSTART;TZID=Australia/Perth:20261109T090000 → Perth (UTC+8, no DST)
 *   DTSTART;VALUE=DATE:20261109                 → all-day (midnight local)
 */
export function parseIcsDate(line: string): Date | null {
  // Extract the value part (everything after the last colon in the property line)
  const colonIdx = line.lastIndexOf(':');
  if (colonIdx === -1) return null;
  const value = line.slice(colonIdx + 1).trim();

  // UTC datetime: "20261109T090000Z"
  const utcMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (utcMatch) {
    return new Date(
      Date.UTC(
        parseInt(utcMatch[1]),
        parseInt(utcMatch[2]) - 1,
        parseInt(utcMatch[3]),
        parseInt(utcMatch[4]),
        parseInt(utcMatch[5]),
        parseInt(utcMatch[6]),
      ),
    );
  }

  // Local datetime with TZID: "20261109T090000" (Perth = UTC+8, WA has no DST)
  const localMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (localMatch) {
    const isPerth = line.includes('Australia/Perth');
    if (isPerth) {
      // UTC+8 — subtract 8 hours to get UTC
      return new Date(
        Date.UTC(
          parseInt(localMatch[1]),
          parseInt(localMatch[2]) - 1,
          parseInt(localMatch[3]),
          parseInt(localMatch[4]) - 8,
          parseInt(localMatch[5]),
          parseInt(localMatch[6]),
        ),
      );
    }
    // Unknown TZID — treat as local browser time
    return new Date(
      parseInt(localMatch[1]),
      parseInt(localMatch[2]) - 1,
      parseInt(localMatch[3]),
      parseInt(localMatch[4]),
      parseInt(localMatch[5]),
      parseInt(localMatch[6]),
    );
  }

  // All-day date: "20261109"
  const dateOnlyMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnlyMatch) {
    return new Date(
      parseInt(dateOnlyMatch[1]),
      parseInt(dateOnlyMatch[2]) - 1,
      parseInt(dateOnlyMatch[3]),
    );
  }

  return null;
}

// ── Deadline matching ─────────────────────────────────────────────────────────

/**
 * Match ICS events to TBA deadlines using exam keyword scoring.
 *
 * Scoring:
 *   'high': event unitCode matches deadline unit AND summary contains a keyword
 *           that also appears in the deadline title
 *   'low':  event unitCode matches but no keyword overlap
 *
 * Returns at most one match per deadline (the highest-scoring event).
 */
export function matchIcsToDeadlines(events: IcsEvent[], deadlines: Deadline[]): IcsMatch[] {
  // Only consider deadlines where the date is TBA
  const tbaDeadlines = deadlines.filter((d) => d.dateTBA);
  const matches: IcsMatch[] = [];

  for (const deadline of tbaDeadlines) {
    // Find events whose unit code matches this deadline's unit
    const candidates = events.filter(
      (ev) => ev.unitCode?.toUpperCase() === deadline.unit.toUpperCase(),
    );
    if (candidates.length === 0) continue;

    // Score each candidate — prefer events where a keyword appears in both sides
    let bestMatch: IcsEvent | null = null;
    let bestConfidence: 'high' | 'low' = 'low';

    for (const ev of candidates) {
      const evLower    = ev.summary.toLowerCase();
      const titleLower = deadline.title.toLowerCase();

      const keywordInSummary = EXAM_KEYWORDS.some((kw) => evLower.includes(kw));
      const keywordInTitle   = EXAM_KEYWORDS.some((kw) => titleLower.includes(kw));

      const confidence: 'high' | 'low' =
        keywordInSummary && keywordInTitle ? 'high' : 'low';

      // Prefer 'high' over 'low'; take the first high match, or first low if no high
      if (!bestMatch || (confidence === 'high' && bestConfidence === 'low')) {
        bestMatch      = ev;
        bestConfidence = confidence;
      }
    }

    if (bestMatch) {
      matches.push({
        deadlineId:    deadline.id,
        deadlineTitle: deadline.title,
        deadlineUnit:  deadline.unit,
        event:         bestMatch,
        resolvedDate:  bestMatch.dtstart,
        confidence:    bestConfidence,
      });
    }
  }

  return matches;
}

/**
 * Second matching pass: resolve TBA deadlines that reference a specific teaching
 * week and session type (lab, workshop, tutorial, lecture) in their weekLabel.
 *
 * For each TBA deadline:
 *   1. Extract a single week number from weekLabel (ranges → skip).
 *   2. Detect a session-type keyword from title + weekLabel.
 *   3. Extract an optional "N hours after" offset from weekLabel.
 *   4. Compute the Mon–Sun window for that teaching week.
 *   5. Find candidate ICS events for the same unit within that window.
 *   6. Score candidates by session keyword match.
 *   7. Apply the hours offset to get resolvedDate.
 *   8. Build a human-readable matchReason string.
 */
export function matchIcsByWeekAndSession(
  events: IcsEvent[],
  deadlines: Deadline[],
  semester: 1 | 2,
  year: number,
): IcsMatch[] {
  const tbaDeadlines = deadlines.filter((d) => d.dateTBA);
  const matches: IcsMatch[] = [];

  // Session-type keyword groups — first match in each group wins
  const SESSION_TYPES: { keys: string[]; tag: string }[] = [
    { keys: ['lab', 'laboratory', 'practical', 'prac'], tag: 'lab' },
    { keys: ['workshop'],                               tag: 'workshop' },
    { keys: ['tutorial', 'tut'],                        tag: 'tutorial' },
    { keys: ['lecture', 'lect'],                        tag: 'lecture' },
  ];

  for (const deadline of tbaDeadlines) {
    const weekLabelLower = (deadline.weekLabel ?? '').toLowerCase();
    const titleLower     = deadline.title.toLowerCase();

    // Step A: extract a single teaching week number — ranges and "Fortnightly" → skip
    const week = extractSingleWeek(deadline.weekLabel);
    if (week === null) continue;

    // Step B: detect session type from title and/or weekLabel
    let sessionTag: string | null = null;
    for (const { keys, tag } of SESSION_TYPES) {
      const inTitle     = keys.some((k) => titleLower.includes(k));
      const inWeekLabel = keys.some((k) => weekLabelLower.includes(k));
      if (inTitle || inWeekLabel) {
        sessionTag = tag;
        break;
      }
    }

    // Step C: extract "N hours after" offset from weekLabel
    const hoursMatch = /(\d+)\s*hours?\s*(after|following)/i.exec(deadline.weekLabel ?? '');
    const hoursAfter = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;

    // Step D: compute the Mon–Sun window for this teaching week
    const weekStart = weekToDate(semester, year, week, 0); // Monday 00:00 local
    const weekEnd   = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6); // advance to Sunday
    weekEnd.setHours(23, 59, 59, 999);

    // Step E: find candidate ICS events within the week window for this unit
    const candidates = events.filter((ev) => {
      if (ev.unitCode?.toUpperCase() !== deadline.unit.toUpperCase()) return false;
      return ev.dtstart >= weekStart && ev.dtstart <= weekEnd;
    });
    if (candidates.length === 0) continue;

    // Step F: score candidates by session type; sort highest score then earliest time
    type Scored = { ev: IcsEvent; score: number };
    const scored: Scored[] = candidates.map((ev) => {
      const evLower = ev.summary.toLowerCase();
      const hasTag  = sessionTag
        ? SESSION_TYPES.find((s) => s.tag === sessionTag)!.keys.some((k) =>
            evLower.includes(k),
          )
        : false;
      return { ev, score: hasTag ? 1 : 0 };
    });

    scored.sort((a, b) => b.score - a.score || a.ev.dtstart.getTime() - b.ev.dtstart.getTime());
    const best      = scored[0].ev;
    const bestScore = scored[0].score;

    // Step G: compute resolvedDate with optional hours offset
    const resolvedDate = new Date(best.dtstart.getTime());
    if (hoursAfter > 0) {
      resolvedDate.setTime(resolvedDate.getTime() + hoursAfter * 3_600_000);
    }

    // Step H: build a human-readable match reason
    let matchReason: string;
    if (sessionTag && hoursAfter > 0) {
      matchReason = `${hoursAfter}h after Week ${week} ${sessionTag}`;
    } else if (sessionTag) {
      matchReason = `Week ${week} ${sessionTag}`;
    } else {
      matchReason = `Week ${week} class`;
    }

    // 'high' only when a session keyword matched the event summary; 'low' otherwise
    const confidence: 'high' | 'low' = sessionTag && bestScore === 1 ? 'high' : 'low';

    matches.push({
      deadlineId:    deadline.id,
      deadlineTitle: deadline.title,
      deadlineUnit:  deadline.unit,
      event:         best,
      resolvedDate,
      confidence,
      matchReason,
    });
  }

  return matches;
}

// ── Timetable analysis ────────────────────────────────────────────────────────

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
  const units = [...new Set(
    events.map((e) => e.unitCode).filter((c): c is string => !!c),
  )].sort();

  // Find the earliest event date to infer semester and year
  const earliest = events.reduce<Date | null>(
    (min, e) => (!min || e.dtstart < min ? e.dtstart : min),
    null,
  ) ?? new Date();

  const year  = earliest.getFullYear();
  const month = earliest.getMonth() + 1; // 1-based

  // Semester 1 runs Feb–Jun, Semester 2 runs Jul–Nov
  const semester: 1 | 2 = month >= 2 && month <= 6 ? 1 : 2;

  return { units, semester, year };
}
