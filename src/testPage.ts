// ── Curtin Deadlines — Test Panel ─────────────────────────────────────────────
// A developer test panel built into the extension. Opens as a full Chrome tab
// at chrome-extension://[id]/testPage.html.
//
// Capabilities:
//   1. Scan All — auto-discovers unit codes from saved deadlines, fetches each
//      from the API, validates output, shows per-unit status rows.
//   2. Single Unit — test one unit code against the API in isolation.
//   3. PDF Test — drop a unit outline PDF and run the same parsers the panel uses.
//   4. API ↔ PDF Diff — side-by-side comparison when both results are available.
//   5. Drift Detector — compare fresh API results against saved deadlines.
//   6. Regression Check — compare counts against known-good expected values.
//   7. Report download — full JSON including raw AS_TASK / PC_TEXT strings.

import type { Deadline, PendingDeadline } from './types';
import { fetchOutlineData, getAllUnitCodes } from './api/outlineApi';
import type { OutlineData } from './api/outlineApi';
import {
  initPdfWorker,
  parseUnitName,
  extractPDFText,
  parseAssessments,
  parseProgramCalendar,
  mergeWithCalendar,
  addSequenceNumbers,
} from './pdf/parser';

// Set up the pdf.js worker before any PDF extraction calls
initPdfWorker(chrome.runtime.getURL('pdf.worker.min.js'));

// ── Regression baselines ───────────────────────────────────────────────────────
// These are EXPECTED baselines, not "known-good" outputs — some of these units
// still have TBA items or missing weights (which is normal). The regression check
// only flags if the parser produces FEWER items than expected (regression) or
// MORE TBA items than the configured maximum (unexpected date loss).
// Update these values after verifying a unit's output is correct.

interface Baseline {
  minItems: number;
  maxTba: number;      // Maximum acceptable TBA items (exam-period TBA is expected)
  description: string; // Human-readable note for contributors
}

