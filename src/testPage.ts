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

import type { Deadline, PendingDeadline } from "./types";
import { fetchOutlineData, getAllUnitCodes } from "./api/outlineApi";
import type { OutlineData } from "./api/outlineApi";
import {
  initPdfWorker,
  parseUnitName,
  extractPDFText,
  parseAssessments,
  parseProgramCalendar,
  mergeWithCalendar,
  addSequenceNumbers,
} from "./pdf";

// Set up the pdf.js worker before any PDF extraction calls.
// Guard against being loaded outside the extension context (e.g. file:// during unit tests).
if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
  initPdfWorker(chrome.runtime.getURL("pdf.worker.min.js"));
}

// ── Regression baselines ───────────────────────────────────────────────────────
// These are EXPECTED baselines, not "known-good" outputs — some of these units
// still have TBA items or missing weights (which is normal). The regression check
// only flags if the parser produces FEWER items than expected (regression) or
// MORE TBA items than the configured maximum (unexpected date loss).
// Update these values after verifying a unit's output is correct.

interface Baseline {
  minItems: number;
  maxTba: number; // Maximum acceptable TBA items (exam-period TBA is expected)
  description: string; // Human-readable note for contributors
}

const BASELINES: Record<string, Baseline> = {
  COMP1005: {
    minItems: 6,
    maxTba: 2,
    description: "6 dated prac tests + 1 assignment + 1 exam-period final",
  },
  MATH1019: {
    minItems: 3,
    maxTba: 2,
    description: "3+ items; mid-sem TBA until week known",
  },
  PRRE1003: {
    minItems: 18,
    maxTba: 3,
    description: "18+ items from PC_TEXT (bi-weekly lab reports)",
  },
  ELEN1000: {
    minItems: 3,
    maxTba: 5,
    description: "All TBA (no PC_TEXT dates); 4 AS_TASK items",
  },
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Issue {
  level: "ok" | "info" | "warn" | "error";
  item: string;
  msg: string;
  /** Raw text / value that triggered this issue — displayed in the panel to aid diagnosis and point to the right fix. */
  context?: string;
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
    rawOutline?: Record<string, unknown>;
    asTaskItems: Array<{ title: string; weight?: number; outcomes?: string }>;
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
  status: "ok" | "error" | "not-offered";
  itemCount: number;
  tbaCount: number;
  examPeriodCount: number;
  noWeightCount: number;
  errorMsg?: string; // Only set when status === 'error'
  warnCount: number; // warn-level issues from validateItems/validateUnit on the parsed output
  errorCount: number; // error-level issues (excluding the fetch error itself)
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
  if (
    /mid[\s-]?sem|mid[\s-]?semester|prac(tical)?|lab|quiz|workshop|online test|etest/i.test(
      t,
    )
  )
    return false;
  if (/\bfinal\b/i.test(t)) return true;
  if (/\b(exam|examination)\b/i.test(t)) return true;
  return false;
}

/** Generate per-item validation issues for a set of parsed PendingDeadline items. */
function validateItems(items: PendingDeadline[]): Issue[] {
  const issues: Issue[] = [];

  // Pre-compute duplicate title counts (normalise away punctuation but keep numbers
  // so "Prac Test 1" and "Prac Test 2" are NOT flagged as duplicates)
  const normTitle = (t: string) =>
    t
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ");
  const titleCounts = new Map<string, number>();
  for (const item of items) {
    const key = normTitle(item.title ?? "");
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }

  for (const item of items) {
    // ── 1. Title empty / too short ────────────────────────────────────────────
    if (!item.title || item.title.length < 3) {
      issues.push({
        level: "error",
        item: item.title || "(empty)",
        msg: "Title is empty or too short",
        context: JSON.stringify(item.title),
      });
      continue;
    }

    // ── 2. '#' in title (null-byte artefact from OASIS PDF encoding) ──────────
    if (item.title.includes("#")) {
      issues.push({
        level: "warn",
        item: item.title,
        msg: 'Title contains "#" — null-byte encoding artefact from PDF extraction. Check the null-byte → "#" replacement in extractPDFText (parser.ts).',
        context: item.title,
      });
    }

    // ── 3. Title starts with a digit (AS_TASK row number leaked in) ───────────
    if (/^\d/.test(item.title)) {
      issues.push({
        level: "warn",
        item: item.title,
        msg: "Title starts with a digit — the row-number column from AS_TASK may have merged into the title. Check the pipe-split in parseAsTask (cols[1]).",
        context: item.title,
      });
    }

    // ── 4. Title suspiciously long (cell noise captured with title) ───────────
    if (item.title.length > 80) {
      issues.push({
        level: "warn",
        item: item.title,
        msg: `Title is ${item.title.length} chars — likely includes surrounding cell content or bracket notes. Check the title cleanup regex chain in parseAssessments / parsePcText.`,
        context: item.title.slice(0, 120),
      });
    }

    // ── 5. Duplicate / near-duplicate title ───────────────────────────────────
    if ((titleCounts.get(normTitle(item.title)) ?? 0) > 1) {
      issues.push({
        level: "warn",
        item: item.title,
        msg: "Duplicate or near-duplicate title — parser may have extracted this assessment more than once. Check mergeWithCalendar dedup logic and titlesOverlap matching.",
      });
    }

    // ── 6. TBA checks ─────────────────────────────────────────────────────────
    if (item.isTBA) {
      if (isFinalExamType(item.title)) {
        issues.push({
          level: "info",
          item: item.title,
          msg: "Exam period TBA — expected for final exams",
        });
      } else if (item.weekLabel && /\bweek\s+\d/i.test(item.weekLabel)) {
        issues.push({
          level: "warn",
          item: item.title,
          msg: `Week known (${item.weekLabel}) but exact date TBC — user must confirm`,
          context: item.weekLabel,
        });
      } else {
        issues.push({
          level: "warn",
          item: item.title,
          msg: "Date fully unknown — check PC_TEXT for a week hint in any column (buildWeekHints) or AS_TASK for inline date text.",
        });
      }
      // ── 7. Contradictory: TBA but exactTime is set ──────────────────────────
      if (item.exactTime) {
        issues.push({
          level: "warn",
          item: item.title,
          msg: `Item is TBA but has exactTime "${item.exactTime}" — time was extracted by EXACT_TIME_RE but the date resolve step didn't fire. Check parseOrdinalDate path in parsePcText.`,
          context: `exactTime: ${item.exactTime}`,
        });
      }
    }

    // ── 8. calSource=true but isTBA=true (contradictory parser flags) ─────────
    if (item.calSource && item.isTBA) {
      issues.push({
        level: "warn",
        item: item.title,
        msg: "calSource is true (came from PC_TEXT calendar) but isTBA is also true — date resolution should have succeeded if the row had a Begin Date. Possible bug in parseProgramCalendar date assignment.",
        context: `calSource: ${item.calSource}, isTBA: ${item.isTBA}`,
      });
    }

    // ── 9. Weight checks ──────────────────────────────────────────────────────
    if (item.weight === undefined) {
      issues.push({
        level: "warn",
        item: item.title,
        msg: 'No assessment weight extracted — check WEIGHT_PCT_RE in parsePcText and "percent" keyword match in parseAsTask.',
      });
    } else if (item.weight === 0) {
      issues.push({
        level: "warn",
        item: item.title,
        msg: 'Weight is 0% — likely a parsing error (e.g. matched "(0%)" in a note). Check WEIGHT_PCT_RE.',
        context: `weight: ${item.weight}`,
      });
    } else if (item.weight > 100) {
      issues.push({
        level: "warn",
        item: item.title,
        msg: `Weight is ${item.weight}% — exceeds 100%, likely grabbed the wrong number from the cell. Check WEIGHT_PCT_RE match group.`,
        context: `weight: ${item.weight}`,
      });
    }

    // ── 10. Date sanity checks (dated items only) ─────────────────────────────
    if (!item.isTBA && item.resolvedDate) {
      const now = Date.now();
      const itemTime = item.resolvedDate.getTime();
      const daysPast = (now - itemTime) / 86_400_000;
      const daysAhead = (itemTime - now) / 86_400_000;

      if (daysPast > 14) {
        issues.push({
          level: "warn",
          item: item.title,
          msg: `Date is ${Math.round(daysPast)} days in the past — verify semester/year selection or check semesterStart constants in getDates.ts.`,
          context: `resolvedDate: ${item.resolvedDate.toDateString()}`,
        });
      } else if (daysAhead > 548) {
        issues.push({
          level: "warn",
          item: item.title,
          msg: `Date is more than 18 months away — check the year field or month-to-index mapping in parsePcText (MONTH_MAP).`,
          context: `resolvedDate: ${item.resolvedDate.toDateString()}`,
        });
      }

      // ── 11. Weekend date ──────────────────────────────────────────────────────
      const dow = item.resolvedDate.getDay();
      if (dow === 0 || dow === 6) {
        issues.push({
          level: "info",
          item: item.title,
          msg: `Due date falls on a ${dow === 0 ? "Sunday" : "Saturday"} — unusual for assessed submissions. Verify against the unit outline.`,
          context: item.resolvedDate.toDateString(),
        });
      }
    }

    // ── 12. exactTime of 00:00 (likely a placeholder, not a real midnight) ────
    if (item.exactTime === "00:00") {
      issues.push({
        level: "info",
        item: item.title,
        msg: 'Exact time is 00:00 — may be a placeholder rather than a real midnight deadline. Real midnight cutoffs are typically written "23:59".',
        context: `exactTime: ${item.exactTime}`,
      });
    }
  }

  return issues;
}

/**
 * Generate unit-level (aggregate) validation issues.
 * Call this alongside validateItems() for a full picture of parse quality.
 *
 * @param items       Final merged PendingDeadline array
 * @param asTaskItems Parsed AS_TASK items (pass [] for PDF-only results)
 */
function validateUnit(
  items: PendingDeadline[],
  asTaskItems: Array<{ title: string; weight?: number }>,
): Issue[] {
  const issues: Issue[] = [];

  // ── 1. Zero items — complete parse failure ────────────────────────────────
  if (items.length === 0) {
    issues.push({
      level: "error",
      item: "(unit)",
      msg: "No items parsed — complete parse failure. Inspect the AS_TASK and PC_TEXT raw strings in the section below.",
    });
    return issues; // further checks are meaningless
  }

  // ── 2. All items TBA — PC_TEXT table not parsed ───────────────────────────
  if (items.every((i) => i.isTBA)) {
    issues.push({
      level: "warn",
      item: "(unit)",
      msg: `All ${items.length} items are TBA — PC_TEXT table was not parsed (Begin Date or Assessment column not detected). Check the PC_TEXT diagnostics below; the table layout may need a new column header pattern in parsePcText.`,
    });
  }

  // ── 3. Multiple final-exam-type items (likely duplication) ───────────────
  const finals = items.filter((i) => isFinalExamType(i.title));
  if (finals.length > 1) {
    issues.push({
      level: "warn",
      item: "(unit)",
      msg: `${finals.length} final-exam-type items detected — unlikely to have multiple finals. Check isFinalExamType() classification and mergeWithCalendar dedup.`,
      context: finals.map((i) => i.title).join(", "),
    });
  }

  // ── 4. Weight sum checks ──────────────────────────────────────────────────
  const weightedItems = items.filter((i) => i.weight !== undefined);
  if (weightedItems.length >= 2) {
    const totalWeight = weightedItems.reduce((sum, i) => sum + i.weight!, 0);
    if (totalWeight > 110) {
      issues.push({
        level: "warn",
        item: "(unit)",
        msg: `Assessment weights sum to ${totalWeight}% — expected ~100%. Check for duplicate items or incorrect weight extraction (WEIGHT_PCT_RE / parseAsTask column split).`,
        context: `${weightedItems.length} weighted items, sum = ${totalWeight}%`,
      });
    } else if (weightedItems.length === items.length && totalWeight < 90) {
      issues.push({
        level: "warn",
        item: "(unit)",
        msg: `All ${items.length} items have weights but they sum to only ${totalWeight}% — the outline may have items with unextractable weights or a hidden assessment.`,
        context: `${weightedItems.length} items, sum = ${totalWeight}%`,
      });
    }
  }

  // ── 5. AS_TASK count vs result count mismatch ─────────────────────────────
  if (asTaskItems.length > 0 && items.length < asTaskItems.length) {
    issues.push({
      level: "warn",
      item: "(unit)",
      msg: `Result has ${items.length} items but AS_TASK lists ${asTaskItems.length} — ${asTaskItems.length - items.length} assessment(s) may have been silently dropped. Check outlineToDeadlines TBA fallback loop.`,
      context: `AS_TASK: ${asTaskItems.length}, result: ${items.length}`,
    });
  }

  // ── 6. Many items sharing the exact same due date ─────────────────────────
  const dateMap = new Map<string, string[]>();
  for (const item of items) {
    if (!item.isTBA && item.resolvedDate) {
      const key = item.resolvedDate.toDateString();
      const group = dateMap.get(key) ?? [];
      group.push(item.title);
      dateMap.set(key, group);
    }
  }
  for (const [dateStr, titles] of dateMap) {
    if (titles.length >= 3) {
      issues.push({
        level: "info",
        item: "(unit)",
        msg: `${titles.length} items share the same due date (${dateStr}) — may be correct for weekly formats, or the Begin Date was applied to all cells in a week row rather than individual due dates.`,
        context: titles.join(", "),
      });
    }
  }

  // ── 7. Items outside expected semester date range ─────────────────────────
  const datedItems = items.filter((i) => !i.isTBA && i.resolvedDate);
  if (datedItems.length > 0 && items[0].semester && items[0].year) {
    const sem = items[0].semester;
    const yr = items[0].year;
    // Generous range: S1 = Jan–Jul, S2 = Jul–Dec
    const rangeStart = sem === 1 ? new Date(yr, 0, 1) : new Date(yr, 6, 1);
    const rangeEnd = sem === 1 ? new Date(yr, 6, 31) : new Date(yr, 11, 31);
    const outOfRange = datedItems.filter(
      (i) => i.resolvedDate! < rangeStart || i.resolvedDate! > rangeEnd,
    );
    if (outOfRange.length > 0) {
      issues.push({
        level: "warn",
        item: "(unit)",
        msg: `${outOfRange.length} item(s) fall outside the expected S${sem} ${yr} date range — check parsePcText month/year assignment or whether the outline contains dates from a different semester.`,
        context: outOfRange
          .map((i) => `${i.title}: ${i.resolvedDate!.toDateString()}`)
          .join("; "),
      });
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
    weekKnown: tbaItems.filter(
      (i) => i.weekLabel && /\bweek\s+\d/i.test(i.weekLabel),
    ).length,
    noWeight: items.filter((i) => i.weight === undefined).length,
  };
}

// ── Parser diagnostics ─────────────────────────────────────────────────────────

/** Structural analysis of a PC_TEXT HTML table — mirrors parsePcText column detection. */
interface PcTextDiagnostic {
  hasTable: boolean;
  rowCount: number; // Total data rows (excluding header)
  teachingRowCount: number; // Rows with a valid date not matching non-teaching keywords
  headers: string[]; // Raw text of each header cell
  beginDateColIdx: number; // -1 = not found → dates cannot be resolved
  assessmentColIdxs: number[]; // Indices of detected assessment / standalone workshop columns
  skippedRowLabels: string[]; // Begin-date cell text for each non-teaching row skipped
}

/** One entry in the AS_TASK ↔ PC_TEXT matching reconstruction. */
interface MatchEntry {
  asTask: string;
  weight?: number;
  pcTextItems: string[]; // PC_TEXT titles that matched this AS_TASK item
  outcome: "matched" | "tba-fallback";
}

/** Summary of how AS_TASK items mapped to PC_TEXT calendar items. */
interface AsTaskMatchDiagnostic {
  matches: MatchEntry[];
  orphanPcText: string[]; // Dated items not associated with any AS_TASK entry
}

// NON_TEACHING_RE must match the constant in outlineApi.ts exactly
const DIAG_NON_TEACHING_RE =
  /tuition\s+free|study\s+week|examination|mid[- ]semester\s+break/i;

/**
 * Analyses the structure of a PC_TEXT HTML table to expose exactly which columns
 * were detected and why rows were accepted or skipped.
 * Mirrors parsePcText column-detection logic (outlineApi.ts) for diagnostic visibility.
 */
function diagnosePcText(pcText: string): PcTextDiagnostic {
  const empty: PcTextDiagnostic = {
    hasTable: false,
    rowCount: 0,
    teachingRowCount: 0,
    headers: [],
    beginDateColIdx: -1,
    assessmentColIdxs: [],
    skippedRowLabels: [],
  };
  if (!pcText) return empty;

  const doc = new DOMParser().parseFromString(pcText, "text/html");
  const rows = Array.from(doc.querySelectorAll("tr"));
  if (rows.length === 0) return empty;

  const cellText = (el: Element | undefined): string =>
    (el?.textContent ?? "").replace(/\u00A0/g, " ").trim();

  const headerCells = Array.from(rows[0].querySelectorAll("th, td"));
  const headers = headerCells.map(cellText);

  let beginDateColIdx = -1;
  const assessmentColIdxs: number[] = [];
  headerCells.forEach((cell, i) => {
    const t = cellText(cell).toLowerCase();
    if (t.includes("begin") && t.includes("date")) beginDateColIdx = i;
    if (t.includes("assessment")) assessmentColIdxs.push(i);
    else if (
      t.includes("workshop") &&
      !t.includes("lecture") &&
      !t.includes("tut")
    )
      assessmentColIdxs.push(i);
  });

  const skippedRowLabels: string[] = [];
  let teachingRowCount = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll("td, th"));
    if (cells.length === 0) continue;
    const beginDateText =
      beginDateColIdx >= 0 ? cellText(cells[beginDateColIdx]) : "";
    if (!beginDateText) continue;
    if (DIAG_NON_TEACHING_RE.test(beginDateText)) {
      skippedRowLabels.push(beginDateText);
    } else if (/^\d{1,2}\s+\w+/.test(beginDateText)) {
      teachingRowCount++;
    }
  }

  return {
    hasTable: true,
    rowCount: rows.length - 1,
    teachingRowCount,
    headers,
    beginDateColIdx,
    assessmentColIdxs,
    skippedRowLabels,
  };
}

