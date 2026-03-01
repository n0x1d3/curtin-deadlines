// ── ICS calendar export ───────────────────────────────────────────────────────
// Converts stored deadlines to a .ics file and triggers a download via the
// background service worker (which has access to the chrome.downloads API).

import type { EventAttributes } from "ics";
import { createEvents } from "ics";

import { command } from "../types";
import { loadDeadlines } from "../storage";
import { defaultYear } from "../utils/format";

/**
 * Convert all stored deadlines to ICS EventAttributes and download the file.
 *
 * All-day event: when dueDate is at midnight (no specific time provided).
 * Timed event: when dueDate has a non-midnight time component.
 *
 * Reminders (VALARM):
 *   - 3 days before → "Unit — Task due in 3 days"
 *   - 1 day before
 *   - 1 hour before (timed events only)
 */
export async function exportICS(): Promise<void> {
  const deadlines = await loadDeadlines();
  if (deadlines.length === 0) return;

  const events: EventAttributes[] = deadlines.map((d) => {
    const due = new Date(d.dueDate);
    const hasTime = due.getHours() !== 0 || due.getMinutes() !== 0;

    // Build VALARM alarms — always include 3-day and 1-day reminders
    const alarms: EventAttributes["alarms"] = [
      {
        action: "display",
        description: `${d.unit} — ${d.title} due in 3 days`,
        trigger: { before: true, days: 3 },
      },
      {
        action: "display",
        description: `${d.unit} — ${d.title} due tomorrow`,
        trigger: { before: true, days: 1 },
      },
    ];

    // Add 1-hour reminder only for timed events (not all-day)
    if (hasTime) {
      alarms.push({
        action: "display",
        description: `${d.unit} — ${d.title} due in 1 hour`,
        trigger: { before: true, hours: 1 },
      });
    }

    if (hasTime) {
      // Timed event: start = [year, month, day, hour, minute]
      const event: EventAttributes = {
        title: `${d.unit} — ${d.title}`,
        start: [
          due.getFullYear(),
          due.getMonth() + 1,
          due.getDate(),
          due.getHours(),
          due.getMinutes(),
        ],
        startOutputType: "local",
        duration: { hours: 1 },
        description: d.weekLabel
          ? `${d.weekLabel}\n${d.unit} — ${d.title}`
          : `${d.unit} — ${d.title}`,
        status: "CONFIRMED",
        busyStatus: "BUSY",
        alarms,
      };
      return event;
    } else {
      // All-day event: start = [year, month, day]
      const event: EventAttributes = {
        title: `${d.unit} — ${d.title}`,
        start: [due.getFullYear(), due.getMonth() + 1, due.getDate()],
        duration: { days: 1 },
        description: d.weekLabel
          ? `${d.weekLabel}\n${d.unit} — ${d.title}`
          : `${d.unit} — ${d.title}`,
        status: "CONFIRMED",
        busyStatus: "FREE",
        alarms,
      };
      return event;
    }
  });

  const { error, value } = createEvents(events);

  if (error || !value) {
    console.error("ICS generation error:", error);
    return;
  }

  // Build a meaningful filename using the current year
  const year = defaultYear();
  const filename = `Curtin Deadlines ${year}.ics`;

  // Ask the background service worker to trigger the download
  chrome.runtime.sendMessage({ command: command.downloadICS, value, filename });
}
