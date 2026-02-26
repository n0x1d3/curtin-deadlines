// ── Curtin Deadlines — Side Panel ────────────────────────────────────────────
// Orchestrator: imports wiring modules, renders deadlines, handles confirmation
// checklist, manual form, API fetch, and Blackboard scrape results.

import "./sidePanel.css";
import { showToast } from "./ui/toast";

import type { Deadline, PendingDeadline } from "./types";
import { command } from "./types";
import { weekToDate } from "./utils/getDates";
import { fetchOutline } from "./api/outlineApi";

// Storage helpers — Chrome storage reads/writes
import { loadDeadlines, addDeadline, loadSettings } from "./storage";

// Date and countdown formatting utilities
import { escapeHtml, truncate, formatDate, defaultYear } from "./utils/format";

// Card builders — extracted from renderDeadlines() (P3a)
import {
  buildTbaCard,
  buildNormalCard,
  buildSeriesFooter,
  type CardDeps,
} from "./ui/cards";

// ICS calendar export (download via background service worker)
import { exportICS } from "./ics/export";

// Deadline domain: filtering, sorting, grouping, classification
import {
  seriesKey,
  parseWeekInput,
  extractSingleWeek,
  buildDeadlineSections,
} from "./domain/deadlines";

// PDF parsing functions extracted into a shared module (also used by testPage)
import { initPdfWorker } from "./pdf";

// Wiring modules — extracted UI setup (P3b)
import {
  wireSettingsSection,
  applyDarkMode,
  applyDefaultSemester,
} from "./ui/wireSettings";
import { wireIcsSection } from "./ui/wireIcs";
import { wirePDFDropZone } from "./ui/wirePdf";

// ── PDF.js worker setup ───────────────────────────────────────────────────────
// initPdfWorker resolves the chrome-extension:// URL for the bundled worker file.
initPdfWorker(chrome.runtime.getURL("pdf.worker.min.js"));

// ── Deadline list rendering ───────────────────────────────────────────────────

