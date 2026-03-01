// ── ICS import section wiring ────────────────────────────────────────────────
// Handles: .ics file parsing, timetable unit detection, exam-date matching,
// unit auto-fetch via Outline API, and applying resolved dates to TBA deadlines.

import type { TimetableInfo, IcsMatch, PendingDeadline } from "../types";
import {
  parseIcs,
  matchIcsToDeadlines,
  matchIcsByWeekAndSession,
  matchIcsDatedConflicts,
  detectTimetableUnits,
  extractTimetableSessions,
} from "../ics/parser";
import {
  loadDeadlines,
  setDeadlineDate,
  saveTimetableSessions,
} from "../storage";
import { fetchOutline } from "../api/outlineApi";
import { escapeHtml, defaultYear } from "../utils/format";
import { showToast } from "./toast";

// ── Deps interface ───────────────────────────────────────────────────────────
// Callbacks that live in sidePanel.ts — passed in so this module stays decoupled.

export interface IcsDeps {
  showConfirmation: (
    groups: { filename: string; items: PendingDeadline[] }[],
  ) => void;
  renderDeadlines: () => Promise<void>;
}

// ── showIcsSection (private) ─────────────────────────────────────────────────

/**
 * Populate and reveal the `#ics-section` with up to two sub-sections:
 *
 *  A) Unit auto-fetch — shown when the .ics contains Curtin unit codes.
 *     Lists each unit as a pre-checked checkbox. Clicking "Fetch deadlines"
 *     calls fetchOutline() for all checked units and opens the confirmation UI.
 *
 *  B) Exam-date resolution — shown when TBA deadlines match events in the .ics.
 *     Lists each match with a checkbox (high confidence pre-checked).
 *     Clicking "Apply selected exam dates" writes the dates to storage.
 *
 * Either sub-section can be absent; a divider is shown only when both exist.
 *
 * @param timetable  Detected unit codes + semester/year, or null if none found
 * @param matches    Exam-date matches against current TBA deadlines
 */
