// ── Card builders for the deadline list ──────────────────────────────────────
// Extracted from renderDeadlines() in sidePanel.ts (P3a refactor).
// Each builder creates a fully-wired DOM element for a single card type.

import type { Deadline } from "../types";
import {
  escapeHtml,
  truncate,
  formatDate,
  formatTime,
  getCountdown,
  defaultYear,
} from "../utils/format";
import { weekToDate, getSemesterWeeks } from "../utils/getDates";
import {
  isFinalExamType,
  extractSingleWeek,
  parseWeekInput,
} from "../domain/deadlines";
import {
  setDeadlineDate,
  deleteDeadline,
  loadSkipSubmitConfirm,
  saveSkipSubmitConfirm,
} from "../storage";
import { showToast } from "./toast";

// ── Public interface ─────────────────────────────────────────────────────────

/** Minimal dependencies that can't be imported — passed from renderDeadlines. */
export interface CardDeps {
  expandedSeries: Set<string>; // module-level state, read+write
  onRerender: () => Promise<void>; // renderDeadlines callback
  now: Date; // consistent timestamp per render pass
}

// ── Private helpers ──────────────────────────────────────────────────────────

/** Shared HTML for the inline submit-confirmation section (hidden by default). */
function submitConfirmHTML(): string {
  return `
      <div class="card-submit-confirm hidden">
        <p class="card-submit-q">Did you submit this?</p>
        <label class="card-submit-skip-lbl">
          <input type="checkbox" class="card-submit-skip-chk" />
          Don't ask me again
        </label>
        <div class="card-submit-btns">
          <button type="button" class="card-submit-yes">Yes, done</button>
          <button type="button" class="card-submit-no">Cancel</button>
        </div>
      </div>
    `;
}

/**
 * Wire the complete/delete/cancel buttons on a card.
 * Both TBA and normal cards share the same confirmation flow.
 */
function wireSubmitConfirm(
  card: HTMLDivElement,
  focus: Deadline,
  isSeries: boolean,
  sKey: string,
  deps: CardDeps,
): void {
  const confirmDiv = card.querySelector<HTMLElement>(".card-submit-confirm")!;

  // Complete button — show inline confirmation or skip dialog
  card.querySelector(".card-complete")!.addEventListener("click", async () => {
    const skip = await loadSkipSubmitConfirm();
    if (skip) {
      // Preference already set — skip the dialog and remove immediately
      if (isSeries) deps.expandedSeries.add(sKey);
      await deleteDeadline(focus.id);
      await deps.onRerender();
    } else {
      // Show the inline confirmation
      confirmDiv.classList.toggle("hidden");
    }
  });

  // "Yes, done" — optionally save the skip preference, then remove
  card
    .querySelector(".card-submit-yes")!
    .addEventListener("click", async () => {
      const skipChk = card.querySelector<HTMLInputElement>(
        ".card-submit-skip-chk",
      )!;
      if (skipChk.checked) await saveSkipSubmitConfirm(true);
      if (isSeries) deps.expandedSeries.add(sKey);
      await deleteDeadline(focus.id);
      await deps.onRerender();
    });

  // "Cancel" — hide the confirmation without doing anything
  card.querySelector(".card-submit-no")!.addEventListener("click", () => {
    confirmDiv.classList.add("hidden");
  });

  // Delete button — remove deadline, keep series expanded
  card.querySelector(".card-delete")!.addEventListener("click", async () => {
    if (isSeries) deps.expandedSeries.add(sKey);
    await deleteDeadline(focus.id);
    await deps.onRerender();
  });
}

// ── Exported card builders ───────────────────────────────────────────────────

/**
 * Build a TBA card — date unknown, shows "Set date" inline form.
 * Returns a fully-wired card element ready to append to the DOM.
 */