/** Re-render the full deadline list from storage. */
async function renderDeadlines(): Promise<void> {
  const deadlines = await loadDeadlines();
  const listEl = document.getElementById("deadline-list")!;
  const emptyEl = document.getElementById("empty-state")!;
  const filterBarEl = document.getElementById("filter-bar")!;
  const filterEmptyEl = document.getElementById("filter-empty")!;

  listEl.innerHTML = "";

  if (deadlines.length === 0) {
    // No deadlines at all — hide bar and show empty state
    filterBarEl.classList.add("hidden");
    filterEmptyEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    return;
  }

  // ── Update filter bar UI ────────────────────────────────────────────────────
  // Show the bar and sync its controls to the current module-level state.
  filterBarEl.classList.remove("hidden");
  emptyEl.classList.add("hidden");

  // Refresh unit dropdown from all stored units (not just the filtered subset)
  const allUnits = [...new Set(deadlines.map((d) => d.unit))].sort();
  const unitSel = document.getElementById("filter-unit") as HTMLSelectElement;
  unitSel.innerHTML =
    '<option value="">All units</option>' +
    allUnits
      .map(
        (u) =>
          `<option value="${escapeHtml(u)}"${u === filterUnit ? " selected" : ""}>${escapeHtml(u)}</option>`,
      )
      .join("");

  // Sync status pill active states
  document.querySelectorAll<HTMLElement>(".filter-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.status === filterStatus);
  });

  // Sync sort button label to show the current sort order
  const sortBtn = document.getElementById("sort-btn");
  if (sortBtn) sortBtn.textContent = sortBy === "date" ? "Date ↕" : "Unit ↕";

  // ── Filter, sort, and group into sections ───────────────────────────────────
  // buildDeadlineSections is a pure domain function — passes module-level state
  // as explicit params so the logic is testable without DOM/Chrome APIs.
  const now = new Date();
  const { sections: orderedSections, display } = buildDeadlineSections(
    deadlines,
    {
      filterUnit,
      filterStatus,
      sortBy,
      overduePosition: overduePositionRef.value,
    },
  );

  // Show "no match" message when filter leaves nothing to display
  if (display.length === 0) {
    filterEmptyEl.classList.remove("hidden");
    return;
  }

  filterEmptyEl.classList.add("hidden");

  // ── Render each section, with an optional label divider between them ────────
  // Series grouping (numbered deadlines like "Practical Test 1", "Practical Test 2")
  // is applied per-section so groups don't accidentally span section boundaries.
  for (const { label, items } of orderedSections) {
    // Insert a small section-label heading when the section has a label
    if (label) {
      const sectionEl = document.createElement("div");
      sectionEl.className = "section-label";
      sectionEl.textContent = label;
      listEl.appendChild(sectionEl);
    }

    // Build series groups for deadlines within this section
    const groups = new Map<string, Deadline[]>();
    for (const deadline of items) {
      const key = seriesKey(deadline.unit, deadline.title);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(deadline);
    }

    const deps: CardDeps = { expandedSeries, onRerender: renderDeadlines, now };

    for (const [sKey, group] of groups) {
      // Focus item = first non-TBA item whose due date is still in the future.
      // Fallback: last resolved item, or the first item if everything is TBA.
      const upcoming = group.filter(
        (d) => !d.dateTBA && new Date(d.dueDate) > now,
      );
      const focus =
        upcoming.length > 0
          ? upcoming[0]
          : (group.filter((d) => !d.dateTBA).slice(-1)[0] ?? group[0]);

      const isSeries = group.length > 1;
      const sourceBadge =
        focus.source === "auto"
          ? `<span class="card-source-badge" title="Imported from Blackboard">auto</span>`
          : "";

      const card = focus.dateTBA
        ? buildTbaCard(focus, sourceBadge, isSeries, sKey, deps)
        : buildNormalCard(focus, sourceBadge, isSeries, sKey, deps);

      if (isSeries) {
        const { footer, expandedEl } = buildSeriesFooter(
          group,
          focus,
          upcoming,
          sKey,
          deps,
        );
        card.appendChild(footer);
        listEl.appendChild(card);
        listEl.appendChild(expandedEl);
      } else {
        listEl.appendChild(card);
      }
    } // end groups loop
  } // end orderedSections loop
}

// ── Confirmation UI ───────────────────────────────────────────────────────────

/** Global array holding the pending deadlines shown in the confirmation section. */
let pendingItems: PendingDeadline[] = [];

// ── Filter / sort state ───────────────────────────────────────────────────────
// These are module-level so they survive re-renders triggered by add/delete.

/** Currently selected unit code filter. Empty string = show all units. */
let filterUnit = "";

/** Currently selected status filter. */
let filterStatus: "all" | "upcoming" | "overdue" | "tba" = "all";

/** Current sort order for the deadline list. */
let sortBy: "date" | "unit" = "date";

/**
 * Mutable ref for the overdue position preference — updated by wireSettingsSection()
 * on init and whenever the user changes the setting. Keeps renderDeadlines() synchronous.
 * Wrapped as { value } so extracted wiring modules can mutate it by reference.
 */
const overduePositionRef = { value: "bottom" as "top" | "bottom" };

/**
 * Tracks which series groups are currently expanded in the deadline list.
 * Keyed by seriesKey(unit, title). Persists across re-renders so expand state
 * is not lost when a deadline is deleted or dates are updated.
 */
const expandedSeries = new Set<string>();

/**
 * Switch the UI to show the PDF confirmation checklist.
 *
 * Accepts an array of { filename, items } groups — one per parsed PDF.
 * When multiple PDFs are uploaded, each group gets a section header in the list
 * so the user can see which items came from which file.
 *
 * pendingItems is set to the flat concatenation of all groups; the row
 * data-idx attribute maps directly into that flat array for saveConfirmedItems.
 */