function showIcsSection(
  timetable: TimetableInfo | null,
  matches: IcsMatch[],
): void {
  // Swap main → ICS panel
  document.getElementById("main-section")!.classList.add("hidden");
  document.getElementById("ics-section")!.classList.remove("hidden");

  const hasUnits = !!(timetable && timetable.units.length > 0);
  const hasMatches = matches.length > 0;

  // ── Sub-section A: unit auto-fetch ───────────────────────────────────────
  const unitsSec = document.getElementById("ics-units-section")!;
  unitsSec.classList.toggle("hidden", !hasUnits);

  if (hasUnits) {
    const heading = document.getElementById("ics-units-heading")!;
    heading.textContent = `${timetable!.units.length} unit${timetable!.units.length !== 1 ? "s" : ""} detected — fetch their deadlines`;

    const unitsList = document.getElementById("ics-units-list")!;
    unitsList.innerHTML = "";

    for (const unit of timetable!.units) {
      const row = document.createElement("div");
      row.className = "ics-unit-row";
      // Store unit + semester + year as data attributes for the fetch handler
      row.dataset.unit = unit;
      row.dataset.semester = String(timetable!.semester);
      row.dataset.year = String(timetable!.year);
      row.innerHTML = `
        <input type="checkbox" checked />
        <span class="ics-unit-label">${escapeHtml(unit)}</span>
        <span class="ics-unit-sem">S${timetable!.semester} ${timetable!.year}</span>
      `;
      unitsList.appendChild(row);
    }
  }

  // ── Divider — only when both sub-sections are visible ────────────────────
  document
    .getElementById("ics-divider")!
    .classList.toggle("hidden", !(hasUnits && hasMatches));

  // ── Sub-section B: exam-date resolution ──────────────────────────────────
  const examsSec = document.getElementById("ics-exams-section")!;
  examsSec.classList.toggle("hidden", !hasMatches);

  if (hasMatches) {
    const hintEl = document.getElementById("ics-hint")!;
    // Build a hint that mentions both TBA matches and dated-deadline updates
    const tbaCount = matches.filter((m) => !m.isConflict).length;
    const conflictCount = matches.filter((m) => m.isConflict).length;
    const hintParts: string[] = [];
    if (tbaCount > 0)
      hintParts.push(
        `${tbaCount} exam date${tbaCount !== 1 ? "s" : ""} matched to TBA deadlines`,
      );
    if (conflictCount > 0)
      hintParts.push(
        `${conflictCount} update${conflictCount !== 1 ? "s" : ""} for dated deadlines`,
      );
    hintEl.textContent =
      hintParts.join(" · ") ||
      `${matches.length} match${matches.length !== 1 ? "es" : ""} found`;

    const listEl = document.getElementById("ics-list")!;
    listEl.innerHTML = "";

    for (const match of matches) {
      const row = document.createElement("div");
      // Conflict rows don't get the "low" dim class — they use the amber badge instead
      row.className = `ics-match-row${match.confidence === "low" && !match.isConflict ? " low" : ""}`;
      row.dataset.id = match.deadlineId;
      // Use resolvedDate for data-iso — may differ from event.dtstart when a "N hours after" offset was applied
      row.dataset.iso = match.resolvedDate.toISOString();

      // Format the resolved date: "Mon 9 Nov 2026, 9:00 am"
      const dateStr = match.resolvedDate.toLocaleDateString("en-AU", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      const h = match.resolvedDate.getHours();
      const m = match.resolvedDate.getMinutes();
      const hasTime = h !== 0 || m !== 0;
      const timeStr = hasTime
        ? ", " +
          match.resolvedDate.toLocaleTimeString("en-AU", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })
        : "";

      // Conflict rows: unchecked by default + amber update badge + "was:" existing date
      // Normal rows: pre-checked for high confidence; [verify] label for low confidence
      const isChecked = match.isConflict
        ? ""
        : match.confidence === "high"
          ? "checked"
          : "";
      const verifyLabel =
        !match.isConflict && match.confidence === "low"
          ? ' <span style="font-size:10px;opacity:0.6">[verify]</span>'
          : "";
      const conflictBadge = match.isConflict
        ? '<span class="ics-conflict-badge">update</span>'
        : "";
      const existingDateHtml =
        match.isConflict && match.existingDate
          ? `<span class="ics-existing-date">was: ${escapeHtml(
              match.existingDate.toLocaleDateString("en-AU", {
                weekday: "short",
                day: "numeric",
                month: "short",
                year: "numeric",
              }),
            )}</span>`
          : "";

      // Show match reason beneath the label (e.g. "Week 5 lab", "24h after Week 7 workshop")
      const reasonHtml = match.matchReason
        ? `<span style="font-size:10px;opacity:0.6;display:block">${escapeHtml(match.matchReason)}</span>`
        : "";

      row.innerHTML = `
        <input type="checkbox" ${isChecked} />
        <span class="ics-match-label">
          <strong>${escapeHtml(match.deadlineUnit)}</strong> — ${escapeHtml(match.deadlineTitle)}${verifyLabel}${conflictBadge}
          ${existingDateHtml}
          ${reasonHtml}
        </span>
        <span class="ics-match-date">${escapeHtml(dateStr)}${escapeHtml(timeStr)}</span>
      `;
      listEl.appendChild(row);
    }
  }
}

// ── Main wiring function ─────────────────────────────────────────────────────

/**
 * Wire up the ICS import section: the auto-fetch button, the exam-apply
 * button, and the back button.
 * Returns `handleIcsFile` so wirePDFDropZone can invoke it from the shared
 * staging queue when the user clicks "Scan".
 * Called once from init().
 */
