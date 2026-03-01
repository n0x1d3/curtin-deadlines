import type { IcsEvent, IcsMatch, Deadline } from "../types";
import { extractSingleWeek } from "../domain/deadlines";
import { weekToDate } from "../utils/getDates";
import { EXAM_KEYWORDS } from "./detectTimetable";

/** Minimum score considered 'high' confidence for exam keyword matching. */
const HIGH = 2;

/**
 * Returns a keyword-overlap score for an (event, deadline) pair.
 * 0 = no keyword overlap, 1 = one-sided keyword, HIGH (2) = both sides match.
 * Used by both matchIcsToDeadlines and matchIcsDatedConflicts.
 */
function scoreEvent(ev: IcsEvent, deadline: Deadline): number {
  const evLower = ev.summary.toLowerCase();
  const titleLower = deadline.title.toLowerCase();
  const keywordInSummary = EXAM_KEYWORDS.some((kw) => evLower.includes(kw));
  const keywordInTitle = EXAM_KEYWORDS.some((kw) => titleLower.includes(kw));
  if (keywordInSummary && keywordInTitle) return HIGH;
  if (keywordInSummary || keywordInTitle) return 1;
  return 0;
}

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
export function matchIcsToDeadlines(
  events: IcsEvent[],
  deadlines: Deadline[],
): IcsMatch[] {
  // Only consider deadlines where the date is TBA
  const tbaDeadlines = deadlines.filter((d) => d.dateTBA);
  const matches: IcsMatch[] = [];

  for (const deadline of tbaDeadlines) {
    // Find events whose unit code matches this deadline's unit
    const candidates = events.filter(
      (ev) => ev.unitCode?.toUpperCase() === deadline.unit.toUpperCase(),
    );
    if (candidates.length === 0) continue;

    // Score each candidate via shared helper — prefer highest score, first wins on tie
    let bestMatch: IcsEvent | null = null;
    let bestScore = -1;

    for (const ev of candidates) {
      const s = scoreEvent(ev, deadline);
      if (!bestMatch || s > bestScore) {
        bestMatch = ev;
        bestScore = s;
      }
    }

    if (bestMatch) {
      matches.push({
        deadlineId: deadline.id,
        deadlineTitle: deadline.title,
        deadlineUnit: deadline.unit,
        event: bestMatch,
        resolvedDate: bestMatch.dtstart,
        confidence: bestScore >= HIGH ? "high" : "low",
      });
    }
  }

  return matches;
}

/**
 * Match ICS events against deadlines that already have a concrete date
 * (!dateTBA). Returns only matches where the proposed date differs from
 * the saved date by more than 1 hour, indicating a potential time update.
 *
 * Used to surface "the ICS has a different time for this exam" conflicts
 * without silently overwriting existing data.
 */
export function matchIcsDatedConflicts(
  events: IcsEvent[],
  deadlines: Deadline[],
): IcsMatch[] {
  const datedDeadlines = deadlines.filter((d) => !d.dateTBA);
  const matches: IcsMatch[] = [];

  for (const deadline of datedDeadlines) {
    const candidates = events.filter(
      (ev) => ev.unitCode?.toUpperCase() === deadline.unit.toUpperCase(),
    );
    if (candidates.length === 0) continue;

    // Pick the highest-scoring candidate; skip if no keyword overlap (score stays 0)
    let best: IcsEvent | null = null;
    let bestScore = 0;

    for (const ev of candidates) {
      const s = scoreEvent(ev, deadline);
      if (s > bestScore) {
        bestScore = s;
        best = ev;
      }
    }

    // Skip if no meaningful keyword overlap found
    if (!best || bestScore === 0) continue;

    // Only surface as a conflict when the dates actually differ by more than 1 hour
    const existingDate = new Date(deadline.dueDate);
    const diffMs = Math.abs(best.dtstart.getTime() - existingDate.getTime());
    if (diffMs <= 60 * 60 * 1000) continue;

    matches.push({
      deadlineId: deadline.id,
      deadlineTitle: deadline.title,
      deadlineUnit: deadline.unit,
      event: best,
      resolvedDate: best.dtstart,
      confidence: bestScore >= HIGH ? "high" : "low",
      isConflict: true,
      existingDate,
    });
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
    { keys: ["lab", "laboratory", "practical", "prac"], tag: "lab" },
    { keys: ["workshop"], tag: "workshop" },
    { keys: ["tutorial", "tut"], tag: "tutorial" },
    { keys: ["lecture", "lect"], tag: "lecture" },
  ];

  for (const deadline of tbaDeadlines) {
    const weekLabelLower = (deadline.weekLabel ?? "").toLowerCase();
    const titleLower = deadline.title.toLowerCase();

    // Step A: extract a single teaching week number — ranges and "Fortnightly" → skip
    const week = extractSingleWeek(deadline.weekLabel);
    if (week === null) continue;

    // Step B: detect session type from title and/or weekLabel
    let sessionTag: string | null = null;
    for (const { keys, tag } of SESSION_TYPES) {
      const inTitle = keys.some((k) => titleLower.includes(k));
      const inWeekLabel = keys.some((k) => weekLabelLower.includes(k));
      if (inTitle || inWeekLabel) {
        sessionTag = tag;
        break;
      }
    }

    // Step C: extract "N hours after" offset from weekLabel
    const hoursMatch = /(\d+)\s*hours?\s*(after|following)/i.exec(
      deadline.weekLabel ?? "",
    );
    const hoursAfter = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;

    // Step D: compute the Mon–Sun window for this teaching week
    const weekStart = weekToDate(semester, year, week, 0); // Monday 00:00 local
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6); // advance to Sunday
    weekEnd.setHours(23, 59, 59, 999);

    // Step E: find candidate ICS events within the week window for this unit
    const candidates = events.filter((ev) => {
      if (ev.unitCode?.toUpperCase() !== deadline.unit.toUpperCase())
        return false;
      return ev.dtstart >= weekStart && ev.dtstart <= weekEnd;
    });
    if (candidates.length === 0) continue;

    // Step F: score candidates by session type; sort highest score then earliest time
    type Scored = { ev: IcsEvent; score: number };
    const scored: Scored[] = candidates.map((ev) => {
      const evLower = ev.summary.toLowerCase();
      const hasTag = sessionTag
        ? SESSION_TYPES.find((s) => s.tag === sessionTag)!.keys.some((k) =>
            evLower.includes(k),
          )
        : false;
      return { ev, score: hasTag ? 1 : 0 };
    });

    scored.sort(
      (a, b) =>
        b.score - a.score || a.ev.dtstart.getTime() - b.ev.dtstart.getTime(),
    );
    const best = scored[0].ev;
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
    const confidence: "high" | "low" =
      sessionTag && bestScore === 1 ? "high" : "low";

    matches.push({
      deadlineId: deadline.id,
      deadlineTitle: deadline.title,
      deadlineUnit: deadline.unit,
      event: best,
      resolvedDate,
      confidence,
      matchReason,
    });
  }

  return matches;
}