function showConfirmation(
  groups: { filename: string; items: PendingDeadline[] }[],
): void {
  // Flatten all groups into a single ordered list for saveConfirmedItems
  pendingItems = groups.flatMap((g) => g.items);

  const mainSection = document.getElementById("main-section")!;
  const confirmSection = document.getElementById("confirmation-section")!;
  const confirmList = document.getElementById("confirm-list")!;
  const confirmEmpty = document.getElementById("confirm-empty")!;
  const confirmSource = document.getElementById("confirm-source")!;

  // Source label: single filename or "N PDFs"
  confirmSource.textContent =
    groups.length === 1 ? groups[0].filename : `${groups.length} PDFs`;

  confirmList.innerHTML = "";

  if (pendingItems.length === 0) {
    confirmEmpty.classList.remove("hidden");
    document.getElementById("confirm-add")!.setAttribute("disabled", "true");
  } else {
    confirmEmpty.classList.add("hidden");
    document.getElementById("confirm-add")!.removeAttribute("disabled");

    let globalIdx = 0; // flat index into pendingItems, shared across all groups

    for (const { filename, items } of groups) {
      // Per-file section header — only shown when multiple PDFs were uploaded
      if (groups.length > 1) {
        const hdr = document.createElement("div");
        hdr.className = "confirm-file-hdr";
        hdr.innerHTML =
          `<span class="confirm-file-name">${escapeHtml(truncate(filename, 48))}</span>` +
          `<span class="confirm-file-count">${items.length} item${items.length !== 1 ? "s" : ""}</span>`;
        confirmList.appendChild(hdr);
      }

      items.forEach((item) => {
        const row = document.createElement("div");
        row.className = `confirm-row${item.isTBA ? " tba" : ""}`;
        row.dataset.idx = String(globalIdx++);

        // For TBA items, show fill-in fields so the user can enter the week number.
        const tbaSemester = item.semester ?? 1;
        const tbaYear = item.year ?? defaultYear();

        const tbaFillHTML = `
          <div class="conf-tba-fill${item.isTBA ? "" : " hidden"}">
            <span class="conf-fill-label">Set date:</span>
            <select class="conf-sem-sel" title="Semester">
              <option value="1"${tbaSemester === 1 ? " selected" : ""}>S1</option>
              <option value="2"${tbaSemester === 2 ? " selected" : ""}>S2</option>
            </select>
            <input class="conf-year-inp" type="number" value="${tbaYear}" min="2024" max="2035" title="Year" />
            <label class="conf-week-lbl">Wk(s)
              <input class="conf-week-inp" type="text" placeholder="e.g. 5 or 1,3,5,7" maxlength="40" title="Week number(s): single &quot;5&quot;, range &quot;1-13&quot;, or comma list &quot;1,3,5,7,9,11&quot;" />
            </label>
          </div>
        `;

        // Resolved date text — strip '#' placeholders from exactTime before display
        const displayTime = item.exactTime
          ?.replace(/#/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const resolvedText = item.resolvedDate
          ? `→ ${formatDate(item.resolvedDate)}${displayTime ? " · " + displayTime : ""}`
          : "";

        row.innerHTML = `
          <input type="checkbox" class="conf-check" checked />
          <div class="confirm-row-fields">
            <div class="conf-inputs">
              <input type="text" class="conf-unit-input" value="${escapeHtml(item.unit)}" placeholder="Unit" maxlength="8" />
              <input type="text" class="conf-title-input" value="${escapeHtml(item.title)}" placeholder="Task name" />
            </div>
            <div class="conf-date-info">
              ${item.weekLabel ? `<span class="conf-week-label" title="${escapeHtml(item.weekLabel)}">${escapeHtml(truncate(item.weekLabel, 30))}</span>` : ""}
              ${item.calSource ? `<span class="conf-cal-badge" title="Sourced from Program Calendar">Cal</span>` : ""}
              ${item.weight ? `<span class="conf-weight-badge">${item.weight}%</span>` : ""}
              ${item.outcomes ? `<span class="conf-outcomes-badge" title="Unit Learning Outcomes assessed">LO ${escapeHtml(item.outcomes)}</span>` : ""}
              ${item.lateAccepted !== undefined ? `<span class="conf-late-badge${item.lateAccepted ? "" : " badge-no"}" title="Late submissions accepted: ${item.lateAccepted ? "Yes" : "No"}">Late: ${item.lateAccepted ? "Yes" : "No"}</span>` : ""}
              ${item.extensionConsidered !== undefined ? `<span class="conf-ext-badge${item.extensionConsidered ? "" : " badge-no"}" title="Extension considered: ${item.extensionConsidered ? "Yes" : "No"}">Ext: ${item.extensionConsidered ? "Yes" : "No"}</span>` : ""}
              ${item.isTBA ? `<span class="conf-tba-badge">fill in ↓</span>` : ""}
              ${resolvedText ? `<span class="conf-resolved">${escapeHtml(resolvedText)}</span>` : ""}
            </div>
            ${tbaFillHTML}
          </div>
        `;

        // Pre-fill the week input for TBA items that have a known weekLabel
        // (e.g. "Week 5" inferred from the PC_TEXT table). The user only needs
        // to confirm or adjust; no need to look it up manually.
        if (item.isTBA) {
          const weekInp = row.querySelector<HTMLInputElement>(".conf-week-inp");
          if (weekInp) {
            const hintWeek = extractSingleWeek(item.weekLabel);
            if (hintWeek !== null) weekInp.value = String(hintWeek);
          }
        }

        confirmList.appendChild(row);
      });
    }
  }

  mainSection.classList.add("hidden");
  confirmSection.classList.remove("hidden");
}

/** Return from confirmation view to the main panel. */
function hideConfirmation(): void {
  document.getElementById("main-section")!.classList.remove("hidden");
  document.getElementById("confirmation-section")!.classList.add("hidden");
  pendingItems = [];
}

/**
 * Read the user-edited values from the confirmation rows and save ticked items.
 *
 * For each checked row:
 *   - Non-TBA items (parser already resolved a date): use the pre-resolved date
 *   - TBA items: read the user-entered semester / year / week(s) from the fill-in
 *     fields. If multiple weeks are entered (e.g. "1,3,5,7" for weekly workshops),
 *     one deadline is saved per week so each appears individually in the list.
 *   - If a TBA row has no week entered, skip it (can't save without a date)
 *
 * Returns the number of deadlines actually saved.
 */
async function saveConfirmedItems(): Promise<number> {
  const rows = document.querySelectorAll<HTMLElement>(
    "#confirm-list .confirm-row",
  );
  const fallbackYear = defaultYear();
  let saved = 0;
  const skipped: string[] = [];

  for (const row of rows) {
    const checked = row.querySelector<HTMLInputElement>(".conf-check")?.checked;
    if (!checked) continue;

    const idx = parseInt(row.dataset.idx ?? "0", 10);
    const original = pendingItems[idx];
    if (!original) continue;

    // Read user-edited unit and title
    const unit =
      row
        .querySelector<HTMLInputElement>(".conf-unit-input")
        ?.value.trim()
        .toUpperCase() || "UNKNOWN";
    const title =
      row.querySelector<HTMLInputElement>(".conf-title-input")?.value.trim() ||
      "Task";

    if (original.resolvedDate) {
      // Parser already resolved the date — save a single deadline directly
      const deadline: Deadline = {
        id: crypto.randomUUID(),
        title,
        unit,
        unitName: original.unitName,
        dueDate: original.resolvedDate.toISOString(),
        weekLabel: original.weekLabel,
        weight: original.weight,
        outcomes: original.outcomes,
        lateAccepted: original.lateAccepted,
        extensionConsidered: original.extensionConsidered,
        source: "manual",
        addedAt: new Date().toISOString(),
      };
      await addDeadline(deadline);
      saved++;
    } else {
      // TBA item — read the fill-in inputs the user provided
      const semVal =
        row.querySelector<HTMLSelectElement>(".conf-sem-sel")?.value ?? "1";
      const yearVal =
        row.querySelector<HTMLInputElement>(".conf-year-inp")?.value ??
        String(fallbackYear);
      const weekRaw =
        row.querySelector<HTMLInputElement>(".conf-week-inp")?.value.trim() ??
        "";

      const sem = parseInt(semVal, 10) as 1 | 2;
      const yr = parseInt(yearVal, 10);

      if (!weekRaw) {
        // No week entered — save as TBA so the user can set the date from the card
        // once they know it (e.g. exam timetable released, lab schedule confirmed).
        // dueDate is set to year 9999 as a far-future placeholder so the card sorts last.
        const tbaDeadline: Deadline = {
          id: crypto.randomUUID(),
          title,
          unit,
          unitName: original.unitName,
          dueDate: new Date(9999, 11, 31).toISOString(),
          weekLabel: original.weekLabel,
          weight: original.weight,
          outcomes: original.outcomes,
          lateAccepted: original.lateAccepted,
          extensionConsidered: original.extensionConsidered,
          dateTBA: true,
          source: "manual",
          addedAt: new Date().toISOString(),
        };
        await addDeadline(tbaDeadline);
        saved++;
        continue;
      }

      if (isNaN(yr)) {
        skipped.push(title);
        continue;
      }

      // Parse the week input — may return multiple weeks (e.g. "1,3,5,7,9,11")
      const weeks = parseWeekInput(weekRaw);
      if (weeks.length === 0) {
        skipped.push(title);
        continue;
      }

      // Create one deadline per week — this handles recurring assessments
      // (e.g. weekly workshops) as separate trackable entries with individual countdowns.
      for (const week of weeks) {
        const deadline: Deadline = {
          id: crypto.randomUUID(),
          title,
          unit,
          unitName: original.unitName,
          dueDate: weekToDate(sem, yr, week, 0).toISOString(),
          // Each entry gets its own "Week N" label so they're distinguishable in the list
          weekLabel: `Week ${week}`,
          weight: original.weight,
          outcomes: original.outcomes,
          lateAccepted: original.lateAccepted,
          extensionConsidered: original.extensionConsidered,
          source: "manual",
          addedAt: new Date().toISOString(),
        };
        await addDeadline(deadline);
        saved++;
      }
    }
  }

  // Notify the user if some checked rows were skipped due to missing week
  if (skipped.length > 0) {
    const names = skipped
      .slice(0, 3)
      .map((s) => `"${s}"`)
      .join(", ");
    const extra = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
    showToast(
      `Skipped ${skipped.length} item${skipped.length > 1 ? "s" : ""} (no week entered): ${names}${extra}.\n` +
        "You can add them manually using the form.",
      "info",
    );
  }

  return saved;
}

// ── Manual add form ───────────────────────────────────────────────────────────

/**
 * Validate and add a deadline from the manual form.
 * Handles both "by week" mode (resolves to semester week start) and
 * "by date" mode (uses the exact date/time selected by the user).
 */
async function handleManualSubmit(event: Event): Promise<void> {
  event.preventDefault();

  const errorEl = document.getElementById("form-error")!;
  errorEl.classList.add("hidden");

  // Gather field values
  const unit = (document.getElementById("f-unit") as HTMLInputElement).value
    .trim()
    .toUpperCase();
  const title = (
    document.getElementById("f-title") as HTMLInputElement
  ).value.trim();
  const mode =
    document.querySelector<HTMLInputElement>('input[name="add-mode"]:checked')
      ?.value ?? "week";

  // Validate common fields
  if (!unit) return showFormError("Please enter a unit code.");
  if (!title) return showFormError("Please enter a task name.");

  let dueDate: Date | null = null;
  let weekLabel: string | undefined;

  if (mode === "week") {
    // ── Week mode ──────────────────────────────────────────────────────────
    const semester = parseInt(
      (document.getElementById("f-semester") as HTMLSelectElement).value,
      10,
    ) as 1 | 2;
    const year = parseInt(
      (document.getElementById("f-year") as HTMLInputElement).value,
      10,
    );
    const weekRaw = (
      document.getElementById("f-week") as HTMLInputElement
    ).value.trim();

    if (!weekRaw) return showFormError("Please enter a week number.");
    if (isNaN(year) || year < 2024 || year > 2035)
      return showFormError("Please enter a valid year.");

    // Support "5" or "5-7" — use the last (end) week of a range
    const weekMatch = weekRaw.match(/(\d+)\s*[-–]\s*(\d+)/);
    const week = weekMatch ? parseInt(weekMatch[2], 10) : parseInt(weekRaw, 10);
    if (isNaN(week) || week < 1 || week > 20)
      return showFormError("Week must be between 1 and 20.");

    dueDate = weekToDate(semester, year, week, 0); // Monday of the week
    weekLabel = weekMatch
      ? `Weeks ${weekMatch[1]}–${weekMatch[2]}`
      : `Week ${week}`;
  } else {
    // ── Date mode ──────────────────────────────────────────────────────────
    const dateVal = (document.getElementById("f-date") as HTMLInputElement)
      .value;
    const timeVal = (document.getElementById("f-time") as HTMLInputElement)
      .value;

    if (!dateVal) return showFormError("Please select a date.");

    // Build Date object from the date + optional time inputs
    dueDate = new Date(dateVal);
    if (timeVal) {
      const [h, m] = timeVal.split(":").map(Number);
      dueDate.setHours(h, m, 0, 0);
    }
  }

  if (!dueDate) return showFormError("Could not resolve a due date.");

  const deadline: Deadline = {
    id: crypto.randomUUID(),
    title,
    unit,
    dueDate: dueDate.toISOString(),
    weekLabel,
    source: "manual",
    addedAt: new Date().toISOString(),
  };

  await addDeadline(deadline);
  await renderDeadlines();

  // Reset the form after successful submission
  (event.target as HTMLFormElement).reset();
  // Reset year back to default (form.reset() clears it)
  (document.getElementById("f-year") as HTMLInputElement).value =
    String(defaultYear());
  document.getElementById("week-preview")!.classList.add("hidden");
  document.getElementById("form-error")!.classList.add("hidden");

  // Collapse the manual form after adding
  (document.getElementById("manual-details") as HTMLDetailsElement).open =
    false;
}

function showFormError(msg: string): void {
  const el = document.getElementById("form-error")!;
  el.textContent = msg;
  el.classList.remove("hidden");
}

/**
 * Update the live week preview text whenever the week/semester/year fields change.
 * Shows the resolved Monday date so the user can verify before adding.
 */
function updateWeekPreview(): void {
  const previewEl = document.getElementById("week-preview")!;
  const semVal = (document.getElementById("f-semester") as HTMLSelectElement)
    .value;
  const yearVal = (document.getElementById("f-year") as HTMLInputElement).value;
  const weekVal = (
    document.getElementById("f-week") as HTMLInputElement
  ).value.trim();

  if (!weekVal || !semVal || !yearVal) {
    previewEl.classList.add("hidden");
    return;
  }

  const semester = parseInt(semVal, 10) as 1 | 2;
  const year = parseInt(yearVal, 10);

  // Support ranges — use end week
  const weekMatch = weekVal.match(/(\d+)\s*[-–]\s*(\d+)/);
  const week = weekMatch ? parseInt(weekMatch[2], 10) : parseInt(weekVal, 10);

  if (isNaN(week) || isNaN(year) || week < 1 || week > 20) {
    previewEl.classList.add("hidden");
    return;
  }

  try {
    const resolved = weekToDate(semester, year, week, 0);
    previewEl.textContent = `→ Monday ${formatDate(resolved)}`;
    previewEl.classList.remove("hidden");
  } catch (err) {
    // weekToDate throws for out-of-range inputs; hide the preview rather than crash.
    console.error("[weekPreview] weekToDate failed:", err);
    previewEl.classList.add("hidden");
  }
}

// ── Outline API fetch section ─────────────────────────────────────────────────

/**
 * Wires up the "Fetch outline" API section.
 * Pressing Enter in the unit code input is equivalent to clicking the button.
 */
function wireApiSection(): void {
  const btn = document.getElementById("api-fetch-btn")!;
  const unitInput = document.getElementById(
    "api-unit-code",
  ) as HTMLInputElement;
  // Allow pressing Enter in the unit code field to trigger the fetch
  unitInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btn.click();
  });
  btn.addEventListener("click", handleApiFetch);
}