/**
 * Reconstructs which AS_TASK items matched PC_TEXT calendar items and which fell
 * through as TBA fallbacks — mirrors titlesOverlap logic in outlineApi.ts.
 */
function diagnoseMatching(
  parsed: PendingDeadline[],
  asTaskItems: Array<{ title: string; weight?: number }>,
): AsTaskMatchDiagnostic {
  if (asTaskItems.length === 0) return { matches: [], orphanPcText: [] };

  // Simplified first-word prefix overlap (mirrors titlesOverlap in outlineApi.ts)
  const firstWord = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z]/g, " ")
      .split(/\s+/)
      .find((w) => w.length >= 3) ?? "";
  const overlap = (a: string, b: string): boolean => {
    const fa = firstWord(a);
    const fb = firstWord(b);
    return (
      fa.length > 0 && fb.length > 0 && (fa.startsWith(fb) || fb.startsWith(fa))
    );
  };

  const datedItems = parsed.filter((i) => !i.isTBA);

  const matches: MatchEntry[] = asTaskItems.map((asItem) => {
    const pcMatches = datedItems.filter((p) => overlap(asItem.title, p.title));
    return {
      asTask: asItem.title,
      weight: asItem.weight,
      pcTextItems: pcMatches.map((p) => p.title),
      outcome: pcMatches.length > 0 ? "matched" : "tba-fallback",
    };
  });

  // PC_TEXT dated items with no corresponding AS_TASK entry
  const orphanPcText = datedItems
    .filter((p) => !asTaskItems.some((a) => overlap(a.title, p.title)))
    .map((p) => p.title);

  return { matches, orphanPcText };
}

