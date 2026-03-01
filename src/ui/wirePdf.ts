// ── PDF drop zone wiring ─────────────────────────────────────────────────────
// Handles: drag-and-drop / click-to-browse for PDF files, multi-file parsing,
// and handing parsed assessments off to the confirmation checklist.

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
}

// ── Main wiring function ─────────────────────────────────────────────────────

/**
 * Wire up the PDF drop zone: drag-and-drop events, click-to-browse,
 * and multi-file PDF parsing with progress feedback.
 * Called once from init().
 */
export function wirePDFDropZone(deps: PdfDeps): void {
  const { showConfirmation } = deps;

  const dropZone = document.getElementById("drop-zone")!;
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const parseProgress = document.getElementById("parse-progress")!;
  const parseStatus = document.getElementById("parse-status")!;

  /**
   * Parse up to 4 PDF files in sequence and show a combined confirmation.
   * Files that fail to parse (bad PDF, scanned image, etc.) are skipped with a
   * note to the user — valid files still proceed to the confirmation screen.
   */
  async function processFiles(rawFiles: File[]): Promise<void> {
    // Filter to PDFs only
    const pdfs = rawFiles.filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (pdfs.length === 0) {
      // If only .ics files were dropped, the ICS handler (wireIcsSection) deals
      // with them separately — don't alert the user with a confusing message.
      const hasOnlyIcs = rawFiles.every((f) =>
        f.name.toLowerCase().endsWith(".ics"),
      );
      if (!hasOnlyIcs) showToast("Please select PDF files.", "error");
      return;
    }
    // Enforce the 4-file limit
    if (pdfs.length > 4) {
      showToast("Please upload at most 4 PDFs at a time.", "error");
      return;
    }

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

  // ── Drag-and-drop events ─────────────────────────────────────────────────
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
    if (files.length) processFiles(files);
  });

  // ── Click to browse ──────────────────────────────────────────────────────
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    if (files.length) {
      processFiles(files);
      fileInput.value = ""; // reset so the same files can be re-selected
    }
  });
}
