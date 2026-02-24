// ── Curtin Deadlines — Side Panel ────────────────────────────────────────────
// Handles: PDF upload + parsing, manual add form, deadline list rendering,
// confirmation checklist, ICS export, and dark mode toggle.

import './sidePanel.css';

// ics library for generating calendar files
import { createEvents, EventAttributes } from 'ics';

import type { Deadline, PendingDeadline } from './types';
import { command } from './types';
import { weekToDate, getSemesterWeeks } from './utils/getDates';
import { fetchOutline } from './api/outlineApi';

// PDF parsing functions extracted into a shared module (also used by testPage)
import {
  initPdfWorker,
  parseUnitName,
  extractPDFText,
  parseAssessments,
  parseProgramCalendar,
  mergeWithCalendar,
  addSequenceNumbers,
} from './pdf/parser';

// ── PDF.js worker setup ───────────────────────────────────────────────────────
// initPdfWorker resolves the chrome-extension:// URL for the bundled worker file.
initPdfWorker(chrome.runtime.getURL('pdf.worker.min.js'));

// ── Storage helpers ───────────────────────────────────────────────────────────

/**
 * Load all deadlines from chrome.storage.local.
 *
 * On first run after the migration from sync → local, any deadlines previously
 * stored in chrome.storage.sync are moved to local and removed from sync.
 * chrome.storage.local has a 5 MB limit (vs sync's 8 KB per-key cap),
 * which is far more suitable for storing arrays of deadline objects.
 */
async function loadDeadlines(): Promise<Deadline[]> {
  // Primary source: chrome.storage.local
  const local = await chrome.storage.local.get('deadlines');
  if (local.deadlines) {
    return local.deadlines as Deadline[];
  }

  // Migration: check if old data lives in sync storage
  try {
    const sync = await chrome.storage.sync.get('deadlines');
    if (sync.deadlines && (sync.deadlines as Deadline[]).length > 0) {
      const migrated = sync.deadlines as Deadline[];
      // Move to local, clear from sync
      await chrome.storage.local.set({ deadlines: migrated });
      await chrome.storage.sync.remove('deadlines');
      return migrated;
    }
  } catch {
    // Sync unavailable or quota already exceeded — ignore
  }

  return [];
}

/** Persist the full deadlines array to chrome.storage.local. */
async function saveDeadlines(deadlines: Deadline[]): Promise<void> {
  await chrome.storage.local.set({ deadlines });
}

/** Add a single deadline, keeping the list sorted by dueDate ascending. */
async function addDeadline(deadline: Deadline): Promise<void> {
  const deadlines = await loadDeadlines();
  deadlines.push(deadline);
  deadlines.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  await saveDeadlines(deadlines);
}

/** Remove a deadline by id. */
async function deleteDeadline(id: string): Promise<void> {
  const deadlines = await loadDeadlines();
  await saveDeadlines(deadlines.filter((d) => d.id !== id));
}

/**
 * Update the due date of an existing deadline and clear its dateTBA flag.
 * Re-sorts the list after updating so the card moves to its correct position.
 */
async function setDeadlineDate(id: string, dueDate: string): Promise<void> {
  const deadlines = await loadDeadlines();
  const idx = deadlines.findIndex((d) => d.id === id);
  if (idx === -1) return;
  deadlines[idx].dueDate = dueDate;
  delete deadlines[idx].dateTBA;
  // Re-sort after date change
  deadlines.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  await saveDeadlines(deadlines);
}

// ── Submit-confirmation preference ────────────────────────────────────────────

/**
 * Returns true when the user has opted out of the "Did you submit?" dialog.
 * Stored in chrome.storage.local so it persists across sessions.
 */
async function loadSkipSubmitConfirm(): Promise<boolean> {
  const result = await chrome.storage.local.get('skipSubmitConfirm');
  return result.skipSubmitConfirm === true;
}

/** Persist the user's choice to skip the submit confirmation in future. */
async function saveSkipSubmitConfirm(skip: boolean): Promise<void> {
  await chrome.storage.local.set({ skipSubmitConfirm: skip });
}

// ── Date / countdown utilities ────────────────────────────────────────────────

/** Format a Date as "Mon 16 Mar 2026". */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Format a time string from an ISO date like "2026-05-03T23:59:00". */
function formatTime(isoDate: string): string | null {
  const d = new Date(isoDate);
  const h = d.getHours();
  const m = d.getMinutes();
  // If time component is midnight (00:00), treat as all-day — don't show time
  if (h === 0 && m === 0) return null;
  return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Compute a human-readable countdown string and urgency class for a deadline.
 * @param isoDate ISO 8601 due date string
 * @returns { label, urgencyClass }
 */
function getCountdown(isoDate: string): { label: string; urgencyClass: string } {
  const now = new Date();
  const due = new Date(isoDate);
  const diffMs = due.getTime() - now.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMs < 0) {
    // Already past due
    return { label: 'overdue', urgencyClass: 'overdue' };
  } else if (diffMins < 60) {
    // Under an hour away
    return { label: `in ${diffMins} min${diffMins !== 1 ? 's' : ''}`, urgencyClass: 'urgent' };
  } else if (diffHours < 48) {
    // Within 48 hours — urgent
    return { label: `in ${diffHours} hour${diffHours !== 1 ? 's' : ''}`, urgencyClass: 'urgent' };
  } else if (diffDays < 7) {
    // Within 7 days — soon
    return { label: `in ${diffDays} day${diffDays !== 1 ? 's' : ''}`, urgencyClass: 'soon' };
  } else {
    // More than a week away — ok
    return { label: `in ${diffDays} days`, urgencyClass: 'ok' };
  }
}

// ── Deadline list rendering ───────────────────────────────────────────────────