/**
 * Renders the PC_TEXT structural analysis and AS_TASK ↔ PC_TEXT matching table
 * as an HTML string. Wire .raw-toggle elements after injecting into the DOM.
 */
function renderDiagnostics(
  pcDiag: PcTextDiagnostic,
  matchDiag: AsTaskMatchDiagnostic,
  pcText: string,
): string {
  let html = '<div class="diag-wrap">';

  // ── PC_TEXT structure ──────────────────────────────────────────────────────
  html += '<div class="diag-section">';
  html += '<strong class="diag-heading">PC_TEXT table structure</strong>';
  if (!pcDiag.hasTable) {
    html +=
      '<p style="color:var(--error);font-size:12px">✗ No &lt;tr&gt; rows found in PC_TEXT — table may be absent or in an unexpected format.</p>';
  } else {
    const bdStatus =
      pcDiag.beginDateColIdx >= 0
        ? `<span class="tag tag-ok">✓ col ${pcDiag.beginDateColIdx}</span>`
        : `<span class="tag tag-err">✗ not found — dates cannot be resolved without this column</span>`;
    const assStatus =
      pcDiag.assessmentColIdxs.length > 0
        ? `<span class="tag tag-ok">✓ col(s) ${pcDiag.assessmentColIdxs.join(", ")}</span>`
        : `<span class="tag tag-err">✗ none found — no "assessment" or standalone "workshop" header detected</span>`;
    const headerList = pcDiag.headers
      .map((h, i) => {
        const cls = pcDiag.assessmentColIdxs.includes(i)
          ? "diag-col diag-col-assmt"
          : i === pcDiag.beginDateColIdx
            ? "diag-col diag-col-date"
            : "diag-col";
        return `<code class="${cls}">${escHtml(h || "(empty)")}</code>`;
      })
      .join(" ");

    html += `<ul class="diag-list">
      <li><strong>Headers:</strong> ${headerList}</li>
      <li><strong>Begin Date column:</strong> ${bdStatus}</li>
      <li><strong>Assessment column(s):</strong> ${assStatus}</li>
      <li><strong>Rows:</strong> ${pcDiag.rowCount} total · <strong>${pcDiag.teachingRowCount}</strong> teaching weeks parsed</li>
      ${
        pcDiag.skippedRowLabels.length > 0
          ? `<li><strong>Skipped (non-teaching):</strong> ${pcDiag.skippedRowLabels.map((l) => `<code>${escHtml(l)}</code>`).join(", ")}</li>`
          : '<li style="color:var(--muted)">No non-teaching rows detected</li>'
      }
    </ul>`;
  }
  html += "</div>";

  // ── AS_TASK ↔ PC_TEXT matching ─────────────────────────────────────────────
  if (matchDiag.matches.length > 0) {
    html += '<div class="diag-section" style="margin-top:14px">';
    html += '<strong class="diag-heading">AS_TASK ↔ PC_TEXT matching</strong>';
    html +=
      '<table class="diag-table"><thead><tr><th>AS_TASK item</th><th>Wt</th><th>Matched PC_TEXT items</th><th>Outcome</th></tr></thead><tbody>';

    for (const m of matchDiag.matches) {
      const tag =
        m.outcome === "matched"
          ? `<span class="tag tag-ok">✓ ${m.pcTextItems.length} match${m.pcTextItems.length !== 1 ? "es" : ""}</span>`
          : `<span class="tag tag-warn">⚠ TBA fallback</span>`;
      html += `<tr>
        <td>${escHtml(m.asTask)}</td>
        <td>${m.weight !== undefined ? `${m.weight}%` : '<span style="color:var(--muted)">—</span>'}</td>
        <td>${m.pcTextItems.length > 0 ? m.pcTextItems.map((t) => `<code>${escHtml(t)}</code>`).join(", ") : '<span style="color:var(--muted)">—</span>'}</td>
        <td>${tag}</td>
      </tr>`;
    }

    // Orphaned PC_TEXT items (dated but not tied to any AS_TASK entry)
    for (const o of matchDiag.orphanPcText) {
      html += `<tr>
        <td colspan="2" style="color:var(--muted)">(no AS_TASK match)</td>
        <td><code>${escHtml(o)}</code></td>
        <td><span class="tag tag-info">ℹ Orphan</span></td>
      </tr>`;
    }
    html += "</tbody></table></div>";
  }

  // ── Rendered PC_TEXT table (collapsible) ───────────────────────────────────
  if (pcText) {
    // Use a unique ID to avoid collisions when multiple units are expanded at once
    const diagId = `diag-pctxt-${Math.random().toString(36).slice(2, 8)}`;
    html += `<div class="diag-section" style="margin-top:14px">`;
    html += `<span class="raw-toggle" data-raw-id="${diagId}">▸ Rendered PC_TEXT table</span>`;
    // Render the Curtin API HTML directly — safe in the extension's own page context
    html += `<div class="diag-pctxt-rendered raw-box hidden" id="${diagId}">${pcText}</div>`;
    html += `</div>`;
  }

  html += "</div>"; // .diag-wrap
  return html;
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
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+\d+$/, "")
      .replace(/[^a-z0-9]/g, "");

  const added: DriftResult["added"] = [];
  const removed: DriftResult["removed"] = [];
  const changed: DriftResult["changed"] = [];
  let unchanged = 0;

  // Check each fresh item against stored
  for (const freshItem of fresh) {
    const match = unitStored.find(
      (s) => norm(s.title) === norm(freshItem.title),
    );
    if (!match) {
      added.push({
        title: freshItem.title,
        weekLabel: freshItem.weekLabel,
        weight: freshItem.weight,
      });
    } else {
      // Check for weight changes
      if (
        freshItem.weight !== undefined &&
        match.weight !== undefined &&
        freshItem.weight !== match.weight
      ) {
        changed.push({
          title: freshItem.title,
          field: "weight",
          from: match.weight,
          to: freshItem.weight,
        });
      } else {
        unchanged++;
      }
    }
  }

  // Check each stored item against fresh
  for (const storedItem of unitStored) {
    const stillExists = fresh.some(
      (f) => norm(f.title) === norm(storedItem.title),
    );
    if (!stillExists) {
      removed.push({ title: storedItem.title });
    }
  }

  return { added, removed, changed, unchanged };
}

