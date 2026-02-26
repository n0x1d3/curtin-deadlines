// ── JSON backup: export and import deadlines ──────────────────────────────────
// Caller is responsible for re-rendering the UI after importJSON resolves.

import type { Deadline } from "../types";
import { loadDeadlines, saveDeadlines } from "./index";

/**
 * Serialise all deadlines to JSON and trigger a file download.
 * Uses the anchor + Blob trick — no background service worker needed.
 */
export function exportJSON(deadlines: Deadline[]): void {
  const json = JSON.stringify(deadlines, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `curtin-deadlines-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  // Release the object URL after a short delay so the download can start
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/**
 * Import deadlines from a JSON file. Validates structure before saving.
 * Merges with existing deadlines — duplicates (same id) are overwritten.
 * Caller should call renderDeadlines() after this resolves.
 */
export async function importJSON(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result as string);

        // Validate that it's an array of deadline-shaped objects
        if (!Array.isArray(parsed))
          throw new Error("Expected a JSON array of deadlines.");
        for (const item of parsed) {
          if (!item.id || !item.title || !item.unit || !item.dueDate) {
            throw new Error(
              "One or more items are missing required fields (id, title, unit, dueDate).",
            );
          }
        }

        // Merge: load existing, remove any with same id, then push imported
        const existing = await loadDeadlines();
        const importedIds = new Set((parsed as Deadline[]).map((d) => d.id));
        const merged = existing
          .filter((d) => !importedIds.has(d.id))
          .concat(parsed as Deadline[]);
        merged.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

        await saveDeadlines(merged);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsText(file);
  });
}