/**
 * Handles a click on the "Fetch outline" button.
 * Reads the unit code, semester, and year from the API section inputs,
 * calls fetchOutline(), and pipes the result into the existing confirmation UI.
 */
async function handleApiFetch(): Promise<void> {
  const unitInput = document.getElementById(
    "api-unit-code",
  ) as HTMLInputElement;
  const semesterSelect = document.getElementById(
    "api-semester",
  ) as HTMLSelectElement;
  const yearInput = document.getElementById("api-year") as HTMLInputElement;

  const unitCode = unitInput.value.trim().toUpperCase();
  const semester = parseInt(semesterSelect.value, 10) as 1 | 2;
  const year = parseInt(yearInput.value, 10);

  // Validate unit code before making any network requests
  if (!unitCode) {
    setApiStatus("error", "Enter a unit code first.");
    return;
  }

  setApiStatus("loading", "Fetching outline…");
  try {
    const items = await fetchOutline(unitCode, semester, year);
    if (items.length === 0) {
      setApiStatus("error", "No assessments found for this unit / semester.");
      return;
    }
    // Clear the status and hand off to the confirmation checklist
    setApiStatus("", "");
    showConfirmation([{ filename: `${unitCode} S${semester} ${year}`, items }]);
  } catch (e) {
    console.error("[handleApiFetch]", e);
    setApiStatus("error", (e as Error).message);
  }
}

