/**
 * Extract ALL week numbers from a string like "Teaching weeks 2,3,...,12"
 * or "Weeks 1-13". Returns a sorted, deduplicated array of valid week numbers.
 */
export function extractAllWeeks(s: string): number[] {
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

/**
 * Normalise a raw week string from the PDF into a consistent "Week N" /
 * "Weeks N–M" label. Strips null-byte placeholders, collapses whitespace,
 * then prefixes "Week"/"Weeks" if the value is purely numeric.
 * Returns undefined for empty / TBA values.
 */
export function normalizeWeekLabel(raw: string): string | undefined {
  const s = raw
    .replace(/#/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!s) return undefined;
  // Already has a "week" prefix (e.g. "Week 13", "Study week", "Exam week")
  if (/\bweek\b/i.test(s)) return s;
  // "Examination" / "Exam" alone → "Exam week" for consistency
  if (/\bexam(ination)?\b/i.test(s)) return "Exam week";
  // Range: "13-15" or "13–15" → "Weeks 13–15"
  const range = s.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
  if (range) return `Weeks ${range[1]}–${range[2]}`;
  // Plain number: "13" → "Week 13"
  if (/^\d{1,2}$/.test(s)) return `Week ${s}`;
  // Anything else (e.g. "Study break") — return as-is
  return s;
}
