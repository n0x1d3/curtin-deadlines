import type { IcsEvent } from "../types";

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
  const blocks = text.split("BEGIN:VEVENT");
  for (let b = 1; b < blocks.length; b++) {
    const block = blocks[b].split("END:VEVENT")[0];
    const lines = block.split(/\r?\n/);

    let summary = "";
    let dtstart: Date | null = null;
    let dtend: Date | undefined;

    for (const rawLine of lines) {
      // Handle iCal line folding: continuation lines start with a space/tab
      const line = rawLine.trimEnd();

      if (line.startsWith("SUMMARY:")) {
        summary = line.slice("SUMMARY:".length).trim();
      } else if (line.startsWith("DTSTART")) {
        dtstart = parseIcsDate(line);
      } else if (line.startsWith("DTEND")) {
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
  const colonIdx = line.lastIndexOf(":");
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
  const localMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(
    value,
  );
  if (localMatch) {
    const isPerth = line.includes("Australia/Perth");
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
