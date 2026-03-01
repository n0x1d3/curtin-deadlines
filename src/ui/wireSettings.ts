// ── Settings panel wiring ────────────────────────────────────────────────────
// Handles: dark mode toggle/persistence, default semester, overdue position,
// clear-all, JSON import/export, reset prompt, and test panel link.

import {
  loadDeadlines,
  saveDeadlines,
  loadSettings,
  saveSettings,
  saveSkipSubmitConfirm,
} from "../storage";
import { exportJSON, importJSON } from "../storage/backup";
import { showToast } from "./toast";

// ── Deps interface ───────────────────────────────────────────────────────────
// Callbacks that live in sidePanel.ts — passed in so this module stays decoupled.

export interface SettingsDeps {
  renderDeadlines: () => Promise<void>;
  overduePositionRef: { value: "top" | "bottom" };
}

// ── Dark mode ────────────────────────────────────────────────────────────────

/** Toggle dark mode and persist the preference. */
async function toggleDarkMode(): Promise<void> {
  const isDark = document.body.classList.toggle("dark");
  await chrome.storage.local.set({ darkMode: isDark });
  // Update the toggle button emoji
  const btn = document.getElementById("theme-toggle")!;
  btn.textContent = isDark ? "☀️" : "🌙";
}

/** Load the saved dark mode preference and apply it on startup. */
export async function applyDarkMode(): Promise<void> {
  const result = await chrome.storage.local.get("darkMode");
  const isDark = result.darkMode === true;
  if (isDark) {
    document.body.classList.add("dark");
    document.getElementById("theme-toggle")!.textContent = "☀️";
  }
}

// ── Default semester ─────────────────────────────────────────────────────────

/**
 * Apply the stored default semester to all semester selects:
 * the API section, the manual form, and any TBA card fill-in selects.
 * @param sem  1 or 2
 */
export function applyDefaultSemester(sem: 1 | 2): void {
  // API section semester
  const apiSem = document.getElementById(
    "api-semester",
  ) as HTMLSelectElement | null;
  if (apiSem) apiSem.value = String(sem);

  // Manual form semester
  const fSem = document.getElementById(
    "f-semester",
  ) as HTMLSelectElement | null;
  if (fSem) fSem.value = String(sem);

  // TBA card fill-in selects (class .card-sem-sel rendered inside deadline cards)
  document
    .querySelectorAll<HTMLSelectElement>(".card-sem-sel")
    .forEach((sel) => {
      sel.value = String(sem);
    });

  // Confirmation section TBA fill-in selects (.conf-sem-sel)
  document
    .querySelectorAll<HTMLSelectElement>(".conf-sem-sel")
    .forEach((sel) => {
      sel.value = String(sem);
    });
}

// ── Settings panel open/close ────────────────────────────────────────────────

/** Show settings section, hide main section. */
function openSettings(): void {
  document.getElementById("main-section")!.classList.add("hidden");
  document.getElementById("settings-section")!.classList.remove("hidden");
}

/** Hide settings section, show main section. */
function closeSettings(): void {
  document.getElementById("settings-section")!.classList.add("hidden");
  document.getElementById("main-section")!.classList.remove("hidden");
}

// ── Main wiring function ─────────────────────────────────────────────────────

/**
 * Wire up all interactive elements inside #settings-section.
 * Called once from init().
 */