export function wireIcsSection(deps: IcsDeps): {
  handleIcsFile: (file: File) => Promise<void>;
} {
  const { showConfirmation, renderDeadlines } = deps;

  /** Helper: close the ICS section and return to the main panel. */
  function closeIcs(): void {
    document.getElementById("ics-section")!.classList.add("hidden");
    document.getElementById("main-section")!.classList.remove("hidden");
  }

  /**
   * Parse a .ics file, detect timetable unit codes, match exam events to TBA
   * deadlines, then show the ICS section or a toast if nothing matched.
   */
  async function handleIcsFile(file: File): Promise<void> {
    const text = await file.text();
    const events = parseIcs(text);

    if (events.length === 0) {
      showToast("No events found in .ics file.", "error");
      return;
    }

    // Detect unit codes + semester from the timetable events
    const timetable = detectTimetableUnits(events);

    // Extract and persist session day-of-week info for use in the confirmation screen
    await saveTimetableSessions(extractTimetableSessions(events));

    // Load current TBA deadlines for both matching passes
    const deadlines = await loadDeadlines();

    // Pass 1: exam-keyword matching (exams, tests, mid-sem, etc.)
    const examMatches = matchIcsToDeadlines(events, deadlines);

    // Pass 2: week + session-type matching (labs, workshops, tutorials due "Week N")
    const sessionMatches = matchIcsByWeekAndSession(
      events,
      deadlines,
      timetable.semester,
      timetable.year,
    );

    // Merge: exam pass takes priority; session pass fills remaining TBA deadlines
    const seenIds = new Set(examMatches.map((m) => m.deadlineId));
    const combined = [
      ...examMatches,
      ...sessionMatches.filter((m) => !seenIds.has(m.deadlineId)),
    ];

    // Pass 3: surface conflicts for already-dated deadlines (ICS has updated times)
    const datedConflicts = matchIcsDatedConflicts(events, deadlines);
    const allSeenIds = new Set(combined.map((m) => m.deadlineId));
    const combined2 = [
      ...combined,
      ...datedConflicts.filter((m) => !allSeenIds.has(m.deadlineId)),
    ];

    // Nothing useful in this file
    if (timetable.units.length === 0 && combined2.length === 0) {
      showToast(
        "No matching deadlines or unit codes found in this timetable.",
        "info",
      );
      return;
    }

    showIcsSection(timetable.units.length > 0 ? timetable : null, combined2);
  }

  // ── Back button ───────────────────────────────────────────────────────────
  document.getElementById("ics-back")!.addEventListener("click", closeIcs);

  // ── Sub-section A: fetch outlines for all checked unit codes ─────────────
  const fetchBtn = document.getElementById(
    "ics-fetch-btn",
  ) as HTMLButtonElement;

  fetchBtn.addEventListener("click", async () => {
    // Collect all checked unit rows
    const rows = document.querySelectorAll<HTMLElement>(".ics-unit-row");
    const toFetch: Array<{ unit: string; semester: 1 | 2; year: number }> = [];

    for (const row of rows) {
      const chk = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!chk?.checked) continue;
      const unit = row.dataset.unit;
      const semester = parseInt(row.dataset.semester ?? "1", 10) as 1 | 2;
      const year = parseInt(row.dataset.year ?? String(defaultYear()), 10);
      if (unit) toFetch.push({ unit, semester, year });
    }

    if (toFetch.length === 0) return;

    // Show loading state on the button while fetches are in flight
    fetchBtn.disabled = true;
    fetchBtn.textContent = `Fetching ${toFetch.length} unit${toFetch.length !== 1 ? "s" : ""}…`;

    // Fetch all unit outlines in parallel; individual failures don't block others
    const results = await Promise.allSettled(
      toFetch.map(({ unit, semester, year }) =>
        fetchOutline(unit, semester, year).then((items) => ({
          filename: `${unit} S${semester} ${year}`,
          items,
        })),
      ),
    );

    // Reset button state before showing results
    fetchBtn.disabled = false;
    fetchBtn.textContent = "Fetch deadlines for selected units";

    // Partition into successes and failures
    const groups: { filename: string; items: PendingDeadline[] }[] = [];
    const failed: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled" && result.value.items.length > 0) {
        groups.push(result.value);
      } else {
        // Either rejected or returned zero assessments
        failed.push(toFetch[i].unit);
      }
    }

    if (groups.length === 0) {
      showToast(
        `Couldn't fetch outlines for: ${failed.join(", ")}.\n` +
          `Check that the unit codes and semester are correct.`,
        "error",
      );
      return;
    }

    // Close ICS section and hand off to the existing confirmation checklist
    closeIcs();
    showConfirmation(groups);

    // If some units failed alongside successes, notify after a short delay
    if (failed.length > 0) {
      setTimeout(() => {
        showToast(
          `Note: couldn't fetch outlines for ${failed.join(", ")}.`,
          "info",
        );
      }, 150);
    }
  });

  // ── Sub-section B: apply checked exam dates to TBA deadlines ─────────────
  document.getElementById("ics-apply")!.addEventListener("click", async () => {
    const rows = document.querySelectorAll<HTMLElement>(".ics-match-row");

    for (const row of rows) {
      const chk = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!chk?.checked) continue;

      const id = row.dataset.id;
      const isoDate = row.dataset.iso; // set by showIcsSection()
      if (!id || !isoDate) continue;

      await setDeadlineDate(id, isoDate);
    }

    closeIcs();
    await renderDeadlines();
  });

  return { handleIcsFile };
}