export function buildTbaCard(
  focus: Deadline,
  sourceBadge: string,
  isSeries: boolean,
  sKey: string,
  deps: CardDeps,
): HTMLDivElement {
  const card = document.createElement("div");
  card.dataset.id = focus.id;
  card.className = "deadline-card tba-card";

  // Infer semester and year from when the deadline was added (addedAt is during its semester)
  const addedDate = new Date(focus.addedAt);
  const addedMonth = addedDate.getMonth() + 1; // 1-based
  const inferredSem: 1 | 2 = addedMonth >= 2 && addedMonth <= 6 ? 1 : 2;
  const inferredYear = addedDate.getFullYear();

  // Classify the TBA type so we can customise the badge, hint, and form pre-fill.
  const isExam = isFinalExamType(focus.title);
  const weekNum = extractSingleWeek(focus.weekLabel);

  // Compute exam period dates (teaching weeks + 1 study week + start of exam fortnight)
  const teachingWeeks = getSemesterWeeks(inferredYear, inferredSem);
  const examPeriodStart = weekToDate(
    inferredSem,
    inferredYear,
    teachingWeeks + 2,
    0,
  ); // Mon of exam wk 1
  const examPeriodEnd = weekToDate(
    inferredSem,
    inferredYear,
    teachingWeeks + 3,
    4,
  ); // Fri of exam wk 2

  // Badge text
  let tbaBadgeText: string;
  if (isExam) tbaBadgeText = "Exam period";
  else if (weekNum !== null) tbaBadgeText = `Week ${weekNum} · TBC`;
  else tbaBadgeText = "Date TBA";

  // Exam period hint shown in the card date row (replaces weekHint for exam cards)
  const fmtShort = (d: Date) =>
    d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  const examHint = isExam
    ? `<span class="card-week-label-text">~${fmtShort(examPeriodStart)}–${fmtShort(examPeriodEnd)} ${inferredYear}</span>`
    : "";

  const weekHint =
    !isExam && focus.weekLabel
      ? `<span class="card-week-label-text">${escapeHtml(focus.weekLabel)}</span>`
      : "";
  const yr = defaultYear();
  // Unit name displayed after the unit code if available
  const unitNameHTML = focus.unitName
    ? `<span class="card-dot" style="opacity:0.3">·</span><span class="card-unit-name">${escapeHtml(truncate(focus.unitName, 32))}</span>`
    : "";
  // Weight badge shown alongside the date row if available
  const weightHTML = focus.weight
    ? `<span class="card-dot">·</span><span class="card-weight">${focus.weight}%</span>`
    : "";

  // Meta row: outcomes + late/extension policy (only when data available)
  const metaHTML =
    focus.outcomes ||
    focus.lateAccepted !== undefined ||
    focus.extensionConsidered !== undefined
      ? `<div class="card-meta">
          ${focus.outcomes ? `<span class="card-meta-item">LO&nbsp;${escapeHtml(focus.outcomes)}</span>` : ""}
          ${focus.lateAccepted !== undefined ? `<span class="card-meta-item${focus.lateAccepted ? "" : " meta-no"}" title="Late submissions accepted: ${focus.lateAccepted ? "Yes" : "No"}">Late:&nbsp;${focus.lateAccepted ? "Yes" : "No"}</span>` : ""}
          ${focus.extensionConsidered !== undefined ? `<span class="card-meta-item${focus.extensionConsidered ? "" : " meta-no"}" title="Extension considered: ${focus.extensionConsidered ? "Yes" : "No"}">Ext:&nbsp;${focus.extensionConsidered ? "Yes" : "No"}</span>` : ""}
        </div>`
      : "";

  card.innerHTML = `
        <div class="card-top">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="card-unit">${escapeHtml(focus.unit)}</span>
            ${unitNameHTML}
            ${sourceBadge}
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="card-tba-badge">${tbaBadgeText}</span>
            <button class="card-complete" title="Mark as submitted" aria-label="Mark ${escapeHtml(focus.title)} as submitted">✓</button>
            <button class="card-delete" title="Delete deadline" aria-label="Delete ${escapeHtml(focus.title)}">×</button>
          </div>
        </div>
        <div class="card-title">${escapeHtml(focus.title)}</div>
        ${metaHTML}
        <div class="card-date">
          ${examHint}${weekHint}
          ${weightHTML}
          <button class="card-set-date-btn">📅 Set date</button>
        </div>
        <form class="card-date-form hidden">
          <div class="card-date-form-row">
            <label class="card-form-lbl">Date
              <input type="date" class="card-date-inp" required />
            </label>
            <label class="card-form-lbl">Time (opt)
              <input type="time" class="card-time-inp" />
            </label>
            <label class="card-form-lbl">— or —&nbsp; Wk
              <input type="text" class="card-week-inp" placeholder="e.g. 13" maxlength="10" />
            </label>
            <select class="card-sem-sel" title="Semester">
              <option value="1">S1</option>
              <option value="2">S2</option>
            </select>
            <input class="card-year-inp" type="number" value="${yr}" min="2024" max="2035" title="Year" />
          </div>
          <div class="card-date-form-actions">
            <button type="submit" class="card-form-save">Save</button>
            <button type="button" class="card-form-cancel">Cancel</button>
          </div>
        </form>
        ${submitConfirmHTML()}
      `;

  // Toggle the inline form open/closed
  const setDateBtn =
    card.querySelector<HTMLButtonElement>(".card-set-date-btn")!;
  const dateForm = card.querySelector<HTMLFormElement>(".card-date-form")!;
  setDateBtn.addEventListener("click", () => {
    dateForm.classList.toggle("hidden");
    setDateBtn.textContent = dateForm.classList.contains("hidden")
      ? "📅 Set date"
      : "✕ Cancel";
  });
  card.querySelector(".card-form-cancel")!.addEventListener("click", () => {
    dateForm.classList.add("hidden");
    setDateBtn.textContent = "📅 Set date";
  });

  // Save handler — accepts either a date picker value or a week number
  dateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dateVal =
      card.querySelector<HTMLInputElement>(".card-date-inp")!.value;
    const timeVal =
      card.querySelector<HTMLInputElement>(".card-time-inp")!.value;
    const weekVal = card
      .querySelector<HTMLInputElement>(".card-week-inp")!
      .value.trim();
    const semVal =
      card.querySelector<HTMLSelectElement>(".card-sem-sel")!.value;
    const yearVal =
      card.querySelector<HTMLInputElement>(".card-year-inp")!.value;

    let resolved: Date | null = null;

    if (dateVal) {
      resolved = new Date(dateVal);
      if (timeVal) {
        const [h, m] = timeVal.split(":").map(Number);
        resolved.setHours(h, m, 0, 0);
      }
    } else if (weekVal) {
      const weeks = parseWeekInput(weekVal);
      if (weeks.length > 0) {
        const sem = parseInt(semVal, 10) as 1 | 2;
        const yr2 = parseInt(yearVal, 10);
        resolved = weekToDate(sem, yr2, weeks[weeks.length - 1], 0);
      }
    }

    if (!resolved || isNaN(resolved.getTime())) {
      showToast("Please enter a date or a week number.", "error");
      return;
    }

    await setDeadlineDate(focus.id, resolved.toISOString());
    await deps.onRerender();
  });

  // ── Pre-fill the date form based on TBA type ──────────────────────────────
  if (isExam) {
    // Exam: pre-fill with the first Monday of the exam period
    card.querySelector<HTMLInputElement>(".card-date-inp")!.value =
      examPeriodStart.toISOString().slice(0, 10);
    card.querySelector<HTMLSelectElement>(".card-sem-sel")!.value =
      String(inferredSem);
    card.querySelector<HTMLInputElement>(".card-year-inp")!.value =
      String(inferredYear);
  } else if (weekNum !== null) {
    // Week-known: pre-fill with the Monday of the known teaching week.
    const weekDate = weekToDate(inferredSem, inferredYear, weekNum, 0);
    card.querySelector<HTMLInputElement>(".card-date-inp")!.value = weekDate
      .toISOString()
      .slice(0, 10);
    card.querySelector<HTMLInputElement>(".card-week-inp")!.value =
      String(weekNum);
    card.querySelector<HTMLSelectElement>(".card-sem-sel")!.value =
      String(inferredSem);
    card.querySelector<HTMLInputElement>(".card-year-inp")!.value =
      String(inferredYear);
  }

  wireSubmitConfirm(card, focus, isSeries, sKey, deps);
  return card;
}