export async function wireSettingsSection(deps: SettingsDeps): Promise<void> {
  const { renderDeadlines, overduePositionRef } = deps;

  // Load current settings to pre-fill controls
  const settings = await loadSettings();

  // Pre-fill the default-semester select
  const setSemesterSel = document.getElementById(
    "set-semester",
  ) as HTMLSelectElement;
  setSemesterSel.value = String(settings.defaultSemester);

  // Pre-select the overdue position radio
  const radios = document.querySelectorAll<HTMLInputElement>(
    'input[name="overdue-pos"]',
  );
  radios.forEach((r) => {
    r.checked = r.value === settings.overduePosition;
  });

  // ── Back button ──────────────────────────────────────────────────────────
  document
    .getElementById("settings-back")!
    .addEventListener("click", closeSettings);

  // ── Gear button in header ────────────────────────────────────────────────
  document
    .getElementById("settings-btn")!
    .addEventListener("click", openSettings);

  // ── Default semester change ───────────────────────────────────────────────
  setSemesterSel.addEventListener("change", async () => {
    const sem = parseInt(setSemesterSel.value, 10) as 1 | 2;
    await saveSettings({ defaultSemester: sem });
    applyDefaultSemester(sem);
  });

  // ── Overdue position change ───────────────────────────────────────────────
  radios.forEach((r) => {
    r.addEventListener("change", async () => {
      if (!r.checked) return;
      const pos = r.value as "top" | "bottom";
      overduePositionRef.value = pos; // update mutable ref so renderDeadlines picks it up
      await saveSettings({ overduePosition: pos });
      await renderDeadlines();
    });
  });

  // ── Export JSON ───────────────────────────────────────────────────────────
  document
    .getElementById("set-export-json")!
    .addEventListener("click", async () => {
      const deadlines = await loadDeadlines();
      exportJSON(deadlines);
    });

  // ── Import JSON ───────────────────────────────────────────────────────────
  const importJsonBtn = document.getElementById("set-import-json-btn")!;
  const importJsonFile = document.getElementById(
    "set-import-json-file",
  ) as HTMLInputElement;

  // Button click → trigger hidden file input
  importJsonBtn.addEventListener("click", () => importJsonFile.click());

  importJsonFile.addEventListener("change", async () => {
    const file = importJsonFile.files?.[0];
    if (!file) return;
    importJsonFile.value = ""; // reset so the same file can be re-imported
    try {
      // importJSON (storage/backup.ts) merges and saves but does not re-render
      await importJSON(file);
      await renderDeadlines();
      closeSettings();
    } catch (err) {
      showToast(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  });

  // ── Clear all deadlines ───────────────────────────────────────────────────
  const clearAllBtn = document.getElementById("set-clear-all")!;
  const clearConfirm = document.getElementById("set-clear-confirm")!;

  // First click: show the inline "Delete all?" confirm row
  clearAllBtn.addEventListener("click", () => {
    clearAllBtn.classList.add("hidden");
    clearConfirm.classList.remove("hidden");
  });

  // Yes — delete and return to main
  document
    .getElementById("set-clear-yes")!
    .addEventListener("click", async () => {
      // Inline clearAllDeadlines: wipe storage then re-render
      await saveDeadlines([]);
      await renderDeadlines();
      // Reset confirm UI state
      clearConfirm.classList.add("hidden");
      clearAllBtn.classList.remove("hidden");
      closeSettings();
    });

  // No — cancel without deleting
  document.getElementById("set-clear-no")!.addEventListener("click", () => {
    clearConfirm.classList.add("hidden");
    clearAllBtn.classList.remove("hidden");
  });

  // ── Reset "Did you submit?" prompt ───────────────────────────────────────
  const resetPromptBtn = document.getElementById("set-reset-prompt")!;
  const resetMsg = document.getElementById("set-reset-msg")!;

  resetPromptBtn.addEventListener("click", async () => {
    await saveSkipSubmitConfirm(false);
    // Show a brief confirmation message that auto-hides after 3 s
    resetMsg.classList.remove("hidden");
    setTimeout(() => resetMsg.classList.add("hidden"), 3000);
  });

  // Open the developer test panel in a new tab
  document
    .getElementById("set-open-test-panel")!
    .addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("testPage.html") });
    });

  // ── Header dark mode toggle ───────────────────────────────────────────────
  document
    .getElementById("theme-toggle")!
    .addEventListener("click", toggleDarkMode);
}
