// ── PDF drop zone wiring ─────────────────────────────────────────────────────
// Handles: drag-and-drop / click-to-browse for PDF files, file staging queue,
// multi-file parsing, and handing parsed assessments off to the confirmation
// checklist.
//
// Dropped/browsed PDFs are staged (shown as a count badge inside the drop zone)
// until the user clicks "Scan" below it.
// .ics files are NOT staged here — the capture-phase listener in wireIcs.ts
// consumes them before this handler fires.

import type { PendingDeadline } from "../types";
import {
  extractPDFText,
  parseUnitName,
  parseAssessments,
  parseProgramCalendar,
  mergeWithCalendar,
  addSequenceNumbers,
} from "../pdf";
import { defaultYear } from "../utils/format";
import { showToast } from "./toast";

// ── Deps interface ───────────────────────────────────────────────────────────
// Callbacks that live in sidePanel.ts — passed in so this module stays decoupled.

export interface PdfDeps {
  showConfirmation: (
    groups: { filename: string; items: PendingDeadline[] }[],
  ) => void;
  handleIcsFile: (file: File) => Promise<void>;
}

// ── Main wiring function ─────────────────────────────────────────────────────

/**
 * Wire up the PDF drop zone: drag-and-drop events, click-to-browse,
 * file staging queue, and multi-file PDF parsing with progress feedback.
 * Called once from init().
 */