/**
 * Updates the API status paragraph with a message and optional type class.
 * @param type  'loading' adds a spinner, 'error' applies the error colour, '' clears
 * @param msg   Text to display (empty string hides the paragraph)
 */
function setApiStatus(type: "loading" | "error" | "", msg: string): void {
  const el = document.getElementById("api-status")!;
  el.textContent = msg;
  // Remove all type classes first, then apply the new one if present
  el.className = type ? `api-status--${type}` : "";
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Apply saved dark mode before rendering to avoid flash
  await applyDarkMode();

  // ── Load settings before first render so overduePositionRef is ready ──
  const settings = await loadSettings();
  overduePositionRef.value = settings.overduePosition;

  // Render the initial deadline list
  await renderDeadlines();

  // Apply the stored default semester to all dropdowns after first render
  applyDefaultSemester(settings.defaultSemester);

  // ── Settings panel ────────────────────────────────────────────────────────
  await wireSettingsSection({ renderDeadlines, overduePositionRef });

  // ── ICS import section ────────────────────────────────────────────────────
  wireIcsSection({ showConfirmation, renderDeadlines });

  // ── Outline API fetch section ─────────────────────────────────────────────
  wireApiSection();

  // ── Drop zone ────────────────────────────────────────────────────────────
  wirePDFDropZone({ showConfirmation });

  // ── Confirmation section buttons ─────────────────────────────────────────
  document
    .getElementById("confirm-back")!
    .addEventListener("click", hideConfirmation);

  document
    .getElementById("confirm-add")!
    .addEventListener("click", async () => {
      try {
        const saved = await saveConfirmedItems();
        hideConfirmation();
        await renderDeadlines();
        if (saved === 0) {
          // Let the user know nothing was saved (all unchecked)
          showToast(
            "No deadlines were selected. Use the manual form to add them individually.",
            "info",
          );
        }
      } catch (err) {
        console.error("[confirm-add] save failed:", err);
        showToast(
          `Failed to save deadlines: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    });

  // ── Manual form ──────────────────────────────────────────────────────────
  document
    .getElementById("manual-form")!
    .addEventListener("submit", handleManualSubmit);

  // Mode toggle: show/hide week vs date fields
  document
    .querySelectorAll<HTMLInputElement>('input[name="add-mode"]')
    .forEach((radio) => {
      radio.addEventListener("change", () => {
        const isWeek = radio.value === "week" && radio.checked;
        document
          .getElementById("week-fields")!
          .classList.toggle("hidden", !isWeek);
        document
          .getElementById("date-fields")!
          .classList.toggle("hidden", isWeek);
      });
    });

  // Live week preview (update whenever semester/year/week fields change)
  ["f-semester", "f-year", "f-week"].forEach((id) => {
    document.getElementById(id)!.addEventListener("input", updateWeekPreview);
    document.getElementById(id)!.addEventListener("change", updateWeekPreview);
  });

  // ── Filter bar ───────────────────────────────────────────────────────────
  // Unit select — update filterUnit and re-render
  document
    .getElementById("filter-unit")!
    .addEventListener("change", async (e) => {
      filterUnit = (e.target as HTMLSelectElement).value;
      await renderDeadlines();
    });

  // Status pills — update filterStatus and re-render
  document.querySelectorAll<HTMLElement>(".filter-pill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      filterStatus = (btn.dataset.status ?? "all") as typeof filterStatus;
      await renderDeadlines();
    });
  });

  // Sort toggle — cycle between date and unit sort
  document.getElementById("sort-btn")!.addEventListener("click", async () => {
    sortBy = sortBy === "date" ? "unit" : "date";
    await renderDeadlines();
  });

  // ── Header buttons ───────────────────────────────────────────────────────
  document.getElementById("export-btn")!.addEventListener("click", exportICS);

  // ── Listen for Blackboard scrape results from the content script ─────────
  // The content script sends deadlines found on Blackboard pages.
  chrome.runtime.onMessage.addListener((request) => {
    if (request.command === command.scrapeResult) {
      handleBlackboardResults(request.deadlines as Partial<Deadline>[]);
    }
  });
}

/**
 * Merge Blackboard-scraped deadlines into storage.
 * Skips duplicates (same unit + title + approximate date).
 */
async function handleBlackboardResults(
  scraped: Partial<Deadline>[],
): Promise<void> {
  if (!scraped || scraped.length === 0) return;
  const existing = await loadDeadlines();

  let added = 0;
  for (const item of scraped) {
    if (!item.title || !item.unit || !item.dueDate) continue;

    // Deduplicate by unit + title (case-insensitive)
    const isDuplicate = existing.some(
      (e) =>
        e.unit.toUpperCase() === item.unit!.toUpperCase() &&
        e.title.toLowerCase() === item.title!.toLowerCase(),
    );
    if (isDuplicate) continue;

    const deadline: Deadline = {
      id: crypto.randomUUID(),
      title: item.title,
      unit: item.unit,
      dueDate: item.dueDate,
      weekLabel: item.weekLabel,
      source: "auto",
      addedAt: new Date().toISOString(),
    };
    await addDeadline(deadline);
    added++;
  }

  if (added > 0) {
    await renderDeadlines();
  }
}

// Kick everything off when the DOM is ready
document.addEventListener("DOMContentLoaded", init);