const BASELINES: Record<string, Baseline> = {
  COMP1005: { minItems: 6, maxTba: 2, description: '6 dated prac tests + 1 assignment + 1 exam-period final' },
  MATH1019: { minItems: 3, maxTba: 2, description: '3+ items; mid-sem TBA until week known' },
  PRRE1003: { minItems: 18, maxTba: 3, description: '18+ items from PC_TEXT (bi-weekly lab reports)' },
  ELEN1000: { minItems: 3, maxTba: 5, description: 'All TBA (no PC_TEXT dates); 4 AS_TASK items' },
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Issue {
  level: 'ok' | 'info' | 'warn' | 'error';
  item: string;
  msg: string;
}

interface UnitResult {
  unit: string;
  semester: 1 | 2;
  year: number;
  api: {
    success: boolean;
    error?: string;
    asTask: string;
    pcText: string;
    asTaskItems: Array<{ title: string; weight?: number }>;
    parsed: PendingDeadline[];
    issues: Issue[];
    summary: ResultSummary;
  } | null;
  pdf: {
    filename: string;
    rawText: string;
    parsed: PendingDeadline[];
    issues: Issue[];
    summary: ResultSummary;
  } | null;
  drift: DriftResult | null;
  regression: RegressionResult | null;
}

interface ResultSummary {
  total: number;
  dated: number;
  tba: number;
  examPeriod: number;
  weekKnown: number;
  noWeight: number;
}

interface DriftResult {
  added: Array<{ title: string; weekLabel?: string; weight?: number }>;
  removed: Array<{ title: string }>;
  changed: Array<{ title: string; field: string; from: unknown; to: unknown }>;
  unchanged: number;
}

interface RegressionResult {
  pass: boolean;
  expected: Baseline;
  got: ResultSummary;
  failures: string[];
}

// ── Grab-all types ─────────────────────────────────────────────────────────────

/** One entry in the grab-all results list. */
interface GrabAllEntry {
  unit: string;
  semester: 1 | 2;
  year: number;
  /** 'ok' = outline found; 'not-offered' = no Bentley Perth offering; 'error' = unexpected failure */
  status: 'ok' | 'error' | 'not-offered';
  itemCount: number;
  tbaCount: number;
  examPeriodCount: number;
  noWeightCount: number;
  errorMsg?: string; // Only set when status === 'error'
}

// ── Module-level state ─────────────────────────────────────────────────────────

/** Accumulated results from the last scan or single-unit test. */
const results = new Map<string, UnitResult>();

/** Last API result for the diff section. */
let lastApiUnit: string | null = null;
let lastPdfUnit: string | null = null;

// ── Grab-all state ──────────────────────────────────────────────────────────────

/** True while the grab-all scan is paused by the user. */
let grabAllPaused = false;

/** True once the user cancels an in-progress grab-all scan. */
let grabAllCancelled = false;

/** Accumulated results from the most recent grab-all run. */
let grabAllResults: GrabAllEntry[] = [];

// ── Concurrency semaphore ──────────────────────────────────────────────────────

/**
 * Simple async semaphore used to cap concurrent API requests in Grab All.
 * acquire() blocks until a slot is available; release() frees a slot and
 * wakes the next waiting caller.
 */
class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

// ── Validation helpers ─────────────────────────────────────────────────────────

/** True when the title strongly suggests a final exam (not mid-sem/quiz/prac). */
function isFinalExamType(title: string): boolean {
  const t = title.toLowerCase();
  if (/mid[\s-]?sem|mid[\s-]?semester|prac(tical)?|lab|quiz|workshop|online test|etest/i.test(t)) return false;
  if (/\bfinal\b/i.test(t)) return true;
  if (/\b(exam|examination)\b/i.test(t)) return true;
  return false;
}

/** Generate validation issues for an array of parsed PendingDeadline items. */
function validateItems(items: PendingDeadline[]): Issue[] {
  const issues: Issue[] = [];

  for (const item of items) {
    if (!item.title || item.title.length < 3) {
      issues.push({ level: 'error', item: item.title || '(empty)', msg: 'Title is empty or too short' });
      continue;
    }

    if (item.isTBA) {
      if (isFinalExamType(item.title)) {
        // Expected: final exam TBA during exam period
        issues.push({ level: 'info', item: item.title, msg: 'Exam period TBA — expected for final exams' });
      } else if (item.weekLabel && /\bweek\s+\d/i.test(item.weekLabel)) {
        // Week is known but exact day not set
        issues.push({ level: 'warn', item: item.title, msg: `Week known (${item.weekLabel}) but exact date TBC — user must confirm` });
      } else {
        // Fully unknown
        issues.push({ level: 'warn', item: item.title, msg: 'Date fully unknown — no week or day information' });
      }
    }

    if (item.weight === undefined) {
      issues.push({ level: 'warn', item: item.title, msg: 'No assessment weight extracted' });
    }

    if (!item.isTBA && item.resolvedDate) {
      // Sanity check: date should be within a plausible semester range (± 6 months from now)
      const now = Date.now();
      const diff = Math.abs(item.resolvedDate.getTime() - now);
      if (diff > 1.5 * 365 * 86_400_000) {
        issues.push({ level: 'warn', item: item.title, msg: `Date ${item.resolvedDate.toDateString()} looks far from current date — check semester/year` });
      }
    }
  }

  return issues;
}

/** Summarise a set of parsed items into counts. */
function summarise(items: PendingDeadline[]): ResultSummary {
  const tbaItems = items.filter((i) => i.isTBA);
  return {
    total: items.length,
    dated: items.filter((i) => !i.isTBA).length,
    tba: tbaItems.length,
    examPeriod: tbaItems.filter((i) => isFinalExamType(i.title)).length,
    weekKnown: tbaItems.filter((i) => i.weekLabel && /\bweek\s+\d/i.test(i.weekLabel)).length,
    noWeight: items.filter((i) => i.weight === undefined).length,
  };
}

// ── Drift detection ────────────────────────────────────────────────────────────

/** Compare fresh API parsed items against stored Deadline objects for the same unit. */
function detectDrift(
  fresh: PendingDeadline[],
  stored: Deadline[],
  unit: string,
): DriftResult {
  const unitStored = stored.filter((d) => d.unit === unit);

  // Normalise titles for loose comparison
  const norm = (s: string) => s.toLowerCase().replace(/\s+\d+$/, '').replace(/[^a-z0-9]/g, '');

  const added: DriftResult['added'] = [];
  const removed: DriftResult['removed'] = [];
  const changed: DriftResult['changed'] = [];
  let unchanged = 0;

  // Check each fresh item against stored
  for (const freshItem of fresh) {
    const match = unitStored.find((s) => norm(s.title) === norm(freshItem.title));
    if (!match) {
      added.push({ title: freshItem.title, weekLabel: freshItem.weekLabel, weight: freshItem.weight });
    } else {
      // Check for weight changes
      if (freshItem.weight !== undefined && match.weight !== undefined && freshItem.weight !== match.weight) {
        changed.push({ title: freshItem.title, field: 'weight', from: match.weight, to: freshItem.weight });
      } else {
        unchanged++;
      }
    }
  }

  // Check each stored item against fresh
  for (const storedItem of unitStored) {
    const stillExists = fresh.some((f) => norm(f.title) === norm(storedItem.title));
    if (!stillExists) {
      removed.push({ title: storedItem.title });
    }
  }

  return { added, removed, changed, unchanged };
}

// ── Regression check ───────────────────────────────────────────────────────────

function checkRegression(unit: string, summary: ResultSummary): RegressionResult | null {
  const expected = BASELINES[unit];
  if (!expected) return null;

  const failures: string[] = [];
  if (summary.total < expected.minItems) {
    failures.push(`Expected ≥${expected.minItems} items, got ${summary.total}`);
  }
  if (summary.tba > expected.maxTba) {
    failures.push(`Expected ≤${expected.maxTba} TBA items, got ${summary.tba}`);
  }

  return { pass: failures.length === 0, expected, got: summary, failures };
}

// ── Storage helpers ────────────────────────────────────────────────────────────

/** Read all saved deadlines from chrome.storage.local. */
async function loadStoredDeadlines(): Promise<Deadline[]> {
  const local = await chrome.storage.local.get('deadlines');
  return (local.deadlines as Deadline[]) ?? [];
}

/** Extract unique unit codes from saved deadlines. */
async function getStoredUnits(): Promise<string[]> {
  const deadlines = await loadStoredDeadlines();
  return [...new Set(deadlines.map((d) => d.unit))].sort();
}

// ── Run tests ──────────────────────────────────────────────────────────────────

/** Run the API test for one unit. Stores result in the results map. */
async function runApiTest(
  unit: string,
  semester: 1 | 2,
  year: number,
): Promise<UnitResult> {
  let entry = results.get(unit);
  if (!entry) {
    entry = { unit, semester, year, api: null, pdf: null, drift: null, regression: null };
    results.set(unit, entry);
  }

  const stored = await loadStoredDeadlines();

  try {
    const data: OutlineData = await fetchOutlineData(unit, semester, year);
    const issues = validateItems(data.parsed);
    const summary = summarise(data.parsed);
    entry.api = {
      success: true,
      asTask: data.asTask,
      pcText: data.pcText,
      asTaskItems: data.asTaskItems,
      parsed: data.parsed,
      issues,
      summary,
    };
    entry.drift = detectDrift(data.parsed, stored, unit);
    entry.regression = checkRegression(unit, summary);
  } catch (err: unknown) {
    entry.api = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      asTask: '',
      pcText: '',
      asTaskItems: [],
      parsed: [],
      issues: [{ level: 'error', item: unit, msg: err instanceof Error ? err.message : String(err) }],
      summary: { total: 0, dated: 0, tba: 0, examPeriod: 0, weekKnown: 0, noWeight: 0 },
    };
    entry.drift = null;
    entry.regression = null;
  }

  return entry;
}