// ── Regression check ───────────────────────────────────────────────────────────

function checkRegression(
  unit: string,
  summary: ResultSummary,
): RegressionResult | null {
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
  const local = await chrome.storage.local.get("deadlines");
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
    entry = {
      unit,
      semester,
      year,
      api: null,
      pdf: null,
      drift: null,
      regression: null,
    };
    results.set(unit, entry);
  }

  const stored = await loadStoredDeadlines();

  try {
    const data: OutlineData = await fetchOutlineData(unit, semester, year);
    const issues = [
      ...validateItems(data.parsed),
      ...validateUnit(data.parsed, data.asTaskItems),
    ];
    const summary = summarise(data.parsed);
    entry.api = {
      success: true,
      asTask: data.asTask,
      pcText: data.pcText,
      rawOutline: data.rawOutline,
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
      asTask: "",
      pcText: "",
      asTaskItems: [],
      parsed: [],
      issues: [
        {
          level: "error",
          item: unit,
          msg: err instanceof Error ? err.message : String(err),
        },
      ],
      summary: {
        total: 0,
        dated: 0,
        tba: 0,
        examPeriod: 0,
        weekKnown: 0,
        noWeight: 0,
      },
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
  const unit = unitMatch ? unitMatch[1] : "UNKNOWN";

  let entry = results.get(unit);
  if (!entry) {
    entry = {
      unit,
      semester,
      year,
      api: null,
      pdf: null,
      drift: null,
      regression: null,
    };
    results.set(unit, entry);
  }

  const rawText = await extractPDFText(file);
  const unitName = parseUnitName(rawText, unit);
  const schedule = parseAssessments(rawText, unit, year, semester);
  const calendar = parseProgramCalendar(rawText, unit, year, semester);
  const merged = addSequenceNumbers(mergeWithCalendar(schedule, calendar));

  // Attach inferred unit name
  if (unitName) {
    merged.forEach((item) => {
      item.unitName = unitName;
    });
  }

  const issues = [...validateItems(merged), ...validateUnit(merged, [])];
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
  onProgress: (
    processed: number,
    total: number,
    ok: number,
    notOffered: number,
    errors: number,
  ) => void,
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
          // Run validation so issue counts appear in the download report
          const issueList = [
            ...validateItems(data.parsed),
            ...validateUnit(data.parsed, data.asTaskItems),
          ];
          entry = {
            unit,
            semester,
            year,
            status: "ok",
            itemCount: summary.total,
            tbaCount: summary.tba,
            examPeriodCount: summary.examPeriod,
            noWeightCount: summary.noWeight,
            warnCount: issueList.filter((i) => i.level === "warn").length,
            errorCount: issueList.filter((i) => i.level === "error").length,
          };
          okCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Distinguish "not offered this semester/campus" from genuine API errors
          const isNotOffered =
            msg.includes("No Bentley Perth offering") ||
            msg.includes("not found in the Curtin unit list");
          entry = {
            unit,
            semester,
            year,
            status: isNotOffered ? "not-offered" : "error",
            itemCount: 0,
            tbaCount: 0,
            examPeriodCount: 0,
            noWeightCount: 0,
            warnCount: 0,
            errorCount: 0,
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
      offered: grabAllResults.filter((e) => e.status === "ok").length,
      notOffered: grabAllResults.filter((e) => e.status === "not-offered")
        .length,
      errors: grabAllResults.filter((e) => e.status === "error").length,
    },
    results: grabAllResults,
  };

  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `curtin-grab-all-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── DOM rendering helpers ──────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function levelTag(level: Issue["level"]): string {
  const map: Record<Issue["level"], string> = {
    ok: "ok",
    info: "info",
    warn: "warn",
    error: "err",
  };
  const labels: Record<Issue["level"], string> = {
    ok: "✓ OK",
    info: "ℹ INFO",
    warn: "⚠ WARN",
    error: "✗ ERROR",
  };
  return `<span class="tag tag-${map[level]}">${labels[level]}</span>`;
}

/** Render a detail table + issues list for a set of parsed items. */
function renderDetailTable(parsed: PendingDeadline[], issues: Issue[]): string {
  if (parsed.length === 0) {
    return '<p class="tp-empty">No items parsed.</p>';
  }

  const rows = parsed
    .map((item) => {
      const date = item.resolvedDate
        ? item.resolvedDate.toLocaleDateString("en-AU", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })
        : (item.weekLabel ?? "—");
      const tbaTag = item.isTBA
        ? `<span class="tag tag-warn">TBA</span>`
        : `<span class="tag tag-ok">Dated</span>`;
      const weight =
        item.weight !== undefined
          ? `${item.weight}%`
          : '<span style="color:var(--muted)">—</span>';
      const week = item.weekLabel ? escHtml(item.weekLabel) : "—";
      // Source: calSource=true → came from PC_TEXT calendar; false/undefined → AS_TASK fallback
      const source = item.calSource
        ? `<span class="tag tag-info">Calendar</span>`
        : `<span class="tag tag-warn" title="AS_TASK fallback — no matching date found in PC_TEXT">AS_TASK</span>`;
      return `<tr>
      <td>${tbaTag}</td>
      <td>${escHtml(item.title)}</td>
      <td>${escHtml(item.unit)}</td>
      <td>${escHtml(date)}</td>
      <td>${week}</td>
      <td>${weight}</td>
      <td>${source}</td>
    </tr>`;
    })
    .join("");

  const table = `
    <table class="detail-table">
      <thead><tr>
        <th>Status</th><th>Title</th><th>Unit</th><th>Date</th><th>Week</th><th>Weight</th><th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  const issueRows =
    issues.length === 0
      ? '<li><span class="tag tag-ok">✓ OK</span> <span class="issue-item">No issues found</span></li>'
      : issues
          .map(
            (iss) => `
        <li>
          ${levelTag(iss.level)}
          <span class="issue-item">
            <strong>${escHtml(iss.item)}</strong> — ${escHtml(iss.msg)}
            ${iss.context ? `<code class="issue-context">${escHtml(iss.context)}</code>` : ""}
          </span>
        </li>`,
          )
          .join("");

  return `${table}
    <ul class="issues-list" style="margin-top:12px">${issueRows}</ul>`;
}