export function wirePDFDropZone(deps: PdfDeps): void {
  const { showConfirmation, handleIcsFile } = deps;

  const dropZone = document.getElementById("drop-zone")!;
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const parseProgress = document.getElementById("parse-progress")!;
  const parseStatus = document.getElementById("parse-status")!;

  // ── Queue element refs ────────────────────────────────────────────────────
  const queueBadge = document.getElementById("queue-badge")!;
  const fileQueueCount = document.getElementById("file-queue-count")!;
  const fileQueueScan = document.getElementById(
    "file-queue-scan",
  ) as HTMLButtonElement;

  // Holds files waiting to be scanned — persists across multiple drop/browse actions.
  const stagedFiles: File[] = [];

  // ── Queue rendering ───────────────────────────────────────────────────────

  /**
   * Update the badge inside the drop zone and show/hide the scan button.
   * Both are hidden when the queue is empty.
   */
  function renderQueue(): void {
    const n = stagedFiles.length;
    if (n === 0) {
      queueBadge.classList.add("hidden");
      fileQueueScan.classList.add("hidden");
      return;
    }
    queueBadge.textContent = stagedFiles.map((f) => f.name).join(", ");
    queueBadge.classList.remove("hidden");
    fileQueueCount.textContent = `${n} file${n !== 1 ? "s" : ""}`;
    fileQueueScan.classList.remove("hidden");
  }

  /**
   * Add PDF or .ics files to the staging queue — deduplicated by name.
   * Caps: 10 total, 8 PDFs, 2 .ics files.
   * Other file types are silently ignored.
   */
  function stageFiles(incoming: File[]): void {
    const accepted = incoming.filter((f) => {
      const name = f.name.toLowerCase();
      return name.endsWith(".pdf") || name.endsWith(".ics");
    });
    for (const f of accepted) {
      if (stagedFiles.some((s) => s.name === f.name)) continue; // dedup by name
      const isPdf = f.name.toLowerCase().endsWith(".pdf");
      const isIcs = f.name.toLowerCase().endsWith(".ics");
      const pdfCount = stagedFiles.filter((s) =>
        s.name.toLowerCase().endsWith(".pdf"),
      ).length;
      const icsCount = stagedFiles.filter((s) =>
        s.name.toLowerCase().endsWith(".ics"),
      ).length;
      if (stagedFiles.length >= 10) {
        showToast("Maximum 10 files can be staged at once.", "error");
        break;
      }
      if (isPdf && pdfCount >= 8) {
        showToast("Maximum 8 PDFs can be staged at once.", "error");
        break;
      }
      if (isIcs && icsCount >= 2) {
        showToast("Maximum 2 .ics files can be staged at once.", "error");
        break;
      }
      stagedFiles.push(f);
    }
    renderQueue();
  }

  // ── PDF parsing ───────────────────────────────────────────────────────────

  /**
   * Parse up to 4 PDF files in sequence and show a combined confirmation.
   * Files that fail to parse (bad PDF, scanned image, etc.) are skipped with a
   * note to the user — valid files still proceed to the confirmation screen.
   */
  async function processFiles(rawFiles: File[]): Promise<void> {
    const pdfs = rawFiles.filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    // Belt-and-suspenders: stageFiles() already enforces the cap
    if (pdfs.length > 8) {
      showToast("Please upload at most 8 PDFs at a time.", "error");
      return;
    }
    if (pdfs.length === 0) return;

    parseProgress.classList.remove("hidden");

    const groups: { filename: string; items: PendingDeadline[] }[] = [];
    const failed: string[] = [];

    for (let i = 0; i < pdfs.length; i++) {
      const file = pdfs[i];
      // Show which file is currently being processed
      parseStatus.textContent =
        pdfs.length > 1
          ? `Parsing ${i + 1} of ${pdfs.length}: ${file.name}…`
          : "Extracting text…";

      try {
        const text = await extractPDFText(file);

        // Guard against scanned/image-only PDFs
        if (text.replace(/\s+/g, "").length < 50) {
          failed.push(`${file.name} (no text layer — may be a scanned image)`);
          continue;
        }

        // Extract unit code, semester, and year from filename
        const unitCode = file.name.match(/([A-Z]{2,4}\d{4})/)?.[1] ?? "";
        const semFromFilename = file.name.match(/[Ss]emester\s*([12])/)?.[1];
        const yearFromFilename = file.name.match(/\b(20\d{2})\b/)?.[1];
        const fileSemester = semFromFilename
          ? (parseInt(semFromFilename, 10) as 1 | 2)
          : 1;
        const fileYear = yearFromFilename
          ? parseInt(yearFromFilename, 10)
          : defaultYear();

        // Parse assessment schedule + program calendar, then merge and number
        const scheduleItems = parseAssessments(
          text,
          unitCode,
          fileYear,
          fileSemester,
        );
        const calendarItems = parseProgramCalendar(
          text,
          unitCode,
          fileYear,
          fileSemester,
        );
        const items = addSequenceNumbers(
          mergeWithCalendar(scheduleItems, calendarItems),
        );

        // Attach unit name (parsed from PDF header) to every item from this file
        const unitName = parseUnitName(text, unitCode);
        if (unitName) {
          items.forEach((item) => {
            item.unitName = unitName;
          });
        }

        groups.push({ filename: file.name, items });
      } catch (err) {
        console.error(`Failed to parse ${file.name}:`, err);
        failed.push(file.name);
      }
    }

    parseProgress.classList.add("hidden");

    // If everything failed and nothing succeeded, bail out
    if (groups.length === 0) {
      showToast(
        `Could not extract deadlines from ${failed.length === 1 ? "this PDF" : "any of the PDFs"}:\n` +
          failed.join("\n") +
          "\n\nPlease add deadlines manually using the form.",
        "error",
      );
      return;
    }

    // Show confirmation for whatever succeeded
    showConfirmation(groups);

    // If some files failed alongside successes, notify after a short delay so
    // the confirmation screen is already visible when the alert appears.
    if (failed.length > 0) {
      setTimeout(() => {
        showToast(
          `Note: ${failed.length} file${failed.length > 1 ? "s" : ""} could not be parsed:\n` +
            failed.join("\n"),
          "info",
        );
      }, 150);
    }
  }

  // ── Queue button handlers ─────────────────────────────────────────────────

  fileQueueScan.addEventListener("click", async () => {
    if (stagedFiles.length === 0) return;
    // Drain the queue atomically before processing begins
    const toProcess = stagedFiles.splice(0);
    renderQueue();
    // Route by type: .ics → ICS handler (sequential), .pdf → PDF parser (batch)
    const icsFiles = toProcess.filter((f) =>
      f.name.toLowerCase().endsWith(".ics"),
    );
    const pdfFiles = toProcess.filter((f) =>
      f.name.toLowerCase().endsWith(".pdf"),
    );
    try {
      for (const f of icsFiles) await handleIcsFile(f);
      if (pdfFiles.length > 0) await processFiles(pdfFiles);
    } catch (err) {
      console.error("Scan failed:", err);
      showToast(
        `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  });

  // ── Drag-and-drop events ──────────────────────────────────────────────────
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const files = [...(e.dataTransfer?.files ?? [])];
    // .ics files are consumed by the capture-phase listener in wireIcs.ts;
    // only PDF (and any other) files reach this handler.
    if (files.length) stageFiles(files);
  });

  // ── Click to browse ───────────────────────────────────────────────────────
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    if (files.length) {
      stageFiles(files);
      fileInput.value = ""; // reset so the same files can be re-selected
    }
  });
}