/**
 * Build a normal card — date known, shows countdown timer.
 * Returns a fully-wired card element ready to append to the DOM.
 */
export function buildNormalCard(
  focus: Deadline,
  sourceBadge: string,
  isSeries: boolean,
  sKey: string,
  deps: CardDeps,
): HTMLDivElement {
  const card = document.createElement("div");
  card.dataset.id = focus.id;

  const { label, urgencyClass } = getCountdown(focus.dueDate);
  const displayDate = formatDate(new Date(focus.dueDate));
  const displayTime = formatTime(focus.dueDate);

  // Build the date line: "Week 5 · Mon 16 Mar 2026 · 23:59 · 20%" (or subset)
  const dateParts: string[] = [];
  if (focus.weekLabel) dateParts.push(focus.weekLabel);
  dateParts.push(displayDate);
  if (displayTime) dateParts.push(displayTime);
  // Append weight to the date line if known
  if (focus.weight)
    dateParts.push(`<span class="card-weight">${focus.weight}%</span>`);
  const dateLineHTML = dateParts
    .map((p, i) => (i > 0 ? `<span class="card-dot">·</span> ${p}` : p))
    .join(" ");

  // Unit name sub-label (shown after the unit code in the card header)
  const unitNameHTML = focus.unitName
    ? `<span class="card-dot" style="opacity:0.3">·</span><span class="card-unit-name">${escapeHtml(truncate(focus.unitName, 32))}</span>`
    : "";

  // Meta row: outcomes + late/extension policy (only when data available)
  const metaHTML =
    focus.outcomes ||
    focus.lateAccepted !== undefined ||
    focus.extensionConsidered !== undefined
      ? `<div class="card-meta">
          ${focus.outcomes ? `<span class="card-meta-item">LO&nbsp;${escapeHtml(focus.outcomes)}</span>` : ""}
          ${focus.lateAccepted !== undefined ? `<span class="card-meta-item${focus.lateAccepted ? "" : " meta-no"}" title="Late submissions accepted: ${focus.lateAccepted ? "Yes" : "No"}">Late:&nbsp;${focus.lateAccepted ? "Yes" : "No"}</span>` : ""}
          ${focus.extensionConsidered !== undefined ? `<span class="card-meta-item${focus.extensionConsidered ? "" : " meta-no"}" title="Extension considered: ${focus.extensionConsidered ? "Yes" : "No"}">Ext:&nbsp;${focus.extensionConsidered ? "Yes" : "No"}</span>` : ""}
        </div>`
      : "";

  card.className = `deadline-card ${urgencyClass}`;
  card.innerHTML = `
        <div class="card-top">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="card-unit">${escapeHtml(focus.unit)}</span>
            ${unitNameHTML}
            ${sourceBadge}
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="card-countdown">${label}</span>
            <button class="card-complete" title="Mark as submitted" aria-label="Mark ${escapeHtml(focus.title)} as submitted">✓</button>
            <button class="card-delete" title="Delete deadline" aria-label="Delete ${escapeHtml(focus.title)}">×</button>
          </div>
        </div>
        <div class="card-title">${escapeHtml(focus.title)}</div>
        ${metaHTML}
        <div class="card-date">${dateLineHTML}</div>
        ${submitConfirmHTML()}
      `;

  wireSubmitConfirm(card, focus, isSeries, sKey, deps);
  return card;
}