/** Re-render the full deadline list from storage. */
async function renderDeadlines(): Promise<void> {
  const deadlines = await loadDeadlines();
  const listEl = document.getElementById('deadline-list')!;
  const emptyEl = document.getElementById('empty-state')!;
  const filterBarEl = document.getElementById('filter-bar')!;
  const filterEmptyEl = document.getElementById('filter-empty')!;

  listEl.innerHTML = '';

  if (deadlines.length === 0) {
    // No deadlines at all — hide bar and show empty state
    filterBarEl.classList.add('hidden');
    filterEmptyEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }

  // ── Update filter bar UI ────────────────────────────────────────────────────
  // Show the bar and sync its controls to the current module-level state.
  filterBarEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');

  // Refresh unit dropdown from all stored units (not just the filtered subset)
  const allUnits = [...new Set(deadlines.map((d) => d.unit))].sort();
  const unitSel = document.getElementById('filter-unit') as HTMLSelectElement;
  unitSel.innerHTML =
    '<option value="">All units</option>' +
    allUnits
      .map((u) => `<option value="${escapeHtml(u)}"${u === filterUnit ? ' selected' : ''}>${escapeHtml(u)}</option>`)
      .join('');

  // Sync status pill active states
  document.querySelectorAll<HTMLElement>('.filter-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.status === filterStatus);
  });

  // Sync sort button label to show the current sort order
  const sortBtn = document.getElementById('sort-btn');
  if (sortBtn) sortBtn.textContent = sortBy === 'date' ? 'Date ↕' : 'Unit ↕';

  // ── Apply filter and sort ───────────────────────────────────────────────────
  const now = new Date();
  let display = deadlines;

  if (filterUnit) {
    display = display.filter((d) => d.unit === filterUnit);
  }

  if (filterStatus === 'upcoming') {
    display = display.filter((d) => !d.dateTBA && new Date(d.dueDate) > now);
  } else if (filterStatus === 'tba') {
    display = display.filter((d) => !!d.dateTBA);
  } else if (filterStatus === 'overdue') {
    display = display.filter((d) => !d.dateTBA && new Date(d.dueDate) <= now);
  }

  // Split deadlines into groups. TBA items are further split into two sub-groups:
  //   weekKnownTba — dateTBA + a single extractable week number in weekLabel
  //   fullyTba     — dateTBA + no useful week (e.g. "Fortnightly", blank)
  // Resolved items are split into upcoming and overdue.
  // Overdue position (top/bottom) is controlled by the user's overduePosition setting.
  interface Section { label: string | null; items: Deadline[] }
  const orderedSections: Section[] = [];
  {
    const allTba = display.filter((d) => d.dateTBA);

    // Exam-type TBAs: title is a final exam — date depends on the exam timetable release
    const examTba = allTba.filter((d) => isFinalExamType(d.title));

    // Week-known TBAs: weekLabel has a single parseable week (and not a final exam)
    const weekKnownTba = allTba.filter((d) =>
      !isFinalExamType(d.title) &&
      extractSingleWeek(d.weekLabel) !== null);

    // Fully unknown TBAs: no week info and not a final exam (e.g. recurring, online tests)
    const fullyTba = allTba.filter((d) =>
      !isFinalExamType(d.title) &&
      extractSingleWeek(d.weekLabel) === null);
    const upcoming     = display.filter((d) => !d.dateTBA && new Date(d.dueDate) > now);
    const overdue      = display.filter((d) => !d.dateTBA && new Date(d.dueDate) <= now);

    // Sort exams by unit (predictable order — exam timetable determines actual date)
    examTba.sort((a, b) => a.unit.localeCompare(b.unit));

    if (sortBy === 'unit') {
      // Unit sort — all groups sorted by unit, resolved groups secondarily by date
      weekKnownTba.sort((a, b) => {
        const wa = extractSingleWeek(a.weekLabel) ?? 99;
        const wb = extractSingleWeek(b.weekLabel) ?? 99;
        return wa - wb || a.unit.localeCompare(b.unit);
      });
      fullyTba.sort((a, b) => a.unit.localeCompare(b.unit));
      upcoming.sort((a, b) => a.unit.localeCompare(b.unit) || a.dueDate.localeCompare(b.dueDate));
      overdue.sort((a, b) => a.unit.localeCompare(b.unit) || a.dueDate.localeCompare(b.dueDate));
    } else {
      // Date sort — week-known TBAs sorted by week number so earlier weeks appear first;
      // fully-unknown TBAs sorted by unit for a consistent, predictable layout
      weekKnownTba.sort((a, b) => {
        const wa = extractSingleWeek(a.weekLabel) ?? 99;
        const wb = extractSingleWeek(b.weekLabel) ?? 99;
        return wa - wb || a.unit.localeCompare(b.unit);
      });
      fullyTba.sort((a, b) => a.unit.localeCompare(b.unit));
      upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    }

    // Determine how many distinct TBA sub-groups have items — section labels
    // are only shown when there are multiple sub-groups so the list stays clean.
    const tbaSectionCount = [examTba, weekKnownTba, fullyTba].filter(g => g.length > 0).length;
    const showTbaLabels = tbaSectionCount > 1;

    // Build ordered section list.
    if (examTba.length > 0) {
      orderedSections.push({
        label: showTbaLabels ? 'Exam period · date TBC' : null,
        items: examTba,
      });
    }
    if (weekKnownTba.length > 0) {
      orderedSections.push({
        label: showTbaLabels ? 'Week scheduled · date TBC' : null,
        items: weekKnownTba,
      });
    }
    if (fullyTba.length > 0) {
      orderedSections.push({
        label: showTbaLabels ? 'Date unknown' : null,
        items: fullyTba,
      });
    }

    // Read overdue position from module-level cache (synchronous)
    const odPos = overduePositionCache;
    if (odPos === 'top' && overdue.length > 0) orderedSections.push({ label: null, items: overdue });
    if (upcoming.length > 0)                   orderedSections.push({ label: null, items: upcoming });
    if (odPos !== 'top' && overdue.length > 0) orderedSections.push({ label: null, items: overdue });

    // Flatten sections back into display so the filterEmpty check below still works
    display = orderedSections.flatMap((s) => s.items);
  }

  // Show "no match" message when filter leaves nothing to display
  if (display.length === 0) {
    filterEmptyEl.classList.remove('hidden');
    return;
  }

  filterEmptyEl.classList.add('hidden');

  // ── Render each section, with an optional label divider between them ────────
  // Series grouping (numbered deadlines like "Practical Test 1", "Practical Test 2")
  // is applied per-section so groups don't accidentally span section boundaries.
  for (const { label, items } of orderedSections) {
    // Insert a small section-label heading when the section has a label
    if (label) {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'section-label';
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

  for (const [sKey, group] of groups) {
    // Focus item = first non-TBA item whose due date is still in the future.
    // Fallback: last resolved item, or the first item if everything is TBA.
    const upcoming = group.filter((d) => !d.dateTBA && new Date(d.dueDate) > now);
    const focus =
      upcoming.length > 0
        ? upcoming[0]
        : (group.filter((d) => !d.dateTBA).slice(-1)[0] ?? group[0]);

    const isSeries = group.length > 1;

    // ── Build the focus deadline card ─────────────────────────────────────────
    const sourceBadge =
      focus.source === 'auto'
        ? `<span class="card-source-badge" title="Imported from Blackboard">auto</span>`
        : '';

    const card = document.createElement('div');
    card.dataset.id = focus.id;

    // Shared HTML for the inline submit-confirmation section (hidden by default).
    // Revealed when the user clicks the ✓ complete button on any card type.
    const submitConfirmHTML = `
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

    if (focus.dateTBA) {
      // ── TBA card: date unknown, show "Set date" inline form ──────────────────
      card.className = 'deadline-card tba-card';

      // Infer semester and year from when the deadline was added (addedAt is during its semester)
      const addedDate  = new Date(focus.addedAt);
      const addedMonth = addedDate.getMonth() + 1; // 1-based
      const inferredSem: 1 | 2 = addedMonth >= 2 && addedMonth <= 6 ? 1 : 2;
      const inferredYear = addedDate.getFullYear();

      // Classify the TBA type so we can customise the badge, hint, and form pre-fill.
      const isExam    = isFinalExamType(focus.title);
      const weekNum   = extractSingleWeek(focus.weekLabel);

      // Compute exam period dates (teaching weeks + 1 study week + start of exam fortnight)
      // e.g. S1 2026: 14 teaching weeks → exam period starts week 16 = ~1 Jun 2026
      const teachingWeeks  = getSemesterWeeks(inferredYear, inferredSem);
      const examPeriodStart = weekToDate(inferredSem, inferredYear, teachingWeeks + 2, 0); // Mon of exam wk 1
      const examPeriodEnd   = weekToDate(inferredSem, inferredYear, teachingWeeks + 3, 4); // Fri of exam wk 2

      // Badge text
      let tbaBadgeText: string;
      if (isExam)          tbaBadgeText = 'Exam period';
      else if (weekNum !== null) tbaBadgeText = `Week ${weekNum} · TBC`;
      else                 tbaBadgeText = 'Date TBA';

      // Exam period hint shown in the card date row (replaces weekHint for exam cards)
      const fmtShort = (d: Date) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      const examHint = isExam
        ? `<span class="card-week-label-text">~${fmtShort(examPeriodStart)}–${fmtShort(examPeriodEnd)} ${inferredYear}</span>`
        : '';

      const weekHint = (!isExam && focus.weekLabel)
        ? `<span class="card-week-label-text">${escapeHtml(focus.weekLabel)}</span>`
        : '';
      const yr = defaultYear();
      // Unit name displayed after the unit code if available (e.g. "COMP1005 · Intro to Computing")
      const unitNameHTML = focus.unitName
        ? `<span class="card-dot" style="opacity:0.3">·</span><span class="card-unit-name">${escapeHtml(truncate(focus.unitName, 32))}</span>`
        : '';
      // Weight badge shown alongside the date row if available
      const weightHTML = focus.weight
        ? `<span class="card-dot">·</span><span class="card-weight">${focus.weight}%</span>`
        : '';

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
        ${submitConfirmHTML}
      `;

      // Toggle the inline form open/closed
      const setDateBtn = card.querySelector<HTMLButtonElement>('.card-set-date-btn')!;
      const dateForm = card.querySelector<HTMLFormElement>('.card-date-form')!;
      setDateBtn.addEventListener('click', () => {
        dateForm.classList.toggle('hidden');
        setDateBtn.textContent = dateForm.classList.contains('hidden') ? '📅 Set date' : '✕ Cancel';
      });
      card.querySelector('.card-form-cancel')!.addEventListener('click', () => {
        dateForm.classList.add('hidden');
        setDateBtn.textContent = '📅 Set date';
      });

      // Save handler — accepts either a date picker value or a week number
      dateForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const dateVal = card.querySelector<HTMLInputElement>('.card-date-inp')!.value;
        const timeVal = card.querySelector<HTMLInputElement>('.card-time-inp')!.value;
        const weekVal = card.querySelector<HTMLInputElement>('.card-week-inp')!.value.trim();
        const semVal  = card.querySelector<HTMLSelectElement>('.card-sem-sel')!.value;
        const yearVal = card.querySelector<HTMLInputElement>('.card-year-inp')!.value;

        let resolved: Date | null = null;

        if (dateVal) {
          resolved = new Date(dateVal);
          if (timeVal) {
            const [h, m] = timeVal.split(':').map(Number);
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
          alert('Please enter a date or a week number.');
          return;
        }

        await setDeadlineDate(focus.id, resolved.toISOString());
        await renderDeadlines();
      });

      // ── Pre-fill the date form based on TBA type ──────────────────────────────
      // inferredSem, inferredYear, examPeriodStart, weekNum are computed above.
      if (isExam) {
        // Exam: pre-fill with the first Monday of the exam period so the user just
        // needs to adjust the exact day/time once the official timetable is out.
        card.querySelector<HTMLInputElement>('.card-date-inp')!.value =
          examPeriodStart.toISOString().slice(0, 10); // YYYY-MM-DD
        card.querySelector<HTMLSelectElement>('.card-sem-sel')!.value = String(inferredSem);
        card.querySelector<HTMLInputElement>('.card-year-inp')!.value = String(inferredYear);
      } else if (weekNum !== null) {
        // Week-known: pre-fill with the Monday of the known teaching week.
        const weekDate = weekToDate(inferredSem, inferredYear, weekNum, 0);
        card.querySelector<HTMLInputElement>('.card-date-inp')!.value =
          weekDate.toISOString().slice(0, 10); // YYYY-MM-DD
        card.querySelector<HTMLInputElement>('.card-week-inp')!.value = String(weekNum);
        card.querySelector<HTMLSelectElement>('.card-sem-sel')!.value = String(inferredSem);
        card.querySelector<HTMLInputElement>('.card-year-inp')!.value = String(inferredYear);
      }

    } else {
      // ── Normal card: date known, show countdown ───────────────────────────────
      const { label, urgencyClass } = getCountdown(focus.dueDate);
      const displayDate = formatDate(new Date(focus.dueDate));
      const displayTime = formatTime(focus.dueDate);

      // Build the date line: "Week 5 · Mon 16 Mar 2026 · 23:59 · 20%" (or subset)
      const dateParts: string[] = [];
      if (focus.weekLabel) dateParts.push(focus.weekLabel);
      dateParts.push(displayDate);
      if (displayTime) dateParts.push(displayTime);
      // Append weight to the date line if known, e.g. "· 20%"
      if (focus.weight) dateParts.push(`<span class="card-weight">${focus.weight}%</span>`);
      const dateLineHTML = dateParts
        .map((p, i) => (i > 0 ? `<span class="card-dot">·</span> ${p}` : p))
        .join(' ');

      // Unit name sub-label (shown after the unit code in the card header)
      const unitNameHTML = focus.unitName
        ? `<span class="card-dot" style="opacity:0.3">·</span><span class="card-unit-name">${escapeHtml(truncate(focus.unitName, 32))}</span>`
        : '';

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
        <div class="card-date">${dateLineHTML}</div>
        ${submitConfirmHTML}
      `;
    }

    // ── Complete (submitted) button wiring ────────────────────────────────────
    const confirmDiv = card.querySelector<HTMLElement>('.card-submit-confirm')!;

    card.querySelector('.card-complete')!.addEventListener('click', async () => {
      const skip = await loadSkipSubmitConfirm();
      if (skip) {
        // Preference already set — skip the dialog and remove immediately
        if (isSeries) expandedSeries.add(sKey);
        await deleteDeadline(focus.id);
        await renderDeadlines();
      } else {
        // Show the inline confirmation
        confirmDiv.classList.toggle('hidden');
      }
    });

    // "Yes, done" — optionally save the skip preference, then remove
    card.querySelector('.card-submit-yes')!.addEventListener('click', async () => {
      const skipChk = card.querySelector<HTMLInputElement>('.card-submit-skip-chk')!;
      if (skipChk.checked) await saveSkipSubmitConfirm(true);
      if (isSeries) expandedSeries.add(sKey);
      await deleteDeadline(focus.id);
      await renderDeadlines();
    });

    // "Cancel" — hide the confirmation without doing anything
    card.querySelector('.card-submit-no')!.addEventListener('click', () => {
      confirmDiv.classList.add('hidden');
    });

    // Wire up the focus card's delete button
    card.querySelector('.card-delete')!.addEventListener('click', async () => {
      // When deleting from a series, keep it expanded so the user sees what remains
      if (isSeries) expandedSeries.add(sKey);
      await deleteDeadline(focus.id);
      await renderDeadlines();
    });

    // ── Series footer + expanded list ─────────────────────────────────────────
    if (isSeries) {
      const focusIdx = group.indexOf(focus) + 1;
      // "ahead" = items that are upcoming and not TBA (excludes the focus itself)
      const aheadCount = upcoming.length > 0 ? upcoming.length - 1 : 0;

      // Footer bar — shows position in series; click to expand/collapse
      const footer = document.createElement('div');
      footer.className = 'series-footer';
      footer.setAttribute('role', 'button');
      footer.setAttribute('tabindex', '0');

      // Expanded panel — rendered once, toggled visible by the footer
      const expandedEl = document.createElement('div');
      expandedEl.className = 'series-expanded';
      if (!expandedSeries.has(sKey)) expandedEl.classList.add('hidden');

      // Update footer label to match the current open/closed state
      function setFooterText(open: boolean): void {
        if (open) {
          footer.innerHTML =
            `<span class="series-caret">▲</span> All ${group.length} in series`;
        } else {
          const aheadText =
            aheadCount > 0
              ? ` · <span class="series-ahead">${aheadCount} more ahead</span>`
              : '';
          footer.innerHTML =
            `<span class="series-caret">▶</span> ${focusIdx} of ${group.length}${aheadText}`;
        }
      }

      setFooterText(expandedSeries.has(sKey));

      // Build a compact row for each item in the group (all, including focus)
      for (const item of group) {
        const isOverdue = !item.dateTBA && new Date(item.dueDate) <= now;
        const isFocus = item.id === focus.id;

        const row = document.createElement('div');
        row.className = [
          'series-item',
          isFocus   ? 'series-focus'   : '',
          isOverdue ? 'series-overdue' : '',
          item.dateTBA ? 'series-tba' : '',
        ].filter(Boolean).join(' ');

        // Date and countdown labels for the compact row
        const dateLabel = item.dateTBA
          ? 'TBA'
          : formatDate(new Date(item.dueDate));
        const ctdLabel = item.dateTBA ? '' : getCountdown(item.dueDate).label;

        row.innerHTML = `
          <span class="series-item-title">${escapeHtml(item.title)}</span>
          <span class="series-item-date">${escapeHtml(dateLabel)}</span>
          ${ctdLabel ? `<span class="series-item-ctd">${escapeHtml(ctdLabel)}</span>` : ''}
          <button class="series-item-del" aria-label="Delete ${escapeHtml(item.title)}">×</button>
        `;

        // Delete individual series item; keep series expanded after deletion
        row.querySelector('.series-item-del')!.addEventListener('click', async (e) => {
          e.stopPropagation();
          expandedSeries.add(sKey);
          await deleteDeadline(item.id);
          await renderDeadlines();
        });

        expandedEl.appendChild(row);
      }

      // Toggle open/close on click or keyboard Enter/Space
      function toggleExpand(): void {
        const open = expandedSeries.has(sKey);
        if (open) {
          expandedSeries.delete(sKey);
          expandedEl.classList.add('hidden');
        } else {
          expandedSeries.add(sKey);
          expandedEl.classList.remove('hidden');
        }
        setFooterText(!open);
      }

      footer.addEventListener('click', toggleExpand);
      footer.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleExpand();
        }
      });

      card.appendChild(footer);
      listEl.appendChild(card);
      listEl.appendChild(expandedEl);
    } else {
      listEl.appendChild(card);
    }
  } // end groups loop
  } // end orderedSections loop
}

/** Escape HTML special characters to prevent XSS when injecting text content. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── PDF parsing ───────────────────────────────────────────────────────────────
// Functions imported from ./pdf/parser — see that module for full documentation.
function defaultYear(): number {
  return new Date().getFullYear();
}

// ── Confirmation UI ───────────────────────────────────────────────────────────

/** Global array holding the pending deadlines shown in the confirmation section. */
let pendingItems: PendingDeadline[] = [];

// ── Filter / sort state ───────────────────────────────────────────────────────
// These are module-level so they survive re-renders triggered by add/delete.

/** Currently selected unit code filter. Empty string = show all units. */
let filterUnit = '';

/** Currently selected status filter. */
let filterStatus: 'all' | 'upcoming' | 'overdue' | 'tba' = 'all';

/** Current sort order for the deadline list. */
let sortBy: 'date' | 'unit' = 'date';

/**
 * Cached overdue position preference — updated by wireSettingsSection() on init
 * and whenever the user changes the setting. Keeps renderDeadlines() synchronous.
 */
let overduePositionCache: 'top' | 'bottom' = 'bottom';

/**
 * Tracks which series groups are currently expanded in the deadline list.
 * Keyed by seriesKey(unit, title). Persists across re-renders so expand state
 * is not lost when a deadline is deleted or dates are updated.
 */
const expandedSeries = new Set<string>();

/**
 * Derive the series group key for a deadline.
 * Titles ending in " N" (space + number) share a key; e.g. "Practical Test 1"
 * and "Practical Test 3" both map to "COMP1005|Practical Test".
 * Non-numbered titles form singleton keys using the full title so they never
 * accidentally merge with numbered items that share the same base name.
 */
function seriesKey(unit: string, title: string): string {
  if (/\s+\d+$/.test(title)) {
    return `${unit}|${title.replace(/\s+\d+$/, '').trim()}`;
  }
  return `${unit}|${title}`;
}

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
function showConfirmation(groups: { filename: string; items: PendingDeadline[] }[]): void {
  // Flatten all groups into a single ordered list for saveConfirmedItems
  pendingItems = groups.flatMap((g) => g.items);

  const mainSection = document.getElementById('main-section')!;
  const confirmSection = document.getElementById('confirmation-section')!;
  const confirmList = document.getElementById('confirm-list')!;
  const confirmEmpty = document.getElementById('confirm-empty')!;
  const confirmSource = document.getElementById('confirm-source')!;

  // Source label: single filename or "N PDFs"
  confirmSource.textContent =
    groups.length === 1 ? groups[0].filename : `${groups.length} PDFs`;

  confirmList.innerHTML = '';

  if (pendingItems.length === 0) {
    confirmEmpty.classList.remove('hidden');
    document.getElementById('confirm-add')!.setAttribute('disabled', 'true');
  } else {
    confirmEmpty.classList.add('hidden');
    document.getElementById('confirm-add')!.removeAttribute('disabled');

    let globalIdx = 0; // flat index into pendingItems, shared across all groups

    for (const { filename, items } of groups) {
      // Per-file section header — only shown when multiple PDFs were uploaded
      if (groups.length > 1) {
        const hdr = document.createElement('div');
        hdr.className = 'confirm-file-hdr';
        hdr.innerHTML =
          `<span class="confirm-file-name">${escapeHtml(truncate(filename, 48))}</span>` +
          `<span class="confirm-file-count">${items.length} item${items.length !== 1 ? 's' : ''}</span>`;
        confirmList.appendChild(hdr);
      }

      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = `confirm-row${item.isTBA ? ' tba' : ''}`;
        row.dataset.idx = String(globalIdx++);

        // For TBA items, show fill-in fields so the user can enter the week number.
        const tbaSemester = item.semester ?? 1;
        const tbaYear = item.year ?? defaultYear();

        const tbaFillHTML = `
          <div class="conf-tba-fill${item.isTBA ? '' : ' hidden'}">
            <span class="conf-fill-label">Set date:</span>
            <select class="conf-sem-sel" title="Semester">
              <option value="1"${tbaSemester === 1 ? ' selected' : ''}>S1</option>
              <option value="2"${tbaSemester === 2 ? ' selected' : ''}>S2</option>
            </select>
            <input class="conf-year-inp" type="number" value="${tbaYear}" min="2024" max="2035" title="Year" />
            <label class="conf-week-lbl">Wk(s)
              <input class="conf-week-inp" type="text" placeholder="e.g. 5 or 1,3,5,7" maxlength="40" title="Week number(s): single &quot;5&quot;, range &quot;1-13&quot;, or comma list &quot;1,3,5,7,9,11&quot;" />
            </label>
          </div>
        `;

        // Resolved date text — strip '#' placeholders from exactTime before display
        const displayTime = item.exactTime?.replace(/#/g, '').replace(/\s+/g, ' ').trim();
        const resolvedText = item.resolvedDate
          ? `→ ${formatDate(item.resolvedDate)}${displayTime ? ' · ' + displayTime : ''}`
          : '';

        row.innerHTML = `
          <input type="checkbox" class="conf-check" checked />
          <div class="confirm-row-fields">
            <div class="conf-inputs">
              <input type="text" class="conf-unit-input" value="${escapeHtml(item.unit)}" placeholder="Unit" maxlength="8" />
              <input type="text" class="conf-title-input" value="${escapeHtml(item.title)}" placeholder="Task name" />
            </div>
            <div class="conf-date-info">
              ${item.weekLabel ? `<span class="conf-week-label" title="${escapeHtml(item.weekLabel)}">${escapeHtml(truncate(item.weekLabel, 30))}</span>` : ''}
              ${item.calSource ? `<span class="conf-cal-badge" title="Sourced from Program Calendar">Cal</span>` : ''}
              ${item.weight ? `<span class="conf-weight-badge">${item.weight}%</span>` : ''}
              ${item.isTBA ? `<span class="conf-tba-badge">fill in ↓</span>` : ''}
              ${resolvedText ? `<span class="conf-resolved">${escapeHtml(resolvedText)}</span>` : ''}
            </div>
            ${tbaFillHTML}
          </div>
        `;

        // Pre-fill the week input for TBA items that have a known weekLabel
        // (e.g. "Week 5" inferred from the PC_TEXT table). The user only needs
        // to confirm or adjust; no need to look it up manually.
        if (item.isTBA) {
          const weekInp = row.querySelector<HTMLInputElement>('.conf-week-inp');
          if (weekInp) {
            const hintWeek = extractSingleWeek(item.weekLabel);
            if (hintWeek !== null) weekInp.value = String(hintWeek);
          }
        }

        confirmList.appendChild(row);
      });
    }
  }

  mainSection.classList.add('hidden');
  confirmSection.classList.remove('hidden');
}

/** Truncate a string to at most `max` characters, appending "…" if cut. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Return from confirmation view to the main panel. */
function hideConfirmation(): void {
  document.getElementById('main-section')!.classList.remove('hidden');
  document.getElementById('confirmation-section')!.classList.add('hidden');
  pendingItems = [];
}

/**
 * Parse a free-text week input into an array of individual week numbers.
 *
 * Supported formats:
 *   "5"            → [5]
 *   "5-7"          → [5, 6, 7]        (inclusive range)
 *   "1,3,5,7"      → [1, 3, 5, 7]     (comma-separated)
 *   "1, 3, 5, 7"   → [1, 3, 5, 7]     (spaces ignored)
 *
 * All values are clamped to 1–20 (the maximum sane semester length).
 */
function parseWeekInput(raw: string): number[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Detect a simple range like "1-13" or "1–13" (no commas)
  const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    const weeks: number[] = [];
    // Expand every week in the range, in order
    for (let w = Math.min(start, end); w <= Math.max(start, end); w++) {
      if (w >= 1 && w <= 20) weeks.push(w);
    }
    return weeks;
  }

  // Comma/space-separated list (or a single plain number)
  return trimmed
    .split(/[\s,]+/)
    .map((p) => parseInt(p.trim(), 10))
    .filter((w) => !isNaN(w) && w >= 1 && w <= 20);
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
  const rows = document.querySelectorAll<HTMLElement>('#confirm-list .confirm-row');
  const fallbackYear = defaultYear();
  let saved = 0;
  const skipped: string[] = [];

  for (const row of rows) {
    const checked = row.querySelector<HTMLInputElement>('.conf-check')?.checked;
    if (!checked) continue;

    const idx = parseInt(row.dataset.idx ?? '0', 10);
    const original = pendingItems[idx];
    if (!original) continue;

    // Read user-edited unit and title
    const unit =
      row.querySelector<HTMLInputElement>('.conf-unit-input')?.value.trim().toUpperCase() ||
      'UNKNOWN';
    const title = row.querySelector<HTMLInputElement>('.conf-title-input')?.value.trim() || 'Task';

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
        source: 'manual',
        addedAt: new Date().toISOString(),
      };
      await addDeadline(deadline);
      saved++;
    } else {
      // TBA item — read the fill-in inputs the user provided
      const semVal = row.querySelector<HTMLSelectElement>('.conf-sem-sel')?.value ?? '1';
      const yearVal = row.querySelector<HTMLInputElement>('.conf-year-inp')?.value ?? String(fallbackYear);
      const weekRaw = row.querySelector<HTMLInputElement>('.conf-week-inp')?.value.trim() ?? '';

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
          dateTBA: true,
          source: 'manual',
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
          source: 'manual',
          addedAt: new Date().toISOString(),
        };
        await addDeadline(deadline);
        saved++;
      }
    }
  }

  // Notify the user if some checked rows were skipped due to missing week
  if (skipped.length > 0) {
    const names = skipped.slice(0, 3).map((s) => `"${s}"`).join(', ');
    const extra = skipped.length > 3 ? ` and ${skipped.length - 3} more` : '';
    alert(
      `Skipped ${skipped.length} item${skipped.length > 1 ? 's' : ''} (no week entered): ${names}${extra}.\n` +
        'You can add them manually using the form.',
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

  const errorEl = document.getElementById('form-error')!;
  errorEl.classList.add('hidden');

  // Gather field values
  const unit =
    (document.getElementById('f-unit') as HTMLInputElement).value.trim().toUpperCase();
  const title = (document.getElementById('f-title') as HTMLInputElement).value.trim();
  const mode = (
    document.querySelector<HTMLInputElement>('input[name="add-mode"]:checked')
  )?.value ?? 'week';

  // Validate common fields
  if (!unit) return showFormError('Please enter a unit code.');
  if (!title) return showFormError('Please enter a task name.');

  let dueDate: Date | null = null;
  let weekLabel: string | undefined;

  if (mode === 'week') {
    // ── Week mode ──────────────────────────────────────────────────────────
    const semester = parseInt(
      (document.getElementById('f-semester') as HTMLSelectElement).value,
      10,
    ) as 1 | 2;
    const year = parseInt((document.getElementById('f-year') as HTMLInputElement).value, 10);
    const weekRaw = (document.getElementById('f-week') as HTMLInputElement).value.trim();

    if (!weekRaw) return showFormError('Please enter a week number.');
    if (isNaN(year) || year < 2024 || year > 2035) return showFormError('Please enter a valid year.');

    // Support "5" or "5-7" — use the last (end) week of a range
    const weekMatch = weekRaw.match(/(\d+)\s*[-–]\s*(\d+)/);
    const week = weekMatch ? parseInt(weekMatch[2], 10) : parseInt(weekRaw, 10);
    if (isNaN(week) || week < 1 || week > 20) return showFormError('Week must be between 1 and 20.');

    dueDate = weekToDate(semester, year, week, 0); // Monday of the week
    weekLabel =
      weekMatch ? `Weeks ${weekMatch[1]}–${weekMatch[2]}` : `Week ${week}`;
  } else {
    // ── Date mode ──────────────────────────────────────────────────────────
    const dateVal = (document.getElementById('f-date') as HTMLInputElement).value;
    const timeVal = (document.getElementById('f-time') as HTMLInputElement).value;

    if (!dateVal) return showFormError('Please select a date.');

    // Build Date object from the date + optional time inputs
    dueDate = new Date(dateVal);
    if (timeVal) {
      const [h, m] = timeVal.split(':').map(Number);
      dueDate.setHours(h, m, 0, 0);
    }
  }

  if (!dueDate) return showFormError('Could not resolve a due date.');

  const deadline: Deadline = {
    id: crypto.randomUUID(),
    title,
    unit,
    dueDate: dueDate.toISOString(),
    weekLabel,
    source: 'manual',
    addedAt: new Date().toISOString(),
  };

  await addDeadline(deadline);
  await renderDeadlines();

  // Reset the form after successful submission
  (event.target as HTMLFormElement).reset();
  // Reset year back to default (form.reset() clears it)
  (document.getElementById('f-year') as HTMLInputElement).value = String(defaultYear());
  document.getElementById('week-preview')!.classList.add('hidden');
  document.getElementById('form-error')!.classList.add('hidden');

  // Collapse the manual form after adding
  (document.getElementById('manual-details') as HTMLDetailsElement).open = false;
}

function showFormError(msg: string): void {
  const el = document.getElementById('form-error')!;
  el.textContent = msg;
  el.classList.remove('hidden');
}

/**
 * Update the live week preview text whenever the week/semester/year fields change.
 * Shows the resolved Monday date so the user can verify before adding.
 */
function updateWeekPreview(): void {
  const previewEl = document.getElementById('week-preview')!;
  const semVal = (document.getElementById('f-semester') as HTMLSelectElement).value;
  const yearVal = (document.getElementById('f-year') as HTMLInputElement).value;
  const weekVal = (document.getElementById('f-week') as HTMLInputElement).value.trim();

  if (!weekVal || !semVal || !yearVal) {
    previewEl.classList.add('hidden');
    return;
  }

  const semester = parseInt(semVal, 10) as 1 | 2;
  const year = parseInt(yearVal, 10);

  // Support ranges — use end week
  const weekMatch = weekVal.match(/(\d+)\s*[-–]\s*(\d+)/);
  const week = weekMatch ? parseInt(weekMatch[2], 10) : parseInt(weekVal, 10);

  if (isNaN(week) || isNaN(year) || week < 1 || week > 20) {
    previewEl.classList.add('hidden');
    return;
  }

  try {
    const resolved = weekToDate(semester, year, week, 0);
    previewEl.textContent = `→ Monday ${formatDate(resolved)}`;
    previewEl.classList.remove('hidden');
  } catch {
    previewEl.classList.add('hidden');
  }
}

// ── ICS export ────────────────────────────────────────────────────────────────

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
async function exportICS(): Promise<void> {
  const deadlines = await loadDeadlines();
  if (deadlines.length === 0) return;

  const events: EventAttributes[] = deadlines.map((d) => {
    const due = new Date(d.dueDate);
    const hasTime = due.getHours() !== 0 || due.getMinutes() !== 0;

    // Build VALARM alarms
    const alarms: EventAttributes['alarms'] = [
      {
        action: 'display',
        description: `${d.unit} — ${d.title} due in 3 days`,
        trigger: { before: true, days: 3 },
      },
      {
        action: 'display',
        description: `${d.unit} — ${d.title} due tomorrow`,
        trigger: { before: true, days: 1 },
      },
    ];

    // Add 1-hour reminder only for timed events (not all-day)
    if (hasTime) {
      alarms.push({
        action: 'display',
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
        startOutputType: 'local',
        duration: { hours: 1 },
        description: d.weekLabel ? `${d.weekLabel}\n${d.unit} — ${d.title}` : `${d.unit} — ${d.title}`,
        status: 'CONFIRMED',
        busyStatus: 'BUSY',
        alarms,
      };
      return event;
    } else {
      // All-day event: start = [year, month, day]; duration required by ics library
      const event: EventAttributes = {
        title: `${d.unit} — ${d.title}`,
        start: [due.getFullYear(), due.getMonth() + 1, due.getDate()],
        duration: { days: 1 },
        description: d.weekLabel ? `${d.weekLabel}\n${d.unit} — ${d.title}` : `${d.unit} — ${d.title}`,
        status: 'CONFIRMED',
        busyStatus: 'FREE',
        alarms,
      };
      return event;
    }
  });

  const { error, value } = createEvents(events);

  if (error || !value) {
    console.error('ICS generation error:', error);
    return;
  }

  // Build a meaningful filename using current year + earliest deadline's semester
  const year = defaultYear();
  const filename = `Curtin Deadlines ${year}.ics`;

  // Ask the background service worker to trigger the download
  chrome.runtime.sendMessage({ command: command.downloadICS, value, filename });
}

// ── Dark mode ─────────────────────────────────────────────────────────────────

/** Toggle dark mode and persist the preference. */
async function toggleDarkMode(): Promise<void> {
  const isDark = document.body.classList.toggle('dark');
  await chrome.storage.local.set({ darkMode: isDark });
  // Update the toggle button emoji
  const btn = document.getElementById('theme-toggle')!;
  btn.textContent = isDark ? '☀️' : '🌙';
}

/** Load the saved dark mode preference and apply it on startup. */
async function applyDarkMode(): Promise<void> {
  const result = await chrome.storage.local.get('darkMode');
  const isDark = result.darkMode === true;
  if (isDark) {
    document.body.classList.add('dark');
    document.getElementById('theme-toggle')!.textContent = '☀️';
  }
}

// ── PDF drop zone wiring ──────────────────────────────────────────────────────

function wirePDFDropZone(): void {
  const dropZone = document.getElementById('drop-zone')!;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const parseProgress = document.getElementById('parse-progress')!;
  const parseStatus = document.getElementById('parse-status')!;

  /**
   * Parse up to 4 PDF files in sequence and show a combined confirmation.
   * Files that fail to parse (bad PDF, scanned image, etc.) are skipped with a
   * note to the user — valid files still proceed to the confirmation screen.
   */
  async function processFiles(rawFiles: File[]): Promise<void> {
    // Filter to PDFs only
    const pdfs = rawFiles.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length === 0) {
      // If only .ics files were dropped, the ICS handler (wireIcsSection) deals
      // with them separately — don't alert the user with a confusing message.
      const hasOnlyIcs = rawFiles.every((f) => f.name.toLowerCase().endsWith('.ics'));
      if (!hasOnlyIcs) alert('Please select PDF files.');
      return;
    }
    // Enforce the 4-file limit
    if (pdfs.length > 4) {
      alert('Please upload at most 4 PDFs at a time.');
      return;
    }

    parseProgress.classList.remove('hidden');

    const groups: { filename: string; items: PendingDeadline[] }[] = [];
    const failed: string[] = [];

    for (let i = 0; i < pdfs.length; i++) {
      const file = pdfs[i];
      // Show which file is currently being processed
      parseStatus.textContent =
        pdfs.length > 1 ? `Parsing ${i + 1} of ${pdfs.length}: ${file.name}…` : 'Extracting text…';

      try {
        const text = await extractPDFText(file);

        // Guard against scanned/image-only PDFs
        if (text.replace(/\s+/g, '').length < 50) {
          failed.push(`${file.name} (no text layer — may be a scanned image)`);
          continue;
        }

        // Extract unit code, semester, and year from filename
        const unitCode = file.name.match(/([A-Z]{2,4}\d{4})/)?.[1] ?? '';
        const semFromFilename = file.name.match(/[Ss]emester\s*([12])/)?.[1];
        const yearFromFilename = file.name.match(/\b(20\d{2})\b/)?.[1];
        const fileSemester = semFromFilename ? (parseInt(semFromFilename, 10) as 1 | 2) : 1;
        const fileYear = yearFromFilename ? parseInt(yearFromFilename, 10) : defaultYear();

        // Parse assessment schedule + program calendar, then merge and number
        const scheduleItems = parseAssessments(text, unitCode, fileYear, fileSemester);
        const calendarItems = parseProgramCalendar(text, unitCode, fileYear, fileSemester);
        const items = addSequenceNumbers(mergeWithCalendar(scheduleItems, calendarItems));

        // Attach unit name (parsed from PDF header) to every item from this file
        const unitName = parseUnitName(text, unitCode);
        if (unitName) {
          items.forEach((item) => { item.unitName = unitName; });
        }

        groups.push({ filename: file.name, items });
      } catch (err) {
        console.error(`Failed to parse ${file.name}:`, err);
        failed.push(file.name);
      }
    }

    parseProgress.classList.add('hidden');

    // If everything failed and nothing succeeded, bail out
    if (groups.length === 0) {
      alert(
        `Could not extract deadlines from ${failed.length === 1 ? 'this PDF' : 'any of the PDFs'}:\n` +
          failed.join('\n') +
          '\n\nPlease add deadlines manually using the form.',
      );
      return;
    }

    // Show confirmation for whatever succeeded
    showConfirmation(groups);

    // If some files failed alongside successes, notify after a short delay so
    // the confirmation screen is already visible when the alert appears.
    if (failed.length > 0) {
      setTimeout(() => {
        alert(
          `Note: ${failed.length} file${failed.length > 1 ? 's' : ''} could not be parsed:\n` +
            failed.join('\n'),
        );
      }, 150);
    }
  }

  // ── Drag-and-drop events ─────────────────────────────────────────────────
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) processFiles(files);
  });

  // ── Click to browse ──────────────────────────────────────────────────────
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    if (files.length) {
      processFiles(files);
      fileInput.value = ''; // reset so the same files can be re-selected
    }
  });
}

// ── Settings storage ──────────────────────────────────────────────────────────

interface AppSettings {
  // Pre-fills all semester dropdowns (API section, manual form, TBA fill-ins)
  defaultSemester: 1 | 2;
  // Controls where overdue cards are shown relative to upcoming ones
  overduePosition: 'top' | 'bottom';
}

/** Load app settings from chrome.storage.local (returns defaults if not set). */
async function loadSettings(): Promise<AppSettings> {
  const result = await chrome.storage.local.get('appSettings');
  const saved = result.appSettings ?? {};
  return {
    defaultSemester: (saved.defaultSemester as 1 | 2) ?? 1,
    overduePosition: (saved.overduePosition as 'top' | 'bottom') ?? 'bottom',
  };
}

/** Persist app settings to chrome.storage.local. */
async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const current = await loadSettings();
  await chrome.storage.local.set({ appSettings: { ...current, ...settings } });
}

// ── Settings panel ────────────────────────────────────────────────────────────

/** Show settings section, hide main section. */
function openSettings(): void {
  document.getElementById('main-section')!.classList.add('hidden');
  document.getElementById('settings-section')!.classList.remove('hidden');
}

/** Hide settings section, show main section. */
function closeSettings(): void {
  document.getElementById('settings-section')!.classList.add('hidden');
  document.getElementById('main-section')!.classList.remove('hidden');
}

/**
 * Apply the stored default semester to all semester selects:
 * the API section, the manual form, and any TBA card fill-in selects.
 * @param sem  1 or 2
 */
function applyDefaultSemester(sem: 1 | 2): void {
  // API section semester
  const apiSem = document.getElementById('api-semester') as HTMLSelectElement | null;
  if (apiSem) apiSem.value = String(sem);

  // Manual form semester
  const fSem = document.getElementById('f-semester') as HTMLSelectElement | null;
  if (fSem) fSem.value = String(sem);

  // TBA card fill-in selects (class .card-sem-sel rendered inside deadline cards)
  document.querySelectorAll<HTMLSelectElement>('.card-sem-sel').forEach((sel) => {
    sel.value = String(sem);
  });

  // Confirmation section TBA fill-in selects (.conf-sem-sel)
  document.querySelectorAll<HTMLSelectElement>('.conf-sem-sel').forEach((sel) => {
    sel.value = String(sem);
  });
}

/**
 * Export all deadlines as a JSON file download.
 * Uses the anchor + Blob trick — no background service worker needed.
 */
function exportJSON(deadlines: Deadline[]): void {
  const json = JSON.stringify(deadlines, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `curtin-deadlines-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  // Release the object URL after a short delay so the download can start
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/**
 * Import deadlines from a JSON file. Validates structure before saving.
 * Merges with existing deadlines — duplicates (same id) are overwritten.
 */
async function importJSON(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result as string);

        // Validate that it's an array of deadline-shaped objects
        if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of deadlines.');
        for (const item of parsed) {
          if (!item.id || !item.title || !item.unit || !item.dueDate) {
            throw new Error('One or more items are missing required fields (id, title, unit, dueDate).');
          }
        }

        // Merge: load existing, remove any with same id, then push imported
        const existing = await loadDeadlines();
        const importedIds = new Set((parsed as Deadline[]).map((d) => d.id));
        const merged = existing.filter((d) => !importedIds.has(d.id)).concat(parsed as Deadline[]);
        merged.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

        await saveDeadlines(merged);
        await renderDeadlines();
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}

/** Delete every deadline and re-render the (now empty) list. */
async function clearAllDeadlines(): Promise<void> {
  await saveDeadlines([]);
  await renderDeadlines();
}

/**
 * Wire up all interactive elements inside #settings-section.
 * Called once from init().
 */
async function wireSettingsSection(): Promise<void> {
  // Load current settings to pre-fill controls
  const settings = await loadSettings();

  // Pre-fill the default-semester select
  const setSemesterSel = document.getElementById('set-semester') as HTMLSelectElement;
  setSemesterSel.value = String(settings.defaultSemester);

  // Pre-select the overdue position radio
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="overdue-pos"]');
  radios.forEach((r) => { r.checked = r.value === settings.overduePosition; });

  // ── Back button ──────────────────────────────────────────────────────────
  document.getElementById('settings-back')!.addEventListener('click', closeSettings);

  // ── Gear button in header ────────────────────────────────────────────────
  document.getElementById('settings-btn')!.addEventListener('click', openSettings);

  // ── Default semester change ───────────────────────────────────────────────
  setSemesterSel.addEventListener('change', async () => {
    const sem = parseInt(setSemesterSel.value, 10) as 1 | 2;
    await saveSettings({ defaultSemester: sem });
    applyDefaultSemester(sem);
  });

  // ── Overdue position change ───────────────────────────────────────────────
  radios.forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      const pos = r.value as 'top' | 'bottom';
      overduePositionCache = pos; // update module-level cache so renderDeadlines picks it up
      await saveSettings({ overduePosition: pos });
      await renderDeadlines();
    });
  });

  // ── Export JSON ───────────────────────────────────────────────────────────
  document.getElementById('set-export-json')!.addEventListener('click', async () => {
    const deadlines = await loadDeadlines();
    exportJSON(deadlines);
  });

  // ── Import JSON ───────────────────────────────────────────────────────────
  const importJsonBtn = document.getElementById('set-import-json-btn')!;
  const importJsonFile = document.getElementById('set-import-json-file') as HTMLInputElement;

  // Button click → trigger hidden file input
  importJsonBtn.addEventListener('click', () => importJsonFile.click());

  importJsonFile.addEventListener('change', async () => {
    const file = importJsonFile.files?.[0];
    if (!file) return;
    importJsonFile.value = ''; // reset so the same file can be re-imported
    try {
      await importJSON(file);
      closeSettings();
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── Clear all deadlines ───────────────────────────────────────────────────
  const clearAllBtn = document.getElementById('set-clear-all')!;
  const clearConfirm = document.getElementById('set-clear-confirm')!;

  // First click: show the inline "Delete all?" confirm row
  clearAllBtn.addEventListener('click', () => {
    clearAllBtn.classList.add('hidden');
    clearConfirm.classList.remove('hidden');
  });

  // Yes — delete and return to main
  document.getElementById('set-clear-yes')!.addEventListener('click', async () => {
    await clearAllDeadlines();
    // Reset confirm UI state
    clearConfirm.classList.add('hidden');
    clearAllBtn.classList.remove('hidden');
    closeSettings();
  });

  // No — cancel without deleting
  document.getElementById('set-clear-no')!.addEventListener('click', () => {
    clearConfirm.classList.add('hidden');
    clearAllBtn.classList.remove('hidden');
  });

  // ── Reset "Did you submit?" prompt ───────────────────────────────────────
  const resetPromptBtn = document.getElementById('set-reset-prompt')!;
  const resetMsg = document.getElementById('set-reset-msg')!;

  resetPromptBtn.addEventListener('click', async () => {
    await saveSkipSubmitConfirm(false);
    // Show a brief confirmation message that auto-hides after 3 s
    resetMsg.classList.remove('hidden');
    setTimeout(() => resetMsg.classList.add('hidden'), 3000);
  });

  // Open the developer test panel in a new tab
  document.getElementById('set-open-test-panel')!.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('testPage.html') });
  });
}