/** Render the raw AS_TASK + PC_TEXT strings with a toggle. */
function renderRawInspector(asTask: string, pcText: string): string {
  if (!asTask && !pcText) return "";
  return `
    <span class="raw-toggle" data-raw-id="raw-astask">▸ AS_TASK (raw)</span>
    <div class="raw-box hidden" id="raw-astask">${escHtml(asTask)}</div>
    <span class="raw-toggle" data-raw-id="raw-pctxt" style="margin-left:12px">▸ PC_TEXT (HTML)</span>
    <div class="raw-box hidden" id="raw-pctxt">${escHtml(pcText)}</div>`;
}

/** Render the drift sub-section for a unit result. */
function renderDrift(drift: DriftResult): string {
  if (
    drift.added.length === 0 &&
    drift.removed.length === 0 &&
    drift.changed.length === 0
  ) {
    return `<p style="font-size:12px;color:var(--muted);margin-top:8px">
      ✓ ${drift.unchanged} item(s) match saved deadlines — no drift detected.</p>`;
  }

  const items = [
    ...drift.added.map(
      (a) => `<li>
      <span class="drift-sym drift-new">+</span>
      <span>NEW: <strong>${escHtml(a.title)}</strong>${a.weekLabel ? ` · ${escHtml(a.weekLabel)}` : ""}${a.weight !== undefined ? ` · ${a.weight}%` : ""} — in outline, not saved</span>
    </li>`,
    ),
    ...drift.removed.map(
      (r) => `<li>
      <span class="drift-sym drift-gone">−</span>
      <span>GONE: <strong>${escHtml(r.title)}</strong> — saved but no longer in outline</span>
    </li>`,
    ),
    ...drift.changed.map(
      (c) => `<li>
      <span class="drift-sym drift-chg">~</span>
      <span>CHANGED: <strong>${escHtml(c.title)}</strong> ${escHtml(c.field)}: ${escHtml(String(c.from))} → ${escHtml(String(c.to))}</span>
    </li>`,
    ),
  ].join("");

  if (drift.unchanged > 0) {
    items.concat(
      `<li><span class="drift-sym status-info">·</span><span>${drift.unchanged} item(s) unchanged</span></li>`,
    );
  }

  return `<ul class="drift-list">${items}</ul>`;
}

/** Render the API ↔ PDF diff table. */
function renderDiff(
  apiItems: PendingDeadline[],
  pdfItems: PendingDeadline[],
): string {
  if (apiItems.length === 0 && pdfItems.length === 0) {
    return '<p class="tp-empty">No items to compare.</p>';
  }

  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+\d+$/, "")
      .replace(/[^a-z0-9]/g, "");

  // Union of all titles
  const allTitles = [
    ...new Set([
      ...apiItems.map((i) => norm(i.title)),
      ...pdfItems.map((i) => norm(i.title)),
    ]),
  ];

  const rows = allTitles
    .map((key) => {
      const api = apiItems.find((i) => norm(i.title) === key);
      const pdf = pdfItems.find((i) => norm(i.title) === key);
      const title = api?.title ?? pdf?.title ?? key;

      const fmt = (item: PendingDeadline | undefined): string => {
        if (!item) return '<span style="color:var(--muted)">(not found)</span>';
        const date = item.resolvedDate
          ? item.resolvedDate.toLocaleDateString("en-AU", {
              day: "numeric",
              month: "short",
            })
          : (item.weekLabel ?? "TBA");
        const w = item.weight !== undefined ? ` · ${item.weight}%` : "";
        return `${escHtml(date)}${w}`;
      };

      let matchCell = '<span class="tag tag-ok">✓</span>';
      if (!api || !pdf) {
        matchCell = `<span class="tag tag-err">✗ missing in ${!api ? "API" : "PDF"}</span>`;
      } else if (
        api.weight !== pdf.weight &&
        api.weight !== undefined &&
        pdf.weight !== undefined
      ) {
        matchCell = `<span class="tag tag-warn">⚠ weight differs</span>`;
      }

      return `<tr>
      <td>${escHtml(title)}</td>
      <td>${fmt(api)}</td>
      <td>${fmt(pdf)}</td>
      <td>${matchCell}</td>
    </tr>`;
    })
    .join("");

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
    const failures =
      reg.failures.length > 0 ? escHtml(reg.failures.join("; ")) : "—";
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
    <tbody>${rows.join("")}</tbody>
  </table>`;
}

// ── Scan All rendering ─────────────────────────────────────────────────────────

/** Render one row in the scan summary table. */
function makeScanRow(result: UnitResult): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "scan-row";
  tr.dataset.unit = result.unit;

  const api = result.api;
  let statusCell: string;
  let datedCell = "—";
  let tbaCell = "—";
  let issuesCell = "";

  if (!api) {
    statusCell = `<span class="spinner"></span> Fetching…`;
  } else if (!api.success) {
    statusCell = `<span class="tag tag-err">✗ Error</span>`;
    issuesCell = `<span class="status-err">${escHtml(api.error ?? "Unknown error")}</span>`;
  } else {
    const warnCount = api.issues.filter((i) => i.level === "warn").length;
    const errCount = api.issues.filter((i) => i.level === "error").length;
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
      .filter((i) => i.level !== "ok")
      .slice(0, 2)
      .map(
        (i) =>
          `<span style="font-size:11px;color:var(--${i.level === "error" ? "error" : i.level === "warn" ? "warn" : "muted"})">${escHtml(i.msg)}</span>`,
      )
      .join("<br>");
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
function toggleScanDetail(
  tr: HTMLTableRowElement,
  tbody: HTMLTableSectionElement,
): void {
  const unit = tr.dataset.unit!;
  const existingDetail = tbody.querySelector<HTMLTableRowElement>(
    `tr.scan-detail-row[data-unit="${unit}"]`,
  );

  if (existingDetail) {
    existingDetail.remove();
    return;
  }

  const result = results.get(unit);
  if (!result?.api) return;

  const api = result.api;
  const detailTr = document.createElement("tr");
  detailTr.className = "scan-detail-row";
  detailTr.dataset.unit = unit;
  detailTr.innerHTML = `<td colspan="5"><div class="scan-detail-inner" id="detail-${unit}"></div></td>`;

  tr.insertAdjacentElement("afterend", detailTr);

  const inner = detailTr.querySelector<HTMLElement>(`#detail-${unit}`)!;

  let html = `<strong style="font-size:13px">${escHtml(unit)} — API result</strong>`;
  html += renderDetailTable(api.parsed, api.issues);

  if (result.drift) {
    html += `<div style="margin-top:12px"><strong style="font-size:12px">Drift vs saved deadlines</strong>`;
    html += renderDrift(result.drift);
    html += `</div>`;
  }

  // Parser diagnostics: PC_TEXT structure + AS_TASK ↔ PC_TEXT matching table
  html += `<div style="margin-top:14px"><strong style="font-size:12px">Parser diagnostics</strong>`;
  html += renderDiagnostics(
    diagnosePcText(api.pcText),
    diagnoseMatching(api.parsed, api.asTaskItems),
    api.pcText,
  );
  html += `</div>`;

  html += `<div style="margin-top:12px">`;
  html += renderRawInspector(api.asTask, api.pcText);
  html += `</div>`;

  inner.innerHTML = html;

  // Wire raw toggles (including the rendered PC_TEXT toggle) in the new detail panel
  inner.querySelectorAll<HTMLElement>(".raw-toggle").forEach(wireRawToggle);
}