/** Run the PDF parsing pipeline on an uploaded file. */
async function runPdfTest(
  file: File,
  semester: 1 | 2,
  year: number,
): Promise<{ unit: string; result: UnitResult }> {
  // Infer unit code from filename (e.g. "COMP1005 ... .pdf" → "COMP1005")
  const unitMatch = file.name.match(/\b([A-Z]{4}\d{4})\b/);
  const unit = unitMatch ? unitMatch[1] : 'UNKNOWN';

  let entry = results.get(unit);
  if (!entry) {
    entry = { unit, semester, year, api: null, pdf: null, drift: null, regression: null };
    results.set(unit, entry);
  }

  const rawText = await extractPDFText(file);
  const unitName = parseUnitName(rawText, unit);
  const schedule = parseAssessments(rawText, unit, year, semester);
  const calendar = parseProgramCalendar(rawText, unit, year, semester);
  const merged = addSequenceNumbers(mergeWithCalendar(schedule, calendar));

  // Attach inferred unit name
  if (unitName) {
    merged.forEach((item) => { item.unitName = unitName; });
  }

  const issues = validateItems(merged);
  const summary = summarise(merged);

  entry.pdf = { filename: file.name, rawText, parsed: merged, issues, summary };

  return { unit, result: entry };
}

// ── Grab All ───────────────────────────────────────────────────────────────────

/**
 * Fetches every Curtin unit outline for the given semesters and years.
 *
 * Uses a Semaphore to cap concurrent requests. Supports pause (caller sets
 * grabAllPaused = true) and cancel (caller sets grabAllCancelled = true).
 *
 * @param years      Array of years to scan (e.g. [2025, 2026])
 * @param sems       Array of semester numbers to scan (e.g. [1, 2])
 * @param concurrency Max simultaneous requests (default 10)
 * @param onProgress Called after each unit completes with running totals
 * @param appendLog  Called after each unit completes to add a log line in the UI
 */
async function runGrabAll(
  years: number[],
  sems: Array<1 | 2>,
  concurrency: number,
  onProgress: (processed: number, total: number, ok: number, notOffered: number, errors: number) => void,
  appendLog: (entry: GrabAllEntry) => void,
): Promise<void> {
  // Load every known unit code (hits cache or fetches ~12k units once)
  const allCodes = await getAllUnitCodes();

  // Build the full work queue: one item per (unit, sem, year) combination
  const queue: Array<{ unit: string; semester: 1 | 2; year: number }> = [];
  for (const year of years) {
    for (const sem of sems) {
      for (const unit of allCodes) {
        queue.push({ unit, semester: sem, year });
      }
    }
  }

  const total = queue.length;
  let processed = 0;
  let okCount = 0;
  let notOfferedCount = 0;
  let errorCount = 0;

  const sem = new Semaphore(concurrency);

  // Process every item concurrently up to the semaphore limit.
  // Promise.allSettled creates all futures at once; each waits at sem.acquire()
  // before doing any network work, so only `concurrency` run at a time.
  await Promise.allSettled(
    queue.map(async ({ unit, semester, year }) => {
      // Check pause/cancel BEFORE entering the semaphore queue
      if (grabAllCancelled) return;
      while (grabAllPaused && !grabAllCancelled) {
        await new Promise<void>((r) => setTimeout(r, 200));
      }
      if (grabAllCancelled) return;

      await sem.acquire();
      try {
        // Re-check cancel after acquiring — items queued during cancellation exit here
        if (grabAllCancelled) return;

        let entry: GrabAllEntry;
        try {
          const data = await fetchOutlineData(unit, semester, year);
          const summary = summarise(data.parsed);
          entry = {
            unit, semester, year, status: 'ok',
            itemCount: summary.total,
            tbaCount: summary.tba,
            examPeriodCount: summary.examPeriod,
            noWeightCount: summary.noWeight,
          };
          okCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Distinguish "not offered this semester/campus" from genuine API errors
          const isNotOffered =
            msg.includes('No Bentley Perth offering') ||
            msg.includes('not found in the Curtin unit list');
          entry = {
            unit, semester, year,
            status: isNotOffered ? 'not-offered' : 'error',
            itemCount: 0, tbaCount: 0, examPeriodCount: 0, noWeightCount: 0,
            errorMsg: isNotOffered ? undefined : msg,
          };
          if (isNotOffered) notOfferedCount++;
          else errorCount++;
        }

        grabAllResults.push(entry);
        processed++;
        onProgress(processed, total, okCount, notOfferedCount, errorCount);
        appendLog(entry);
      } finally {
        sem.release();
      }
    }),
  );
}

/** Download a compact JSON report of all grab-all results. */
function downloadGrabAllReport(): void {
  if (grabAllResults.length === 0) return;

  // Compact format: per-unit summary only (no raw AS_TASK/PC_TEXT to keep file size manageable)
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      totalUnits: grabAllResults.length,
      offered: grabAllResults.filter((e) => e.status === 'ok').length,
      notOffered: grabAllResults.filter((e) => e.status === 'not-offered').length,
      errors: grabAllResults.filter((e) => e.status === 'error').length,
    },
    results: grabAllResults,
  };

  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `curtin-grab-all-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── DOM rendering helpers ──────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function levelTag(level: Issue['level']): string {
  const map: Record<Issue['level'], string> = {
    ok: 'ok', info: 'info', warn: 'warn', error: 'err',
  };
  const labels: Record<Issue['level'], string> = {
    ok: '✓ OK', info: 'ℹ INFO', warn: '⚠ WARN', error: '✗ ERROR',
  };
  return `<span class="tag tag-${map[level]}">${labels[level]}</span>`;
}

/** Render a detail table + issues list for a set of parsed items. */
function renderDetailTable(parsed: PendingDeadline[], issues: Issue[]): string {
  if (parsed.length === 0) {
    return '<p class="tp-empty">No items parsed.</p>';
  }

  const rows = parsed.map((item) => {
    const date = item.resolvedDate
      ? item.resolvedDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      : item.weekLabel ?? '—';
    const tbaTag = item.isTBA
      ? `<span class="tag tag-warn">TBA</span>`
      : `<span class="tag tag-ok">Dated</span>`;
    const weight = item.weight !== undefined ? `${item.weight}%` : '<span style="color:var(--muted)">—</span>';
    const week = item.weekLabel ? escHtml(item.weekLabel) : '—';
    return `<tr>
      <td>${tbaTag}</td>
      <td>${escHtml(item.title)}</td>
      <td>${escHtml(item.unit)}</td>
      <td>${escHtml(date)}</td>
      <td>${week}</td>
      <td>${weight}</td>
    </tr>`;
  }).join('');

  const table = `
    <table class="detail-table">
      <thead><tr>
        <th>Status</th><th>Title</th><th>Unit</th><th>Date</th><th>Week</th><th>Weight</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  const issueRows = issues.length === 0
    ? '<li><span class="tag tag-ok">✓ OK</span> <span class="issue-item">No issues found</span></li>'
    : issues.map((iss) => `
        <li>
          ${levelTag(iss.level)}
          <span class="issue-item"><strong>${escHtml(iss.item)}</strong> — ${escHtml(iss.msg)}</span>
        </li>`).join('');

  return `${table}
    <ul class="issues-list" style="margin-top:12px">${issueRows}</ul>`;
}