// ── ICS import ────────────────────────────────────────────────────────────────

/** A single event extracted from an .ics (iCalendar) file. */
interface IcsEvent {
  summary: string;       // raw SUMMARY value
  dtstart: Date;         // parsed start date/time
  dtend?: Date;          // parsed end date/time (optional)
  unitCode?: string;     // first Curtin unit code found in summary, e.g. "COMP1005"
}

/** One resolved match: a TBA deadline paired with an ICS event. */
interface IcsMatch {
  deadlineId: string;
  deadlineTitle: string;
  deadlineUnit: string;
  event: IcsEvent;
  /** The date to apply — may differ from event.dtstart when a "N hours after" offset is used. */
  resolvedDate: Date;
  confidence: 'high' | 'low';
  /** Human-readable description of how the match was made, e.g. "Week 5 lab" or "24h after Week 7 workshop". */
  matchReason?: string;
}

/**
 * Parse an iCalendar (.ics) text string and return a list of events.
 *
 * Handles three DTSTART formats:
 *   - `DTSTART:20261109T090000Z`              → UTC datetime
 *   - `DTSTART;TZID=Australia/Perth:20261109T090000` → Perth local time (UTC+8, no DST)
 *   - `DTSTART;VALUE=DATE:20261109`           → all-day date (midnight local)
 */