/**
 * Build the series footer and expanded list for a group of related deadlines.
 * Returns both elements — caller appends footer to the card and expandedEl after it.
 */
export function buildSeriesFooter(
  group: Deadline[],
  focus: Deadline,
  upcoming: Deadline[],
  sKey: string,
  deps: CardDeps,
): { footer: HTMLDivElement; expandedEl: HTMLDivElement } {
  const focusIdx = group.indexOf(focus) + 1;
  // "ahead" = items that are upcoming and not TBA (excludes the focus itself)
  const aheadCount = upcoming.length > 0 ? upcoming.length - 1 : 0;

  // Footer bar — shows position in series; click to expand/collapse
  const footer = document.createElement("div");
  footer.className = "series-footer";
  footer.setAttribute("role", "button");
  footer.setAttribute("tabindex", "0");

  // Expanded panel — rendered once, toggled visible by the footer
  const expandedEl = document.createElement("div");
  expandedEl.className = "series-expanded";
  if (!deps.expandedSeries.has(sKey)) expandedEl.classList.add("hidden");

  // Update footer label to match the current open/closed state
  const setFooterText = (open: boolean): void => {
    if (open) {
      footer.innerHTML = `<span class="series-caret">▲</span> All ${group.length} in series`;
    } else {
      const aheadText =
        aheadCount > 0
          ? ` · <span class="series-ahead">${aheadCount} more ahead</span>`
          : "";
      footer.innerHTML = `<span class="series-caret">▶</span> ${focusIdx} of ${group.length}${aheadText}`;
    }
  };

  setFooterText(deps.expandedSeries.has(sKey));

  // Build a compact row for each item in the group (all, including focus)
  for (const item of group) {
    const isOverdue = !item.dateTBA && new Date(item.dueDate) <= deps.now;
    const isFocus = item.id === focus.id;

    const row = document.createElement("div");
    row.className = [
      "series-item",
      isFocus ? "series-focus" : "",
      isOverdue ? "series-overdue" : "",
      item.dateTBA ? "series-tba" : "",
    ]
      .filter(Boolean)
      .join(" ");

    // Date and countdown labels for the compact row
    const dateLabel = item.dateTBA ? "TBA" : formatDate(new Date(item.dueDate));
    const ctdLabel = item.dateTBA ? "" : getCountdown(item.dueDate).label;

    row.innerHTML = `
          <span class="series-item-title">${escapeHtml(item.title)}</span>
          <span class="series-item-date">${escapeHtml(dateLabel)}</span>
          ${ctdLabel ? `<span class="series-item-ctd">${escapeHtml(ctdLabel)}</span>` : ""}
          <button class="series-item-del" aria-label="Delete ${escapeHtml(item.title)}">×</button>
        `;

    // Delete individual series item; keep series expanded after deletion
    row
      .querySelector(".series-item-del")!
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        deps.expandedSeries.add(sKey);
        await deleteDeadline(item.id);
        await deps.onRerender();
      });

    expandedEl.appendChild(row);
  }

  // Toggle open/close on click or keyboard Enter/Space
  const toggleExpand = (): void => {
    const open = deps.expandedSeries.has(sKey);
    if (open) {
      deps.expandedSeries.delete(sKey);
      expandedEl.classList.add("hidden");
    } else {
      deps.expandedSeries.add(sKey);
      expandedEl.classList.remove("hidden");
    }
    setFooterText(!open);
  };

  footer.addEventListener("click", toggleExpand);
  footer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleExpand();
    }
  });

  return { footer, expandedEl };
}