// ── Raw toggle wiring ──────────────────────────────────────────────────────────

function wireRawToggle(el: HTMLElement): void {
  el.addEventListener("click", () => {
    const box = el.nextElementSibling as HTMLElement;
    if (!box) return;
    const open = !box.classList.contains("hidden");
    box.classList.toggle("hidden", open);
    el.textContent =
      (open ? "▸ " : "▾ ") + el.textContent!.replace(/^[▸▾] /, "");
  });
}

// ── Section collapse/expand ────────────────────────────────────────────────────

function wireSection(header: HTMLElement): void {
  const targetId = header.dataset.target!;
  const body = document.getElementById(targetId)!;

  const toggle = (): void => {
    const collapsed = header.classList.toggle("collapsed");
    body.classList.toggle("hidden", collapsed);
    // Sync ARIA state so screen readers announce the new expanded/collapsed status
    header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };

  header.addEventListener("click", (e) => {
    // Don't toggle if the click was on a button inside the header
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    toggle();
  });

  // Make keyboard-focusable headers activatable with Enter / Space (ARIA button pattern)
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
}

// ── Report generation ──────────────────────────────────────────────────────────

function buildReport(): object {
  const units = [...results.values()].map((r) => ({
    unit: r.unit,
    semester: r.semester,
    year: r.year,
    api: r.api
      ? {
          success: r.api.success,
          error: r.api.error,
          rawAsTask: r.api.asTask,
          rawPcText: r.api.pcText,
          asTaskItems: r.api.asTaskItems,
          parsed: r.api.parsed.map(serializePending),
          issues: r.api.issues,
          summary: r.api.summary,
          // All field names returned by the API for this outline.
          rawOutlineKeys: r.api.rawOutline ? Object.keys(r.api.rawOutline) : [],
          // Values of fields that may carry assessment-schedule data we aren't
          // yet extracting. Large HTML blobs (PC_TEXT, SY_TEXT_BODY, etc.) are
          // skipped; everything else is included for discovery.
          rawOutlineExtra: (() => {
            if (!r.api.rawOutline) return {};
            const SKIP = new Set([
              "PC_TEXT",
              "SY_TEXT_BODY",
              "ITP_ONLINE",
              "ITP_FIELDWORK",
              "ITP_TUITION_PATTERN",
              "LA_TEXT",
              "RUI_TEXT",
              "Contact_Section",
              "Syllabus_Section",
              "Introduction_Section",
              "UnitLearning_Section",
              "LearningActivities_Section",
              "LearningResources_Section",
              "LR_EssentialSoftware_Section",
              "LR_OtherResources_Section",
              "PassRequirements_Section",
              "AssessmentMod_Section",
              "AssessmentStd_Section",
              "ReferencingStyle_Section",
              "AddInfo_Section",
              "RecentUnitChanges_Section",
              "ProgramCalendar_Section",
            ]);
            // Include the "interesting" skipped fields separately, truncated
            const interesting: Record<string, unknown> = {};
            const INCLUDE_TRUNCATED = [
              "ITP_TUITION_PATTERN",
              "LA_TEXT",
              "PC_Landscape",
              "AM_PAM",
              "AM_IAM",
              "AM_ASPM1",
              "AM_ASPM2",
              "AM_ASPM4",
              "AM_ASPNP",
              "PS_Requirements",
              "AS_TASK",
              "AssessmentTasks_Section",
            ];
            for (const k of INCLUDE_TRUNCATED) {
              const v = r.api.rawOutline[k];
              if (typeof v === "string" && v.trim()) {
                interesting[k] = v.length > 2000 ? v.slice(0, 2000) + "…" : v;
              } else if (v !== null && v !== undefined && v !== "") {
                interesting[k] = v;
              }
            }
            // All non-HTML, non-skipped string/primitive fields
            const rest: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(r.api.rawOutline)) {
              if (SKIP.has(k) || INCLUDE_TRUNCATED.includes(k)) continue;
              if (typeof v === "string" && v.length > 200) continue;
              if (v === null || v === "" || v === false) continue;
              rest[k] = v;
            }
            return { interesting, rest };
          })(),
          // Structured parser diagnostics — mirrors the panel's visual output
          pcTextDiagnostic: diagnosePcText(r.api.pcText),
          matchingDiagnostic: diagnoseMatching(r.api.parsed, r.api.asTaskItems),
        }
      : null,
    pdf: r.pdf
      ? {
          filename: r.pdf.filename,
          parsed: r.pdf.parsed.map(serializePending),
          issues: r.pdf.issues,
          summary: r.pdf.summary,
        }
      : null,
    drift: r.drift,
    regression: r.regression,
  }));

  const totals = {
    units: units.length,
    items: units.reduce((s, u) => s + (u.api?.summary.total ?? 0), 0),
    dated: units.reduce((s, u) => s + (u.api?.summary.dated ?? 0), 0),
    tba: units.reduce((s, u) => s + (u.api?.summary.tba ?? 0), 0),
    errors: units.filter((u) => u.api && !u.api.success).length,
    regressionFails: units.filter((u) => u.regression && !u.regression.pass)
      .length,
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
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const unitKeys = [...results.keys()];
  const unitLabel =
    unitKeys.length === 1 ? unitKeys[0] : `${unitKeys.length}-units`;
  a.download = `curtin-test-${unitLabel}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function copyReport(): void {
  const report = buildReport();
  navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
    const msg = document.getElementById("copy-msg");
    if (msg) {
      msg.textContent = "Copied!";
      setTimeout(() => {
        msg.textContent = "";
      }, 2000);
    }
  });
}

// ── Main init ──────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // ── Theme toggle ────────────────────────────────────────────────────────
  const themeBtn = document.getElementById("theme-btn")!;
  const dark = localStorage.getItem("tp-dark") === "1";
  if (dark) document.body.classList.add("dark");
  themeBtn.textContent = dark ? "Light mode" : "Dark mode";
  themeBtn.addEventListener("click", () => {
    const isDark = document.body.classList.toggle("dark");
    themeBtn.textContent = isDark ? "Light mode" : "Dark mode";
    localStorage.setItem("tp-dark", isDark ? "1" : "0");
  });

  // ── Section headers ─────────────────────────────────────────────────────
  document
    .querySelectorAll<HTMLElement>(".tp-section-header")
    .forEach(wireSection);

  // ── Raw toggles (initial page load) ────────────────────────────────────
  document.querySelectorAll<HTMLElement>(".raw-toggle").forEach(wireRawToggle);

  // ── 1. Scan All ─────────────────────────────────────────────────────────
  const scanBtn = document.getElementById("scan-btn") as HTMLButtonElement;
  const scanReportBtn = document.getElementById(
    "scan-report-btn",
  ) as HTMLButtonElement;
  const scanStatus = document.getElementById("scan-status")!;
  const scanResults = document.getElementById("scan-results")!;

  scanBtn.addEventListener("click", async () => {
    scanBtn.disabled = true;
    scanResults.innerHTML = "";
    scanStatus.innerHTML = '<span class="spinner"></span> Discovering units…';

    const sem = parseInt(
      (document.getElementById("scan-sem") as HTMLSelectElement).value,
    ) as 1 | 2;
    const year =
      parseInt(
        (document.getElementById("scan-year") as HTMLInputElement).value,
        10,
      ) || 2026;
    const extra = (
      document.getElementById("scan-extra") as HTMLInputElement
    ).value
      .trim()
      .toUpperCase();

    // Build unit list from storage + any extras entered by user
    const storedUnits = await getStoredUnits();
    const extraUnits = extra ? extra.split(/[\s,]+/).filter(Boolean) : [];
    const units = [...new Set([...storedUnits, ...extraUnits])];

    if (units.length === 0) {
      scanStatus.textContent =
        'No saved deadlines found. Enter a unit code in "Extra unit" to test.';
      scanBtn.disabled = false;
      return;
    }

    // Build the scan table
    const table = document.createElement("table");
    table.className = "scan-table";
    table.innerHTML = `
      <thead><tr>
        <th>Unit</th><th>Status</th><th>Dated</th><th>TBA</th><th>Issues</th>
      </tr></thead>`;
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    scanResults.appendChild(table);

    // Placeholder rows while fetching
    const rowMap = new Map<string, HTMLTableRowElement>();
    for (const unit of units) {
      const placeholderResult: UnitResult = {
        unit,
        semester: sem,
        year,
        api: null,
        pdf: null,
        drift: null,
        regression: null,
      };
      results.set(unit, placeholderResult);
      const tr = makeScanRow(placeholderResult);
      tbody.appendChild(tr);
      rowMap.set(unit, tr);
    }

    // Wire row expand/collapse and re-test buttons
    function wireRow(tr: HTMLTableRowElement): void {
      tr.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("retest-btn")) return;
        toggleScanDetail(tr, tbody);
      });
      tr.querySelector<HTMLButtonElement>(".retest-btn")?.addEventListener(
        "click",
        async (e) => {
          e.stopPropagation();
          const unit = (e.currentTarget as HTMLElement).dataset.unit!;
          const existing = tbody.querySelector<HTMLTableRowElement>(
            `tr.scan-detail-row[data-unit="${unit}"]`,
          );
          existing?.remove();
          scanStatus.innerHTML = `<span class="spinner"></span> Re-testing ${unit}…`;
          const result = await runApiTest(unit, sem, year);
          const newTr = makeScanRow(result);
          wireRow(newTr);
          tr.replaceWith(newTr);
          rowMap.set(unit, newTr);
          scanStatus.textContent = `Re-test complete: ${unit}`;
          updateRegressionSection();
        },
      );
    }

    tbody.querySelectorAll<HTMLTableRowElement>(".scan-row").forEach(wireRow);

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
    const errors = [...results.values()].filter(
      (r) => r.api && !r.api.success,
    ).length;
    scanStatus.textContent = `Scan complete — ${total} unit(s) tested, ${errors} error(s).`;
    scanBtn.disabled = false;
    scanReportBtn.disabled = false;

    updateRegressionSection();
  });

  scanReportBtn.addEventListener("click", downloadReport);

  // ── 2. Single Unit ──────────────────────────────────────────────────────
  const singleBtn = document.getElementById("single-btn") as HTMLButtonElement;
  const singleStatus = document.getElementById("single-status")!;
  const singleResults = document.getElementById("single-results")!;

  singleBtn.addEventListener("click", async () => {
    const unit = (
      document.getElementById("single-unit") as HTMLInputElement
    ).value
      .trim()
      .toUpperCase();
    const sem = parseInt(
      (document.getElementById("single-sem") as HTMLSelectElement).value,
    ) as 1 | 2;
    const year =
      parseInt(
        (document.getElementById("single-year") as HTMLInputElement).value,
        10,
      ) || 2026;

    if (!unit) {
      singleStatus.textContent = "Enter a unit code first.";
      return;
    }

    singleBtn.disabled = true;
    singleStatus.innerHTML = `<span class="spinner"></span> Fetching ${unit}…`;
    singleResults.innerHTML = "";

    const result = await runApiTest(unit, sem, year);
    lastApiUnit = unit;

    singleBtn.disabled = false;

    const api = result.api!;
    if (!api.success) {
      singleStatus.innerHTML = `<span class="status-err">✗ ${escHtml(api.error ?? "Error")}</span>`;
      return;
    }

    singleStatus.innerHTML = `✓ <strong>${api.summary.total}</strong> items — ${api.summary.dated} dated, ${api.summary.tba} TBA`;

    let html = renderDetailTable(api.parsed, api.issues);

    if (result.drift) {
      html += `<div style="margin-top:14px"><strong style="font-size:12px">Drift vs saved deadlines</strong>`;
      html += renderDrift(result.drift);
      html += `</div>`;
    }

    // Parser diagnostics: PC_TEXT structure + AS_TASK ↔ PC_TEXT matching table
    html += `<div style="margin-top:14px"><strong style="font-size:12px">Parser diagnostics</strong>`;
    html += renderDiagnostics(
      diagnosePcText(api.pcText),
      diagnoseMatching(api.parsed, api.asTaskItems),
      api.pcText,
    );
    html += `</div>`;

    html += `<div style="margin-top:12px">`;
    html += renderRawInspector(api.asTask, api.pcText);
    html += `</div>`;

    singleResults.innerHTML = html;
    singleResults
      .querySelectorAll<HTMLElement>(".raw-toggle")
      .forEach(wireRawToggle);

    updateDiffSection();
    updateRegressionSection();
  });

  // ── 3. PDF Test ─────────────────────────────────────────────────────────
  const pdfDrop = document.getElementById("pdf-drop")!;
  const pdfInput = document.getElementById("pdf-input") as HTMLInputElement;
  const pdfStatus = document.getElementById("pdf-status")!;
  const pdfResults = document.getElementById("pdf-results")!;

  pdfDrop.addEventListener("click", () => pdfInput.click());
  pdfDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    pdfDrop.classList.add("drag-over");
  });
  pdfDrop.addEventListener("dragleave", () =>
    pdfDrop.classList.remove("drag-over"),
  );
  pdfDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    pdfDrop.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file?.name.endsWith(".pdf")) handlePdfFile(file);
  });
  pdfInput.addEventListener("change", () => {
    const file = pdfInput.files?.[0];
    if (file) handlePdfFile(file);
  });

  async function handlePdfFile(file: File): Promise<void> {
    const sem = parseInt(
      (document.getElementById("pdf-sem") as HTMLSelectElement).value,
    ) as 1 | 2;
    const year =
      parseInt(
        (document.getElementById("pdf-year") as HTMLInputElement).value,
        10,
      ) || 2026;

    pdfStatus.innerHTML = `<span class="spinner"></span> Parsing ${escHtml(file.name)}…`;
    pdfResults.innerHTML = "";

    const { unit, result } = await runPdfTest(file, sem, year);
    lastPdfUnit = unit;

    const pdf = result.pdf!;
    pdfStatus.innerHTML = `✓ <strong>${pdf.summary.total}</strong> items — ${pdf.summary.dated} dated, ${pdf.summary.tba} TBA`;

    let html = renderDetailTable(pdf.parsed, pdf.issues);

    // Raw text inspector
    html += `<span class="raw-toggle" data-raw-id="pdf-raw" style="margin-top:10px;display:inline-block">▸ Extracted PDF text</span>
      <div class="raw-box hidden" id="pdf-raw">${escHtml(pdf.rawText)}</div>`;

    pdfResults.innerHTML = html;
    pdfResults
      .querySelectorAll<HTMLElement>(".raw-toggle")
      .forEach(wireRawToggle);

    updateDiffSection();
    updateRegressionSection();
  }

  // ── 4. Diff section ─────────────────────────────────────────────────────
  function updateDiffSection(): void {
    const diffStatus = document.getElementById("diff-status")!;
    const diffResults = document.getElementById("diff-results")!;

    const apiResult = lastApiUnit ? results.get(lastApiUnit) : null;
    const pdfResult = lastPdfUnit ? results.get(lastPdfUnit) : null;

    if (!apiResult?.api?.success || !pdfResult?.pdf) {
      diffStatus.textContent =
        "Run an API test (section 2) and a PDF test (section 3) for the same unit to see a diff.";
      diffResults.innerHTML = "";
      return;
    }

    if (lastApiUnit !== lastPdfUnit) {
      diffStatus.innerHTML = `<span class="status-warn">⚠ API tested ${escHtml(lastApiUnit!)} but PDF is ${escHtml(lastPdfUnit!)} — diff may not be meaningful.</span>`;
    } else {
      diffStatus.textContent = `Comparing ${lastApiUnit} API vs PDF results:`;
    }

    diffResults.innerHTML = renderDiff(
      apiResult.api.parsed,
      pdfResult.pdf.parsed,
    );
  }

  // ── 5. Regression section ────────────────────────────────────────────────
  function updateRegressionSection(): void {
    const regResults = document.getElementById("reg-results")!;
    regResults.innerHTML = renderRegressionTable();
  }

  // ── 0. Grab All ─────────────────────────────────────────────────────────
  const grabStartBtn = document.getElementById(
    "grab-start-btn",
  ) as HTMLButtonElement;
  const grabPauseBtn = document.getElementById(
    "grab-pause-btn",
  ) as HTMLButtonElement;
  const grabCancelBtn = document.getElementById(
    "grab-cancel-btn",
  ) as HTMLButtonElement;
  const grabDownloadBtn = document.getElementById(
    "grab-download-btn",
  ) as HTMLButtonElement;
  const grabProgressWrap = document.getElementById("grab-progress-wrap")!;
  const grabProgressBar = document.getElementById(
    "grab-progress-bar",
  ) as HTMLElement;
  const grabProgressStats = document.getElementById("grab-progress-stats")!;
  const grabStatusEl = document.getElementById("grab-status")!;
  const grabLogEl = document.getElementById("grab-log")!;

  /** Prepend one log line for a grab-all result; cap the list at 100 lines. */
  function appendGrabLog(entry: GrabAllEntry): void {
    grabLogEl.classList.add("visible");
    const line = document.createElement("div");
    line.className = `grab-log-line grab-log-${entry.status === "ok" ? "ok" : entry.status === "error" ? "err" : "skip"}`;
    if (entry.status === "ok") {
      // Show warn/error issue counts so problems are visible without opening the full report
      const issueStr =
        entry.errorCount > 0
          ? ` · ${entry.errorCount} err, ${entry.warnCount} warn`
          : entry.warnCount > 0
            ? ` · ${entry.warnCount} warn`
            : "";
      line.textContent = `✓ ${entry.unit} S${entry.semester} ${entry.year} — ${entry.itemCount} items, ${entry.tbaCount} TBA${issueStr}`;
    } else if (entry.status === "error") {
      line.textContent = `✗ ${entry.unit} S${entry.semester} ${entry.year} — ${entry.errorMsg ?? "error"}`;
    } else {
      line.textContent = `· ${entry.unit} S${entry.semester} ${entry.year} — not offered`;
    }
    // Prepend so newest is at the top; trim old lines beyond 100
    grabLogEl.insertBefore(line, grabLogEl.firstChild);
    const lines = grabLogEl.querySelectorAll(".grab-log-line");
    if (lines.length > 100) lines[lines.length - 1].remove();
  }

  grabStartBtn.addEventListener("click", async () => {
    const years = [
      ...document.querySelectorAll<HTMLInputElement>(".grab-year-cb:checked"),
    ].map((el) => parseInt(el.value));
    const sems = [
      ...document.querySelectorAll<HTMLInputElement>(".grab-sem-cb:checked"),
    ].map((el) => parseInt(el.value) as 1 | 2);
    const concurrency =
      parseInt(
        (document.getElementById("grab-concurrency") as HTMLInputElement).value,
        10,
      ) || 10;

    if (years.length === 0 || sems.length === 0) {
      grabStatusEl.textContent = "Select at least one year and one semester.";
      return;
    }

    // Reset state for this run
    grabAllPaused = false;
    grabAllCancelled = false;
    grabAllResults = [];
    grabLogEl.innerHTML = "";
    grabLogEl.classList.remove("visible");
    grabPauseBtn.textContent = "Pause";

    grabStartBtn.disabled = true;
    grabPauseBtn.disabled = false;
    grabCancelBtn.disabled = false;
    grabDownloadBtn.disabled = true;
    grabProgressWrap.classList.remove("hidden");

    grabStatusEl.innerHTML =
      '<span class="spinner"></span> Loading unit list from Curtin API…';
    const startTime = Date.now();

    /** Update the progress bar and stats line after each unit completes. */
    function onProgress(
      processed: number,
      total: number,
      ok: number,
      notOffered: number,
      errors: number,
    ): void {
      const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
      grabProgressBar.style.width = `${pct}%`;
      // Keep aria-valuenow in sync so assistive technology reads the correct percentage
      grabProgressBar.setAttribute("aria-valuenow", String(pct));

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed > 0 ? processed / elapsed : 0;
      const remaining = total - processed;
      const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
      const etaStr =
        etaSec > 60
          ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s`
          : `${etaSec}s`;

      grabProgressStats.innerHTML = `
        <span><strong>${processed.toLocaleString()}</strong> / ${total.toLocaleString()} (${pct}%)</span>
        <span><strong>${ok.toLocaleString()}</strong> offered</span>
        <span><strong>${notOffered.toLocaleString()}</strong> not offered</span>
        <span><strong>${errors.toLocaleString()}</strong> errors</span>
        <span>ETA <strong>${rate > 0 ? etaStr : "—"}</strong></span>
      `;

      // Update status line (show paused state if applicable)
      if (!grabAllPaused) {
        grabStatusEl.innerHTML = `<span class="spinner"></span> ${processed.toLocaleString()} / ${total.toLocaleString()} units…`;
      }
    }

    try {
      await runGrabAll(years, sems, concurrency, onProgress, appendGrabLog);
    } catch (err) {
      grabStatusEl.innerHTML = `<span class="status-err">✗ ${escHtml(err instanceof Error ? err.message : String(err))}</span>`;
    }

    const ok = grabAllResults.filter((e) => e.status === "ok").length;
    const notOffered = grabAllResults.filter(
      (e) => e.status === "not-offered",
    ).length;
    const errors = grabAllResults.filter((e) => e.status === "error").length;

    grabStatusEl.textContent = grabAllCancelled
      ? `Cancelled after ${grabAllResults.length.toLocaleString()} units — ${ok} offered, ${notOffered} not offered, ${errors} errors.`
      : `Complete — ${ok.toLocaleString()} offered, ${notOffered.toLocaleString()} not offered, ${errors} errors.`;

    grabStartBtn.disabled = false;
    grabPauseBtn.disabled = true;
    grabCancelBtn.disabled = true;
    grabDownloadBtn.disabled = grabAllResults.length === 0;
  });

  grabPauseBtn.addEventListener("click", () => {
    grabAllPaused = !grabAllPaused;
    grabPauseBtn.textContent = grabAllPaused ? "Resume" : "Pause";
    if (!grabAllPaused) {
      grabStatusEl.innerHTML = '<span class="spinner"></span> Resuming…';
    } else {
      grabStatusEl.textContent = "Paused.";
    }
  });

  grabCancelBtn.addEventListener("click", () => {
    grabAllCancelled = true;
    grabAllPaused = false; // Unpause so waiting items can observe cancellation and exit
    grabStatusEl.textContent = "Cancelling…";
    grabCancelBtn.disabled = true;
  });

  grabDownloadBtn.addEventListener("click", downloadGrabAllReport);

  // Update header with extension info
  const headerStatus = document.getElementById("header-status")!;
  headerStatus.textContent = `Extension ID: ${chrome.runtime.id}`;
}

// Kick off init once the DOM is ready
document.addEventListener("DOMContentLoaded", init);