/** Render the raw AS_TASK + PC_TEXT strings with a toggle. */
function renderRawInspector(asTask: string, pcText: string): string {
  if (!asTask && !pcText) return '';
  return `
    <span class="raw-toggle" data-raw-id="raw-astask">▸ AS_TASK (raw)</span>
    <div class="raw-box hidden" id="raw-astask">${escHtml(asTask)}</div>
    <span class="raw-toggle" data-raw-id="raw-pctxt" style="margin-left:12px">▸ PC_TEXT (HTML)</span>
    <div class="raw-box hidden" id="raw-pctxt">${escHtml(pcText)}</div>`;
}

/** Render the drift sub-section for a unit result. */
function renderDrift(drift: DriftResult): string {
  if (drift.added.length === 0 && drift.removed.length === 0 && drift.changed.length === 0) {
    return `<p style="font-size:12px;color:var(--muted);margin-top:8px">
      ✓ ${drift.unchanged} item(s) match saved deadlines — no drift detected.</p>`;
  }

  const items = [
    ...drift.added.map((a) => `<li>
      <span class="drift-sym drift-new">+</span>
      <span>NEW: <strong>${escHtml(a.title)}</strong>${a.weekLabel ? ` · ${escHtml(a.weekLabel)}` : ''}${a.weight !== undefined ? ` · ${a.weight}%` : ''} — in outline, not saved</span>
    </li>`),
    ...drift.removed.map((r) => `<li>
      <span class="drift-sym drift-gone">−</span>
      <span>GONE: <strong>${escHtml(r.title)}</strong> — saved but no longer in outline</span>
    </li>`),
    ...drift.changed.map((c) => `<li>
      <span class="drift-sym drift-chg">~</span>
      <span>CHANGED: <strong>${escHtml(c.title)}</strong> ${escHtml(c.field)}: ${escHtml(String(c.from))} → ${escHtml(String(c.to))}</span>
    </li>`),
  ].join('');

  if (drift.unchanged > 0) {
    items.concat(`<li><span class="drift-sym status-info">·</span><span>${drift.unchanged} item(s) unchanged</span></li>`);
  }

  return `<ul class="drift-list">${items}</ul>`;
}

