// ── PDF module barrel ────────────────────────────────────────────────────────
// Re-exports all public symbols from the pdf/ submodules, plus the small
// merge/sequence utilities that tie assessment + calendar results together.

import type { PendingDeadline } from "../types";

export { initPdfWorker, parseUnitName, extractPDFText } from "./extract";
export { parseAssessments } from "./parseAssessments";
export { parseProgramCalendar } from "./parseProgramCalendar";

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
    s
      .replace(/\bSem\b/gi, "Semester")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  /**
   * True if `shorter` matches `longer` up to a single consecutive gap of 1–3
   * characters that start with 'f' or 's'. This covers PDF ligature glyphs
   * (fl, fi, ff, ffi, ffl, st) that were encoded as null bytes and lost during
   * extraction — e.g. "reection" matches "reflection" (gap = "fl" at pos 2).
   * The gap-start constraint ('f'/'s') prevents spurious matches like
   * "testquiz" matching "testandquiz" (gap = "and", not a ligature).
   */
  const ligatureMatch = (shorter: string, longer: string): boolean => {
    const gap = longer.length - shorter.length;
    if (gap < 1 || gap > 3) return false;
    for (let pos = 0; pos <= shorter.length; pos++) {
      const gapChars = longer.slice(pos, pos + gap);
      if (!/^[fs]/.test(gapChars)) continue;
      if (
        longer.slice(0, pos) === shorter.slice(0, pos) &&
        longer.slice(pos + gap) === shorter.slice(pos)
      )
        return true;
    }
    return false;
  };

  const titlesMatch = (a: string, b: string): boolean => {
    const na = norm(a),
      nb = norm(b);
    if (
      na === nb ||
      na.startsWith(nb) ||
      nb.startsWith(na) ||
      na.includes(nb) ||
      nb.includes(na)
    )
      return true;
    // Ligature-gap fuzzy match for PDF null-byte ligatures (fl, fi, ff, etc.)
    const [sh, lo] = na.length <= nb.length ? [na, nb] : [nb, na];
    return ligatureMatch(sh, lo);
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
      // No TBA match — skip if a resolved item already covers this week + title.
      // Also consider dates within 3 days as the same deadline (handles the case where
      // the schedule's exact due date falls on the last day of a week while the program
      // calendar places the same item in the following week, e.g. Sunday May 3 vs Mon May 4).
      const THREE_DAYS_MS = 3 * 86_400_000;
      const resolvedDup = merged.some((s) => {
        if (s.isTBA || !titlesMatch(s.title, calItem.title)) return false;
        if (!s.week || s.week === calItem.week) return true;
        if (s.resolvedDate && calItem.resolvedDate) {
          return (
            Math.abs(
              s.resolvedDate.getTime() - calItem.resolvedDate.getTime(),
            ) <= THREE_DAYS_MS
          );
        }
        return false;
      });
      if (!resolvedDup) {
        // Inherit weight (and meta) from a schedule item with matching title.
        // titlesMatch handles exact/prefix/ligature cases.
        // sharedKeyword handles cases where the calendar uses a sub-title that
        // differs from the schedule's broader title — e.g. "Lab A Report" is a
        // component of "Technical report writing and professional attributes";
        // both share the 5-char keyword "report".
        const sharedKeyword = (a: string, b: string): boolean => {
          const words = (s: string) =>
            s
              .toLowerCase()
              .replace(/[^a-z ]/g, "")
              .split(/\s+/)
              .filter((w) => w.length >= 5);
          const wa = words(a);
          return wa.some((w) => words(b).includes(w));
        };
        const proto = merged.find(
          (s) =>
            (titlesMatch(s.title, calItem.title) ||
              sharedKeyword(s.title, calItem.title)) &&
            s.weight !== undefined,
        );
        merged.push(
          proto
            ? {
                ...calItem,
                weight: proto.weight,
                outcomes: proto.outcomes,
                lateAccepted: proto.lateAccepted,
                extensionConsidered: proto.extensionConsidered,
              }
            : calItem,
        );
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
export function addSequenceNumbers(
  items: PendingDeadline[],
): PendingDeadline[] {
  function baseTitle(t: string): string {
    return t
      .replace(/\s*[-–—]\s+\S.*$/, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const normKey = (unit: string, t: string) =>
    `${unit}|${baseTitle(t).toLowerCase().replace(/\s+/g, " ")}`;

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