function parseIcs(text: string): IcsEvent[] {
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
 *   DTSTART:20261109T090000Z            → UTC
 *   DTSTART;TZID=Australia/Perth:20261109T090000  → Perth (UTC+8, no DST)
 *   DTSTART;VALUE=DATE:20261109         → all-day (midnight local)
 */
function parseIcsDate(line: string): Date | null {
  // Extract the value part (everything after the last colon in the property line)
  const colonIdx = line.lastIndexOf(':');
  if (colonIdx === -1) return null;
  const value = line.slice(colonIdx + 1).trim();

  // UTC datetime: "20261109T090000Z"
  const utcMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (utcMatch) {
    return new Date(Date.UTC(
      parseInt(utcMatch[1]), parseInt(utcMatch[2]) - 1, parseInt(utcMatch[3]),
      parseInt(utcMatch[4]), parseInt(utcMatch[5]), parseInt(utcMatch[6]),
    ));
  }

  // Local datetime with TZID: "20261109T090000" (Perth = UTC+8, WA has no DST)
  const localMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (localMatch) {
    const isPerth = line.includes('Australia/Perth');
    if (isPerth) {
      // UTC+8 — subtract 8 hours to get UTC
      return new Date(Date.UTC(
        parseInt(localMatch[1]), parseInt(localMatch[2]) - 1, parseInt(localMatch[3]),
        parseInt(localMatch[4]) - 8, parseInt(localMatch[5]), parseInt(localMatch[6]),
      ));
    }
    // Unknown TZID — treat as local browser time
    return new Date(
      parseInt(localMatch[1]), parseInt(localMatch[2]) - 1, parseInt(localMatch[3]),
      parseInt(localMatch[4]), parseInt(localMatch[5]), parseInt(localMatch[6]),
    );
  }

  // All-day date: "20261109"
  const dateOnlyMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnlyMatch) {
    return new Date(
      parseInt(dateOnlyMatch[1]), parseInt(dateOnlyMatch[2]) - 1, parseInt(dateOnlyMatch[3]),
    );
  }

  return null;
}