/** Render the API ↔ PDF diff table. */
function renderDiff(apiItems: PendingDeadline[], pdfItems: PendingDeadline[]): string {
  if (apiItems.length === 0 && pdfItems.length === 0) {
    return '<p class="tp-empty">No items to compare.</p>';
  }

  const norm = (s: string) => s.toLowerCase().replace(/\s+\d+$/, '').replace(/[^a-z0-9]/g, '');

  // Union of all titles
  const allTitles = [
    ...new Set([...apiItems.map((i) => norm(i.title)), ...pdfItems.map((i) => norm(i.title))]),
  ];

  const rows = allTitles.map((key) => {
    const api = apiItems.find((i) => norm(i.title) === key);
    const pdf = pdfItems.find((i) => norm(i.title) === key);
    const title = api?.title ?? pdf?.title ?? key;

    const fmt = (item: PendingDeadline | undefined): string => {
      if (!item) return '<span style="color:var(--muted)">(not found)</span>';
      const date = item.resolvedDate
        ? item.resolvedDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
        : item.weekLabel ?? 'TBA';
      const w = item.weight !== undefined ? ` · ${item.weight}%` : '';
      return `${escHtml(date)}${w}`;
    };

    let matchCell = '<span class="tag tag-ok">✓</span>';
    if (!api || !pdf) {
      matchCell = `<span class="tag tag-err">✗ missing in ${!api ? 'API' : 'PDF'}</span>`;
    } else if (api.weight !== pdf.weight && api.weight !== undefined && pdf.weight !== undefined) {
      matchCell = `<span class="tag tag-warn">⚠ weight differs</span>`;
    }

    return `<tr>
      <td>${escHtml(title)}</td>
      <td>${fmt(api)}</td>
      <td>${fmt(pdf)}</td>
      <td>${matchCell}</td>
    </tr>`;
  }).join('');

  return `<table class="diff-table">
    <thead><tr><th>Item</th><th>API result</th><th>PDF result</th><th>Match</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** Render regression table rows for all scanned units. */
function renderRegressionTable(): string {
  const rows: string[] = [];
  for (const [unit, result] of results.entries()) {
    if (!result.regression) continue;
    const reg = result.regression;
    const tag = reg.pass
      ? `<span class="tag tag-ok">✓ Pass</span>`
      : `<span class="tag tag-err">✗ Fail</span>`;
    const failures = reg.failures.length > 0
      ? escHtml(reg.failures.join('; '))
      : '—';
    rows.push(`<tr>
      <td style="font-family:var(--mono);font-weight:600">${escHtml(unit)}</td>
      <td>${tag}</td>
      <td>≥${reg.expected.minItems} items, ≤${reg.expected.maxTba} TBA</td>
      <td>${reg.got.total} items, ${reg.got.tba} TBA</td>
      <td style="color:var(--error)">${failures}</td>
    </tr>`);
  }

  if (rows.length === 0) {
    return '<p class="tp-empty">No baseline data yet — run a scan or single-unit test for COMP1005, MATH1019, PRRE1003, or ELEN1000.</p>';
  }

  return `<table class="regression-table">
    <thead><tr><th>Unit</th><th>Result</th><th>Expected</th><th>Got</th><th>Failures</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`;
}

// ── Scan All rendering ─────────────────────────────────────────────────────────

/** Render one row in the scan summary table. */
function makeScanRow(result: UnitResult): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'scan-row';
  tr.dataset.unit = result.unit;

  const api = result.api;
  let statusCell: string;
  let datedCell = '—';
  let tbaCell = '—';
  let issuesCell = '';

  if (!api) {
    statusCell = `<span class="spinner"></span> Fetching…`;
  } else if (!api.success) {
    statusCell = `<span class="tag tag-err">✗ Error</span>`;
    issuesCell = `<span class="status-err">${escHtml(api.error ?? 'Unknown error')}</span>`;
  } else {
    const warnCount = api.issues.filter((i) => i.level === 'warn').length;
    const errCount = api.issues.filter((i) => i.level === 'error').length;
    if (errCount > 0) {
      statusCell = `<span class="tag tag-err">✗ ${api.summary.total} items</span>`;
    } else if (warnCount > 0) {
      statusCell = `<span class="tag tag-warn">⚠ ${api.summary.total} items</span>`;
    } else {
      statusCell = `<span class="tag tag-ok">✓ ${api.summary.total} items</span>`;
    }
    datedCell = String(api.summary.dated);
    tbaCell = String(api.summary.tba);
    issuesCell = api.issues
      .filter((i) => i.level !== 'ok')
      .slice(0, 2)
      .map((i) => `<span style="font-size:11px;color:var(--${i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn' : 'muted'})">${escHtml(i.msg)}</span>`)
      .join('<br>');
  }

  tr.innerHTML = `
    <td>
      <span class="scan-row-unit">${escHtml(result.unit)}</span>
      <button class="btn btn-secondary btn-sm retest-btn" data-unit="${escHtml(result.unit)}" title="Re-test this unit">↻</button>
    </td>
    <td>${statusCell}</td>
    <td>${datedCell}</td>
    <td>${tbaCell}</td>
    <td>${issuesCell}</td>`;

  return tr;
}

/** Expand/collapse a scan row to show its detail panel. */
function toggleScanDetail(tr: HTMLTableRowElement, tbody: HTMLTableSectionElement): void {
  const unit = tr.dataset.unit!;
  const existingDetail = tbody.querySelector<HTMLTableRowElement>(`tr.scan-detail-row[data-unit="${unit}"]`);

  if (existingDetail) {
    existingDetail.remove();
    return;
  }

  const result = results.get(unit);
  if (!result?.api) return;

  const api = result.api;
  const detailTr = document.createElement('tr');
  detailTr.className = 'scan-detail-row';
  detailTr.dataset.unit = unit;
  detailTr.innerHTML = `<td colspan="5"><div class="scan-detail-inner" id="detail-${unit}"></div></td>`;

  tr.insertAdjacentElement('afterend', detailTr);

  const inner = detailTr.querySelector<HTMLElement>(`#detail-${unit}`)!;

  let html = `<strong style="font-size:13px">${escHtml(unit)} — API result</strong>`;
  html += renderDetailTable(api.parsed, api.issues);

  if (result.drift) {
    html += `<div style="margin-top:12px"><strong style="font-size:12px">Drift vs saved deadlines</strong>`;
    html += renderDrift(result.drift);
    html += `</div>`;
  }

  html += `<div style="margin-top:12px">`;
  html += renderRawInspector(api.asTask, api.pcText);
  html += `</div>`;

  inner.innerHTML = html;

  // Wire raw toggles in the new detail panel
  inner.querySelectorAll<HTMLElement>('.raw-toggle').forEach(wireRawToggle);
}

// ── Raw toggle wiring ──────────────────────────────────────────────────────────

function wireRawToggle(el: HTMLElement): void {
  el.addEventListener('click', () => {
    const targetId = el.dataset.rawId!;
    const box = el.nextElementSibling as HTMLElement;
    if (!box) return;
    const open = !box.classList.contains('hidden');
    box.classList.toggle('hidden', open);
    el.textContent = (open ? '▸ ' : '▾ ') + el.textContent!.replace(/^[▸▾] /, '');
  });
}

// ── Section collapse/expand ────────────────────────────────────────────────────

function wireSection(header: HTMLElement): void {
  const targetId = header.dataset.target!;
  const body = document.getElementById(targetId)!;
  header.addEventListener('click', (e) => {
    // Don't toggle if the click was on a button inside the header
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    const collapsed = header.classList.toggle('collapsed');
    body.classList.toggle('hidden', collapsed);
    header.querySelector('.chevron')!.textContent = collapsed ? '▼' : '▼';
  });
}

// ── Report generation ──────────────────────────────────────────────────────────