/**
 * Match ICS events to TBA deadlines.
 *
 * Scoring:
 *   - 'high': event unitCode matches deadline unit AND summary contains an
 *     exam/assessment keyword that appears in the deadline title
 *   - 'low': event unitCode matches but no keyword overlap
 *
 * Returns at most one match per deadline (the highest-scoring event).
 */
function matchIcsToDeadlines(events: IcsEvent[], deadlines: Deadline[]): IcsMatch[] {
  // Only consider deadlines where the date is TBA
  const tbaDeadlines = deadlines.filter((d) => d.dateTBA);
  const matches: IcsMatch[] = [];

  // EXAM_KEYWORDS is defined at module level — reused here for keyword matching
  for (const deadline of tbaDeadlines) {
    // Find events whose unit code matches this deadline's unit
    const candidates = events.filter(
      (ev) => ev.unitCode?.toUpperCase() === deadline.unit.toUpperCase(),
    );
    if (candidates.length === 0) continue;

    // Score each candidate
    let bestMatch: IcsEvent | null = null;
    let bestConfidence: 'high' | 'low' = 'low';

    for (const ev of candidates) {
      const evLower = ev.summary.toLowerCase();
      const titleLower = deadline.title.toLowerCase();

      // Check if any exam keyword appears in both event summary and deadline title
      const keywordInSummary = EXAM_KEYWORDS.some((kw) => evLower.includes(kw));
      const keywordInTitle   = EXAM_KEYWORDS.some((kw) => titleLower.includes(kw));

      const confidence: 'high' | 'low' = (keywordInSummary && keywordInTitle) ? 'high' : 'low';

      // Prefer 'high' over 'low'; take the first high match, or first low if no high
      if (!bestMatch || (confidence === 'high' && bestConfidence === 'low')) {
        bestMatch = ev;
        bestConfidence = confidence;
      }
    }

    if (bestMatch) {
      matches.push({
        deadlineId: deadline.id,
        deadlineTitle: deadline.title,
        deadlineUnit: deadline.unit,
        event: bestMatch,
        // resolvedDate is the event start time (no offset for exam-type matches)
        resolvedDate: bestMatch.dtstart,
        confidence: bestConfidence,
      });
    }
  }

  return matches;
}