function buildReport(): object {
  const units = [...results.values()].map((r) => ({
    unit: r.unit,
    semester: r.semester,
    year: r.year,
    api: r.api ? {
      success: r.api.success,
      error: r.api.error,
      rawAsTask: r.api.asTask,
      rawPcText: r.api.pcText,
      asTaskItems: r.api.asTaskItems,
      parsed: r.api.parsed.map(serializePending),
      issues: r.api.issues,
      summary: r.api.summary,
    } : null,
    pdf: r.pdf ? {
      filename: r.pdf.filename,
      parsed: r.pdf.parsed.map(serializePending),
      issues: r.pdf.issues,
      summary: r.pdf.summary,
    } : null,
    drift: r.drift,
    regression: r.regression,
  }));

  const totals = {
    units: units.length,
    items: units.reduce((s, u) => s + (u.api?.summary.total ?? 0), 0),
    dated: units.reduce((s, u) => s + (u.api?.summary.dated ?? 0), 0),
    tba: units.reduce((s, u) => s + (u.api?.summary.tba ?? 0), 0),
    errors: units.filter((u) => u.api && !u.api.success).length,
    regressionFails: units.filter((u) => u.regression && !u.regression.pass).length,
  };

  return {
    meta: { testedAt: new Date().toISOString() },
    units,
    totals,
  };
}

function serializePending(item: PendingDeadline): object {
  return {
    ...item,
    // Convert Date → ISO string for JSON serialisation
    resolvedDate: item.resolvedDate?.toISOString(),
  };
}