/**
 * Broad keywords used only for ICS event confidence boosting — if the same keyword
 * appears in both the ICS event summary and the deadline title, the match is 'high'.
 * This is intentionally broad (includes "test", "quiz") for similarity detection.
 * NOT used for the "Exam period" TBA section — use isFinalExamType() for that.
 */
const EXAM_KEYWORDS = [
  'exam', 'final', 'test', 'quiz', 'assessment', 'mid-sem', 'mid sem', 'midsem',
];

/**
 * Returns true only when the title represents a FINAL EXAM scheduled in the
 * official exam period. In-semester assessments (mid-semester tests, quizzes,
 * practicals, online tests, lab reports, workshops) return false.
 *
 * Examples:
 *   "Final Examination"   → true   (scheduled in exam timetable)
 *   "Final Exam"          → true
 *   "Examination"         → true   (standalone "examination" = end-of-semester)
 *   "Mid-Semester Test"   → false  (in-semester, week-known)
 *   "Online Test"         → false  (recurring, not exam-period)
 *   "Practical Test"      → false  (in-lab, in-semester)
 *   "Quiz"                → false  (in-semester)
 *   "Laboratory Report"   → false  (in-semester)
 */
function isFinalExamType(title: string): boolean {
  const lower = title.toLowerCase();
  // In-semester disqualifiers — these are never scheduled in the exam period
  if (/\b(mid[\s-]?sem(ester)?|midterm|prac(tical)?\b|lab\b|quiz\b|worksheet|workshop|tutorial|tut\b|online\s+test|weekly|e-?test|midsem)\b/.test(lower)) return false;
  // "final" signals end-of-semester regardless of the noun that follows
  if (/\bfinal\b/.test(lower)) return true;
  // Standalone "exam" or "examination" without any in-semester qualifier
  return /\b(exam|examination)\b/.test(lower);
}

/**
 * Extract a single teaching week number from a weekLabel string.
 * Returns null when no single week is found (ranges like "Weeks 2–12", "Fortnightly", or blank).
 *
 * Examples:
 *   "Week 7"                          → 7
 *   "During Week 5 lab"               → 5
 *   "24 hours after workshop Week 10" → 10
 *   "Teaching weeks 2-12"             → null  (plural "weeks" doesn't match)
 *   "Fortnightly"                     → null
 */