function downloadReport(): void {
  const report = buildReport();
  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const firstUnit = [...results.keys()][0] ?? 'all';
  a.download = `curtin-test-${firstUnit}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function copyReport(): void {
  const report = buildReport();
  navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
    const msg = document.getElementById('copy-msg');
    if (msg) {
      msg.textContent = 'Copied!';
      setTimeout(() => { msg.textContent = ''; }, 2000);
    }
  });
}

// ── Main init ──────────────────────────────────────────────────────────────────

async function init(): Promise<void> {

  // ── Theme toggle ────────────────────────────────────────────────────────
  const themeBtn = document.getElementById('theme-btn')!;
  const dark = localStorage.getItem('tp-dark') === '1';
  if (dark) document.body.classList.add('dark');
  themeBtn.textContent = dark ? 'Light mode' : 'Dark mode';
  themeBtn.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark');
    themeBtn.textContent = isDark ? 'Light mode' : 'Dark mode';
    localStorage.setItem('tp-dark', isDark ? '1' : '0');
  });

  // ── Section headers ─────────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.tp-section-header').forEach(wireSection);

  // ── Raw toggles (initial page load) ────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.raw-toggle').forEach(wireRawToggle);

  // ── 1. Scan All ─────────────────────────────────────────────────────────
  const scanBtn = document.getElementById('scan-btn') as HTMLButtonElement;
  const scanReportBtn = document.getElementById('scan-report-btn') as HTMLButtonElement;
  const scanStatus = document.getElementById('scan-status')!;
  const scanResults = document.getElementById('scan-results')!;

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanResults.innerHTML = '';
    scanStatus.innerHTML = '<span class="spinner"></span> Discovering units…';

    const sem = parseInt((document.getElementById('scan-sem') as HTMLSelectElement).value) as 1 | 2;
    const year = parseInt((document.getElementById('scan-year') as HTMLInputElement).value, 10) || 2026;
    const extra = (document.getElementById('scan-extra') as HTMLInputElement).value.trim().toUpperCase();

    // Build unit list from storage + any extras entered by user
    const storedUnits = await getStoredUnits();
    const extraUnits = extra ? extra.split(/[\s,]+/).filter(Boolean) : [];
    const units = [...new Set([...storedUnits, ...extraUnits])];

    if (units.length === 0) {
      scanStatus.textContent = 'No saved deadlines found. Enter a unit code in "Extra unit" to test.';
      scanBtn.disabled = false;
      return;
    }

    // Build the scan table
    const table = document.createElement('table');
    table.className = 'scan-table';
    table.innerHTML = `
      <thead><tr>
        <th>Unit</th><th>Status</th><th>Dated</th><th>TBA</th><th>Issues</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    scanResults.appendChild(table);

    // Placeholder rows while fetching
    const rowMap = new Map<string, HTMLTableRowElement>();
    for (const unit of units) {
      const placeholderResult: UnitResult = { unit, semester: sem, year, api: null, pdf: null, drift: null, regression: null };
      results.set(unit, placeholderResult);
      const tr = makeScanRow(placeholderResult);
      tbody.appendChild(tr);
      rowMap.set(unit, tr);
    }

    // Wire row expand/collapse and re-test buttons
    function wireRow(tr: HTMLTableRowElement): void {
      tr.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('retest-btn')) return;
        toggleScanDetail(tr, tbody);
      });
      tr.querySelector<HTMLButtonElement>('.retest-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const unit = (e.currentTarget as HTMLElement).dataset.unit!;
        const existing = tbody.querySelector<HTMLTableRowElement>(`tr.scan-detail-row[data-unit="${unit}"]`);
        existing?.remove();
        scanStatus.innerHTML = `<span class="spinner"></span> Re-testing ${unit}…`;
        const result = await runApiTest(unit, sem, year);
        const newTr = makeScanRow(result);
        wireRow(newTr);
        tr.replaceWith(newTr);
        rowMap.set(unit, newTr);
        scanStatus.textContent = `Re-test complete: ${unit}`;
        updateRegressionSection();
      });
    }

    tbody.querySelectorAll<HTMLTableRowElement>('.scan-row').forEach(wireRow);

    // Fetch all units in parallel
    scanStatus.innerHTML = `<span class="spinner"></span> Fetching ${units.length} unit(s)…`;

    await Promise.allSettled(
      units.map(async (unit) => {
        const result = await runApiTest(unit, sem, year);
        // Replace the placeholder row with the real result
        const existingTr = rowMap.get(unit);
        if (existingTr) {
          const newTr = makeScanRow(result);
          wireRow(newTr);
          existingTr.replaceWith(newTr);
          rowMap.set(unit, newTr);
        }
      }),
    );

    const total = [...results.values()].filter((r) => r.api).length;
    const errors = [...results.values()].filter((r) => r.api && !r.api.success).length;
    scanStatus.textContent = `Scan complete — ${total} unit(s) tested, ${errors} error(s).`;
    scanBtn.disabled = false;
    scanReportBtn.disabled = false;

    updateRegressionSection();
  });

  scanReportBtn.addEventListener('click', downloadReport);

  // ── 2. Single Unit ──────────────────────────────────────────────────────
  const singleBtn = document.getElementById('single-btn') as HTMLButtonElement;
  const singleStatus = document.getElementById('single-status')!;
  const singleResults = document.getElementById('single-results')!;

  singleBtn.addEventListener('click', async () => {
    const unit = (document.getElementById('single-unit') as HTMLInputElement).value.trim().toUpperCase();
    const sem = parseInt((document.getElementById('single-sem') as HTMLSelectElement).value) as 1 | 2;
    const year = parseInt((document.getElementById('single-year') as HTMLInputElement).value, 10) || 2026;

    if (!unit) { singleStatus.textContent = 'Enter a unit code first.'; return; }

    singleBtn.disabled = true;
    singleStatus.innerHTML = `<span class="spinner"></span> Fetching ${unit}…`;
    singleResults.innerHTML = '';

    const result = await runApiTest(unit, sem, year);
    lastApiUnit = unit;

    singleBtn.disabled = false;

    const api = result.api!;
    if (!api.success) {
      singleStatus.innerHTML = `<span class="status-err">✗ ${escHtml(api.error ?? 'Error')}</span>`;
      return;
    }

    singleStatus.innerHTML = `✓ <strong>${api.summary.total}</strong> items — ${api.summary.dated} dated, ${api.summary.tba} TBA`;

    let html = renderDetailTable(api.parsed, api.issues);

    if (result.drift) {
      html += `<div style="margin-top:14px"><strong style="font-size:12px">Drift vs saved deadlines</strong>`;
      html += renderDrift(result.drift);
      html += `</div>`;
    }

    html += `<div style="margin-top:12px">`;
    html += renderRawInspector(api.asTask, api.pcText);
    html += `</div>`;

    singleResults.innerHTML = html;
    singleResults.querySelectorAll<HTMLElement>('.raw-toggle').forEach(wireRawToggle);

    updateDiffSection();
    updateRegressionSection();
  });

  // ── 3. PDF Test ─────────────────────────────────────────────────────────
  const pdfDrop = document.getElementById('pdf-drop')!;
  const pdfInput = document.getElementById('pdf-input') as HTMLInputElement;
  const pdfStatus = document.getElementById('pdf-status')!;
  const pdfResults = document.getElementById('pdf-results')!;

  pdfDrop.addEventListener('click', () => pdfInput.click());
  pdfDrop.addEventListener('dragover', (e) => { e.preventDefault(); pdfDrop.classList.add('drag-over'); });
  pdfDrop.addEventListener('dragleave', () => pdfDrop.classList.remove('drag-over'));
  pdfDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    pdfDrop.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (file?.name.endsWith('.pdf')) handlePdfFile(file);
  });
  pdfInput.addEventListener('change', () => {
    const file = pdfInput.files?.[0];
    if (file) handlePdfFile(file);
  });

  async function handlePdfFile(file: File): Promise<void> {
    const sem = parseInt((document.getElementById('pdf-sem') as HTMLSelectElement).value) as 1 | 2;
    const year = parseInt((document.getElementById('pdf-year') as HTMLInputElement).value, 10) || 2026;

    pdfStatus.innerHTML = `<span class="spinner"></span> Parsing ${escHtml(file.name)}…`;
    pdfResults.innerHTML = '';

    const { unit, result } = await runPdfTest(file, sem, year);
    lastPdfUnit = unit;

    const pdf = result.pdf!;
    pdfStatus.innerHTML = `✓ <strong>${pdf.summary.total}</strong> items — ${pdf.summary.dated} dated, ${pdf.summary.tba} TBA`;

    let html = renderDetailTable(pdf.parsed, pdf.issues);

    // Raw text inspector
    html += `<span class="raw-toggle" data-raw-id="pdf-raw" style="margin-top:10px;display:inline-block">▸ Extracted PDF text</span>
      <div class="raw-box hidden" id="pdf-raw">${escHtml(pdf.rawText)}</div>`;

    pdfResults.innerHTML = html;
    pdfResults.querySelectorAll<HTMLElement>('.raw-toggle').forEach(wireRawToggle);

    updateDiffSection();
    updateRegressionSection();
  }

  // ── 4. Diff section ─────────────────────────────────────────────────────
  function updateDiffSection(): void {
    const diffStatus = document.getElementById('diff-status')!;
    const diffResults = document.getElementById('diff-results')!;

    const apiResult = lastApiUnit ? results.get(lastApiUnit) : null;
    const pdfResult = lastPdfUnit ? results.get(lastPdfUnit) : null;

    if (!apiResult?.api?.success || !pdfResult?.pdf) {
      diffStatus.textContent = 'Run an API test (section 2) and a PDF test (section 3) for the same unit to see a diff.';
      diffResults.innerHTML = '';
      return;
    }

    if (lastApiUnit !== lastPdfUnit) {
      diffStatus.innerHTML = `<span class="status-warn">⚠ API tested ${escHtml(lastApiUnit!)} but PDF is ${escHtml(lastPdfUnit!)} — diff may not be meaningful.</span>`;
    } else {
      diffStatus.textContent = `Comparing ${lastApiUnit} API vs PDF results:`;
    }

    diffResults.innerHTML = renderDiff(apiResult.api.parsed, pdfResult.pdf.parsed);
  }

  // ── 5. Regression section ────────────────────────────────────────────────
  function updateRegressionSection(): void {
    const regResults = document.getElementById('reg-results')!;
    regResults.innerHTML = renderRegressionTable();
  }

  // ── 0. Grab All ─────────────────────────────────────────────────────────
  const grabStartBtn = document.getElementById('grab-start-btn') as HTMLButtonElement;
  const grabPauseBtn = document.getElementById('grab-pause-btn') as HTMLButtonElement;
  const grabCancelBtn = document.getElementById('grab-cancel-btn') as HTMLButtonElement;
  const grabDownloadBtn = document.getElementById('grab-download-btn') as HTMLButtonElement;
  const grabProgressWrap = document.getElementById('grab-progress-wrap')!;
  const grabProgressBar = document.getElementById('grab-progress-bar') as HTMLElement;
  const grabProgressStats = document.getElementById('grab-progress-stats')!;
  const grabStatusEl = document.getElementById('grab-status')!;
  const grabLogEl = document.getElementById('grab-log')!;

  /** Prepend one log line for a grab-all result; cap the list at 100 lines. */
  function appendGrabLog(entry: GrabAllEntry): void {
    grabLogEl.classList.add('visible');
    const line = document.createElement('div');
    line.className =
      `grab-log-line grab-log-${entry.status === 'ok' ? 'ok' : entry.status === 'error' ? 'err' : 'skip'}`;
    if (entry.status === 'ok') {
      line.textContent = `✓ ${entry.unit} S${entry.semester} ${entry.year} — ${entry.itemCount} items, ${entry.tbaCount} TBA`;
    } else if (entry.status === 'error') {
      line.textContent = `✗ ${entry.unit} S${entry.semester} ${entry.year} — ${entry.errorMsg ?? 'error'}`;
    } else {
      line.textContent = `· ${entry.unit} S${entry.semester} ${entry.year} — not offered`;
    }
    // Prepend so newest is at the top; trim old lines beyond 100
    grabLogEl.insertBefore(line, grabLogEl.firstChild);
    const lines = grabLogEl.querySelectorAll('.grab-log-line');
    if (lines.length > 100) lines[lines.length - 1].remove();
  }

  grabStartBtn.addEventListener('click', async () => {
    const years = [...document.querySelectorAll<HTMLInputElement>('.grab-year-cb:checked')]
      .map((el) => parseInt(el.value));
    const sems = [...document.querySelectorAll<HTMLInputElement>('.grab-sem-cb:checked')]
      .map((el) => parseInt(el.value) as 1 | 2);
    const concurrency = parseInt(
      (document.getElementById('grab-concurrency') as HTMLInputElement).value, 10,
    ) || 10;

    if (years.length === 0 || sems.length === 0) {
      grabStatusEl.textContent = 'Select at least one year and one semester.';
      return;
    }

    // Reset state for this run
    grabAllPaused = false;
    grabAllCancelled = false;
    grabAllResults = [];
    grabLogEl.innerHTML = '';
    grabLogEl.classList.remove('visible');
    grabPauseBtn.textContent = 'Pause';

    grabStartBtn.disabled = true;
    grabPauseBtn.disabled = false;
    grabCancelBtn.disabled = false;
    grabDownloadBtn.disabled = true;
    grabProgressWrap.classList.remove('hidden');

    grabStatusEl.innerHTML = '<span class="spinner"></span> Loading unit list from Curtin API…';
    const startTime = Date.now();

    /** Update the progress bar and stats line after each unit completes. */
    function onProgress(processed: number, total: number, ok: number, notOffered: number, errors: number): void {
      const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
      grabProgressBar.style.width = `${pct}%`;

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed > 0 ? processed / elapsed : 0;
      const remaining = total - processed;
      const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
      const etaStr = etaSec > 60
        ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s`
        : `${etaSec}s`;

      grabProgressStats.innerHTML = `
        <span><strong>${processed.toLocaleString()}</strong> / ${total.toLocaleString()} (${pct}%)</span>
        <span><strong>${ok.toLocaleString()}</strong> offered</span>
        <span><strong>${notOffered.toLocaleString()}</strong> not offered</span>
        <span><strong>${errors.toLocaleString()}</strong> errors</span>
        <span>ETA <strong>${rate > 0 ? etaStr : '—'}</strong></span>
      `;

      // Update status line (show paused state if applicable)
      if (!grabAllPaused) {
        grabStatusEl.innerHTML =
          `<span class="spinner"></span> ${processed.toLocaleString()} / ${total.toLocaleString()} units…`;
      }
    }

    try {
      await runGrabAll(years, sems, concurrency, onProgress, appendGrabLog);
    } catch (err) {
      grabStatusEl.innerHTML =
        `<span class="status-err">✗ ${escHtml(err instanceof Error ? err.message : String(err))}</span>`;
    }

    const ok = grabAllResults.filter((e) => e.status === 'ok').length;
    const notOffered = grabAllResults.filter((e) => e.status === 'not-offered').length;
    const errors = grabAllResults.filter((e) => e.status === 'error').length;

    grabStatusEl.textContent = grabAllCancelled
      ? `Cancelled after ${grabAllResults.length.toLocaleString()} units — ${ok} offered, ${notOffered} not offered, ${errors} errors.`
      : `Complete — ${ok.toLocaleString()} offered, ${notOffered.toLocaleString()} not offered, ${errors} errors.`;

    grabStartBtn.disabled = false;
    grabPauseBtn.disabled = true;
    grabCancelBtn.disabled = true;
    grabDownloadBtn.disabled = grabAllResults.length === 0;
  });

  grabPauseBtn.addEventListener('click', () => {
    grabAllPaused = !grabAllPaused;
    grabPauseBtn.textContent = grabAllPaused ? 'Resume' : 'Pause';
    if (!grabAllPaused) {
      grabStatusEl.innerHTML = '<span class="spinner"></span> Resuming…';
    } else {
      grabStatusEl.textContent = 'Paused.';
    }
  });

  grabCancelBtn.addEventListener('click', () => {
    grabAllCancelled = true;
    grabAllPaused = false; // Unpause so waiting items can observe cancellation and exit
    grabStatusEl.textContent = 'Cancelling…';
    grabCancelBtn.disabled = true;
  });

  grabDownloadBtn.addEventListener('click', downloadGrabAllReport);

  // Update header with extension info
  const headerStatus = document.getElementById('header-status')!;
  headerStatus.textContent = `Extension ID: ${chrome.runtime.id}`;
}

// Kick off init once the DOM is ready
document.addEventListener('DOMContentLoaded', init);