function extractSingleWeek(weekLabel: string | undefined): number | null {
  if (!weekLabel) return null;
  const m = /\bweek\s+(\d{1,2})\b/i.exec(weekLabel);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Second matching pass: resolve TBA deadlines that reference a specific teaching
 * week and session type (lab, workshop, tutorial, lecture) in their weekLabel.
 *
 * For each TBA deadline:
 *   1. Extract a single week number from weekLabel (e.g. "Week 7" → 7).
 *      Ranges like "Weeks 2-12" or "Fortnightly" produce no match → skip.
 *   2. Detect a session-type keyword from title + weekLabel
 *      (lab / workshop / tutorial / lecture).
 *   3. Extract an optional "N hours after" offset from weekLabel.
 *   4. Compute the Mon–Sun window for that teaching week.
 *   5. Find candidate ICS events for the same unit within that window.
 *   6. Score candidates: events whose summary contains a matching session keyword
 *      get 'high' confidence; others get 'low'.
 *   7. Apply the hours offset to get resolvedDate.
 *   8. Build a human-readable matchReason string.
 */
function matchIcsByWeekAndSession(
  events: IcsEvent[],
  deadlines: Deadline[],
  semester: 1 | 2,
  year: number,
): IcsMatch[] {
  // Only consider deadlines where the date is still TBA
  const tbaDeadlines = deadlines.filter((d) => d.dateTBA);
  const matches: IcsMatch[] = [];

  // Session-type keyword groups — first match in each group wins
  const SESSION_TYPES: { keys: string[]; tag: string }[] = [
    { keys: ['lab', 'laboratory', 'practical', 'prac'], tag: 'lab'      },
    { keys: ['workshop'],                               tag: 'workshop' },
    { keys: ['tutorial', 'tut'],                        tag: 'tutorial' },
    { keys: ['lecture', 'lect'],                        tag: 'lecture'  },
  ];

  for (const deadline of tbaDeadlines) {
    const weekLabelLower = (deadline.weekLabel ?? '').toLowerCase();
    const titleLower     = deadline.title.toLowerCase();

    // ── Step A: extract a single teaching week number ────────────────────────
    // Delegates to extractSingleWeek() — ranges like "Weeks 2-12" and
    // "Fortnightly" return null and are skipped.
    const week = extractSingleWeek(deadline.weekLabel);
    if (week === null) continue;

    // ── Step B: detect session type from title and/or weekLabel ─────────────
    let sessionTag: string | null = null;
    for (const { keys, tag } of SESSION_TYPES) {
      const inTitle     = keys.some((k) => titleLower.includes(k));
      const inWeekLabel = keys.some((k) => weekLabelLower.includes(k));
      if (inTitle || inWeekLabel) {
        sessionTag = tag;
        break;
      }
    }

    // ── Step C: extract "N hours after" offset from weekLabel ────────────────
    const hoursMatch = /(\d+)\s*hours?\s*(after|following)/i.exec(deadline.weekLabel ?? '');
    const hoursAfter = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;

    // ── Step D: compute the Mon–Sun window for this teaching week ────────────
    const weekStart = weekToDate(semester, year, week, 0); // Monday 00:00 local
    const weekEnd   = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6); // advance to Sunday
    weekEnd.setHours(23, 59, 59, 999);

    // ── Step E: find candidate ICS events within the week window ─────────────
    const candidates = events.filter((ev) => {
      if (ev.unitCode?.toUpperCase() !== deadline.unit.toUpperCase()) return false;
      return ev.dtstart >= weekStart && ev.dtstart <= weekEnd;
    });
    if (candidates.length === 0) continue;

    // ── Step F: score candidates by session type ─────────────────────────────
    // If a session tag was detected, prefer events whose summary contains a
    // matching keyword. Ties are broken by earliest event time.
    type Scored = { ev: IcsEvent; score: number };
    const scored: Scored[] = candidates.map((ev) => {
      const evLower = ev.summary.toLowerCase();
      const hasTag  = sessionTag
        ? SESSION_TYPES.find((s) => s.tag === sessionTag)!.keys.some((k) => evLower.includes(k))
        : false;
      return { ev, score: hasTag ? 1 : 0 };
    });

    // Sort: highest score first, then earliest start time
    scored.sort((a, b) => b.score - a.score || a.ev.dtstart.getTime() - b.ev.dtstart.getTime());
    const best = scored[0].ev;
    const bestScore = scored[0].score;

    // ── Step G: compute resolvedDate with optional hours offset ──────────────
    const resolvedDate = new Date(best.dtstart.getTime());
    if (hoursAfter > 0) {
      resolvedDate.setTime(resolvedDate.getTime() + hoursAfter * 3_600_000);
    }

    // ── Step H: build a human-readable match reason ──────────────────────────
    let matchReason: string;
    if (sessionTag && hoursAfter > 0) {
      matchReason = `${hoursAfter}h after Week ${week} ${sessionTag}`;
    } else if (sessionTag) {
      matchReason = `Week ${week} ${sessionTag}`;
    } else {
      matchReason = `Week ${week} class`;
    }

    // ── Step I: push result ───────────────────────────────────────────────────
    // 'high' only when a session keyword matched the event summary directly;
    // 'low' when the match is unit+week only (no session type) or the session
    // type wasn't found in the event summary.
    const confidence: 'high' | 'low' = (sessionTag && bestScore === 1) ? 'high' : 'low';

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

/** Units and semester/year extracted from a timetable .ics file. */
interface TimetableInfo {
  units: string[];    // unique Curtin unit codes found across all events
  semester: 1 | 2;   // inferred from earliest event date (Feb–Jun = S1, Jul–Nov = S2)
  year: number;       // year of the earliest event
}

/**
 * Analyse a set of parsed ICS events to detect whether they represent a Curtin
 * class timetable, and if so, which unit codes and semester/year are involved.
 *
 * Unit codes are extracted from SUMMARY fields.
 * Semester is inferred from the month of the earliest event:
 *   Feb–Jun  → Semester 1
 *   Jul–Nov  → Semester 2 (anything outside this range also defaults to 2)
 */
function detectTimetableUnits(events: IcsEvent[]): TimetableInfo {
  // Collect unique unit codes across all events (filter out undefined)
  const units = [...new Set(
    events.map((e) => e.unitCode).filter((c): c is string => !!c),
  )].sort();

  // Find the earliest event date to infer semester and year
  const earliest = events.reduce<Date | null>((min, e) => {
    return !min || e.dtstart < min ? e.dtstart : min;
  }, null) ?? new Date();

  const year = earliest.getFullYear();
  const month = earliest.getMonth() + 1; // 1-based

  // Semester 1 runs Feb–Jun, Semester 2 runs Jul–Nov
  const semester: 1 | 2 = month >= 2 && month <= 6 ? 1 : 2;

  return { units, semester, year };
}

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
function showIcsSection(timetable: TimetableInfo | null, matches: IcsMatch[]): void {
  // Swap main → ICS panel
  document.getElementById('main-section')!.classList.add('hidden');
  document.getElementById('ics-section')!.classList.remove('hidden');

  const hasUnits   = !!(timetable && timetable.units.length > 0);
  const hasMatches = matches.length > 0;

  // ── Sub-section A: unit auto-fetch ───────────────────────────────────────
  const unitsSec = document.getElementById('ics-units-section')!;
  unitsSec.classList.toggle('hidden', !hasUnits);

  if (hasUnits) {
    const heading = document.getElementById('ics-units-heading')!;
    heading.textContent =
      `${timetable!.units.length} unit${timetable!.units.length !== 1 ? 's' : ''} detected — fetch their deadlines`;

    const unitsList = document.getElementById('ics-units-list')!;
    unitsList.innerHTML = '';

    for (const unit of timetable!.units) {
      const row = document.createElement('div');
      row.className = 'ics-unit-row';
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
  document.getElementById('ics-divider')!.classList.toggle('hidden', !(hasUnits && hasMatches));

  // ── Sub-section B: exam-date resolution ──────────────────────────────────
  const examsSec = document.getElementById('ics-exams-section')!;
  examsSec.classList.toggle('hidden', !hasMatches);

  if (hasMatches) {
    const hintEl = document.getElementById('ics-hint')!;
    hintEl.textContent =
      `${matches.length} exam date${matches.length !== 1 ? 's' : ''} matched to TBA deadlines`;

    const listEl = document.getElementById('ics-list')!;
    listEl.innerHTML = '';

    for (const match of matches) {
      const row = document.createElement('div');
      row.className = `ics-match-row${match.confidence === 'low' ? ' low' : ''}`;
      row.dataset.id  = match.deadlineId;
      // Use resolvedDate for data-iso — may differ from event.dtstart when a "N hours after" offset was applied
      row.dataset.iso = match.resolvedDate.toISOString();

      // Format the resolved date: "Mon 9 Nov 2026, 9:00 am"
      const dateStr = match.resolvedDate.toLocaleDateString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      });
      const h = match.resolvedDate.getHours();
      const m = match.resolvedDate.getMinutes();
      const hasTime = h !== 0 || m !== 0;
      const timeStr = hasTime
        ? ', ' + match.resolvedDate.toLocaleTimeString('en-AU', {
            hour: 'numeric', minute: '2-digit', hour12: true,
          })
        : '';

      // Dim label for low-confidence matches
      const verifyLabel = match.confidence === 'low'
        ? ' <span style="font-size:10px;opacity:0.6">[verify]</span>'
        : '';

      // Show match reason beneath the label (e.g. "Week 5 lab", "24h after Week 7 workshop")
      const reasonHtml = match.matchReason
        ? `<span style="font-size:10px;opacity:0.6;display:block">${escapeHtml(match.matchReason)}</span>`
        : '';

      row.innerHTML = `
        <input type="checkbox" ${match.confidence === 'high' ? 'checked' : ''} />
        <span class="ics-match-label">
          <strong>${escapeHtml(match.deadlineUnit)}</strong> — ${escapeHtml(match.deadlineTitle)}${verifyLabel}
          ${reasonHtml}
        </span>
        <span class="ics-match-date">${escapeHtml(dateStr)}${escapeHtml(timeStr)}</span>
      `;
      listEl.appendChild(row);
    }
  }
}

/**
 * Wire up the ICS import section: the inline import button, file inputs,
 * the auto-fetch button, the exam-apply button, and the back button.
 * Also extends the PDF drop-zone (capture phase) to route .ics drops here.
 * Called once from init().
 */
function wireIcsSection(): void {
  const icsBtn   = document.getElementById('ics-btn')!;
  const icsInput = document.getElementById('ics-input') as HTMLInputElement;

  /** Helper: close the ICS section and return to the main panel. */
  function closeIcs(): void {
    document.getElementById('ics-section')!.classList.add('hidden');
    document.getElementById('main-section')!.classList.remove('hidden');
  }

  /**
   * Parse a .ics file, detect timetable unit codes, match exam events to TBA
   * deadlines, then show the ICS section or an inline status if nothing matched.
   */
  async function handleIcsFile(file: File): Promise<void> {
    const text   = await file.text();
    const events = parseIcs(text);

    if (events.length === 0) {
      icsBtn.textContent = 'No events found in .ics file.';
      setTimeout(() => { icsBtn.textContent = 'Import .ics timetable'; }, 3000);
      return;
    }

    // Detect unit codes + semester from the timetable events
    const timetable = detectTimetableUnits(events);

    // Load current TBA deadlines for both matching passes
    const deadlines = await loadDeadlines();

    // Pass 1: exam-keyword matching (exams, tests, mid-sem, etc.)
    const examMatches = matchIcsToDeadlines(events, deadlines);

    // Pass 2: week + session-type matching (labs, workshops, tutorials due "Week N")
    const sessionMatches = matchIcsByWeekAndSession(
      events, deadlines, timetable.semester, timetable.year,
    );

    // Merge: exam pass takes priority; session pass fills remaining TBA deadlines
    const seenIds = new Set(examMatches.map((m) => m.deadlineId));
    const combined = [
      ...examMatches,
      ...sessionMatches.filter((m) => !seenIds.has(m.deadlineId)),
    ];

    // Nothing useful in this file
    if (timetable.units.length === 0 && combined.length === 0) {
      icsBtn.textContent = 'No matching items found.';
      setTimeout(() => { icsBtn.textContent = 'Import .ics timetable'; }, 3000);
      return;
    }

    showIcsSection(
      timetable.units.length > 0 ? timetable : null,
      combined,
    );
  }

  // ── Inline "Import .ics timetable" button ─────────────────────────────────
  icsBtn.addEventListener('click', () => icsInput.click());

  icsInput.addEventListener('change', async () => {
    const file = icsInput.files?.[0];
    if (!file) return;
    icsInput.value = '';
    await handleIcsFile(file);
  });

  // ── Drop-zone extension: capture .ics drops before processFiles() sees them ─
  // We listen in the capture phase so this runs before the PDF handler's bubble
  // listener. processFiles() already ignores .ics-only drops gracefully.
  const dropZone = document.getElementById('drop-zone')!;
  dropZone.addEventListener('drop', (e) => {
    const files    = [...(e.dataTransfer?.files ?? [])];
    const icsFiles = files.filter((f) => f.name.toLowerCase().endsWith('.ics'));
    for (const f of icsFiles) handleIcsFile(f);
  }, true); // capture phase

  // Also intercept .ics files chosen through the hidden #file-input browse dialog.
  // We listen in capture so this fires before wirePDFDropZone's bubble listener,
  // which already filters to .pdf anyway.
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const allFiles = [...(fileInput.files ?? [])];
    const icsFiles = allFiles.filter((f) => f.name.toLowerCase().endsWith('.ics'));
    for (const f of icsFiles) await handleIcsFile(f);
  }, true); // capture phase

  // ── Back button ───────────────────────────────────────────────────────────
  document.getElementById('ics-back')!.addEventListener('click', closeIcs);

  // ── Sub-section A: fetch outlines for all checked unit codes ─────────────
  const fetchBtn = document.getElementById('ics-fetch-btn') as HTMLButtonElement;

  fetchBtn.addEventListener('click', async () => {
    // Collect all checked unit rows
    const rows = document.querySelectorAll<HTMLElement>('.ics-unit-row');
    const toFetch: Array<{ unit: string; semester: 1 | 2; year: number }> = [];

    for (const row of rows) {
      const chk = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!chk?.checked) continue;
      const unit     = row.dataset.unit;
      const semester = parseInt(row.dataset.semester ?? '1', 10) as 1 | 2;
      const year     = parseInt(row.dataset.year ?? String(defaultYear()), 10);
      if (unit) toFetch.push({ unit, semester, year });
    }

    if (toFetch.length === 0) return;

    // Show loading state on the button while fetches are in flight
    fetchBtn.disabled = true;
    fetchBtn.textContent =
      `Fetching ${toFetch.length} unit${toFetch.length !== 1 ? 's' : ''}…`;

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
    fetchBtn.textContent = 'Fetch deadlines for selected units';

    // Partition into successes and failures
    const groups: { filename: string; items: PendingDeadline[] }[] = [];
    const failed: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value.items.length > 0) {
        groups.push(result.value);
      } else {
        // Either rejected or returned zero assessments
        failed.push(toFetch[i].unit);
      }
    }

    if (groups.length === 0) {
      alert(
        `Couldn't fetch outlines for: ${failed.join(', ')}.\n` +
        `Check that the unit codes and semester are correct.`,
      );
      return;
    }

    // Close ICS section and hand off to the existing confirmation checklist
    closeIcs();
    showConfirmation(groups);

    // If some units failed alongside successes, notify after a short delay
    if (failed.length > 0) {
      setTimeout(() => {
        alert(`Note: couldn't fetch outlines for ${failed.join(', ')}.`);
      }, 150);
    }
  });

  // ── Sub-section B: apply checked exam dates to TBA deadlines ─────────────
  document.getElementById('ics-apply')!.addEventListener('click', async () => {
    const rows = document.querySelectorAll<HTMLElement>('.ics-match-row');

    for (const row of rows) {
      const chk = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!chk?.checked) continue;

      const id      = row.dataset.id;
      const isoDate = row.dataset.iso; // set by showIcsSection()
      if (!id || !isoDate) continue;

      await setDeadlineDate(id, isoDate);
    }

    closeIcs();
    await renderDeadlines();
  });
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Apply saved dark mode before rendering to avoid flash
  await applyDarkMode();

  // ── Load settings before first render so overduePositionCache is ready ──
  const settings = await loadSettings();
  overduePositionCache = settings.overduePosition;

  // Render the initial deadline list
  await renderDeadlines();

  // Apply the stored default semester to all dropdowns after first render
  applyDefaultSemester(settings.defaultSemester);

  // ── Settings panel ────────────────────────────────────────────────────────
  await wireSettingsSection();

  // ── ICS import section ────────────────────────────────────────────────────
  wireIcsSection();

  // ── Outline API fetch section ─────────────────────────────────────────────
  wireApiSection();

  // ── Drop zone ────────────────────────────────────────────────────────────
  wirePDFDropZone();

  // ── Confirmation section buttons ─────────────────────────────────────────
  document.getElementById('confirm-back')!.addEventListener('click', hideConfirmation);

  document.getElementById('confirm-add')!.addEventListener('click', async () => {
    try {
      const saved = await saveConfirmedItems();
      hideConfirmation();
      await renderDeadlines();
      if (saved === 0) {
        // Let the user know nothing was saved (all unchecked)
        alert('No deadlines were selected. Use the manual form to add them individually.');
      }
    } catch (err) {
      console.error('[confirm-add] save failed:', err);
      alert(`Failed to save deadlines: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── Manual form ──────────────────────────────────────────────────────────
  document.getElementById('manual-form')!.addEventListener('submit', handleManualSubmit);

  // Mode toggle: show/hide week vs date fields
  document.querySelectorAll<HTMLInputElement>('input[name="add-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isWeek = radio.value === 'week' && radio.checked;
      document.getElementById('week-fields')!.classList.toggle('hidden', !isWeek);
      document.getElementById('date-fields')!.classList.toggle('hidden', isWeek);
    });
  });

  // Live week preview (update whenever semester/year/week fields change)
  ['f-semester', 'f-year', 'f-week'].forEach((id) => {
    document.getElementById(id)!.addEventListener('input', updateWeekPreview);
    document.getElementById(id)!.addEventListener('change', updateWeekPreview);
  });

  // ── Filter bar ───────────────────────────────────────────────────────────
  // Unit select — update filterUnit and re-render
  document.getElementById('filter-unit')!.addEventListener('change', async (e) => {
    filterUnit = (e.target as HTMLSelectElement).value;
    await renderDeadlines();
  });

  // Status pills — update filterStatus and re-render
  document.querySelectorAll<HTMLElement>('.filter-pill').forEach((btn) => {
    btn.addEventListener('click', async () => {
      filterStatus = (btn.dataset.status ?? 'all') as typeof filterStatus;
      await renderDeadlines();
    });
  });

  // Sort toggle — cycle between date and unit sort
  document.getElementById('sort-btn')!.addEventListener('click', async () => {
    sortBy = sortBy === 'date' ? 'unit' : 'date';
    await renderDeadlines();
  });

  // ── Header buttons ───────────────────────────────────────────────────────
  document.getElementById('theme-toggle')!.addEventListener('click', toggleDarkMode);
  document.getElementById('export-btn')!.addEventListener('click', exportICS);

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
async function handleBlackboardResults(scraped: Partial<Deadline>[]): Promise<void> {
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
      source: 'auto',
      addedAt: new Date().toISOString(),
    };
    await addDeadline(deadline);
    added++;
  }

  if (added > 0) {
    await renderDeadlines();
  }
}

// ── Outline API fetch section ─────────────────────────────────────────────────

/**
 * Wires up the "Fetch outline" API section.
 * Pressing Enter in the unit code input is equivalent to clicking the button.
 */
function wireApiSection(): void {
  const btn = document.getElementById('api-fetch-btn')!;
  const unitInput = document.getElementById('api-unit-code') as HTMLInputElement;
  // Allow pressing Enter in the unit code field to trigger the fetch
  unitInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn.click();
  });
  btn.addEventListener('click', handleApiFetch);
}

/**
 * Handles a click on the "Fetch outline" button.
 * Reads the unit code, semester, and year from the API section inputs,
 * calls fetchOutline(), and pipes the result into the existing confirmation UI.
 */
async function handleApiFetch(): Promise<void> {
  const unitInput = document.getElementById('api-unit-code') as HTMLInputElement;
  const semesterSelect = document.getElementById('api-semester') as HTMLSelectElement;
  const yearInput = document.getElementById('api-year') as HTMLInputElement;

  const unitCode = unitInput.value.trim().toUpperCase();
  const semester = parseInt(semesterSelect.value, 10) as 1 | 2;
  const year = parseInt(yearInput.value, 10);

  // Validate unit code before making any network requests
  if (!unitCode) {
    setApiStatus('error', 'Enter a unit code first.');
    return;
  }

  setApiStatus('loading', 'Fetching outline…');
  try {
    const items = await fetchOutline(unitCode, semester, year);
    if (items.length === 0) {
      setApiStatus('error', 'No assessments found for this unit / semester.');
      return;
    }
    // Clear the status and hand off to the confirmation checklist
    setApiStatus('', '');
    showConfirmation([{ filename: `${unitCode} S${semester} ${year}`, items }]);
  } catch (e) {
    setApiStatus('error', (e as Error).message);
  }
}

/**
 * Updates the API status paragraph with a message and optional type class.
 * @param type  'loading' adds a spinner, 'error' applies the error colour, '' clears
 * @param msg   Text to display (empty string hides the paragraph)
 */
function setApiStatus(type: 'loading' | 'error' | '', msg: string): void {
  const el = document.getElementById('api-status')!;
  el.textContent = msg;
  // Remove all type classes first, then apply the new one if present
  el.className = type ? `api-status--${type}` : '';
}

// Kick everything off when the DOM is ready
document.addEventListener('DOMContentLoaded', init);
