// ── Chrome storage helpers ────────────────────────────────────────────────────
// All chrome.storage.local interactions are consolidated here.
// No rendering or DOM access — callers are responsible for re-rendering.

import type { Deadline, AppSettings } from '../types';

// ── Deadline storage ──────────────────────────────────────────────────────────

/**
 * Load all deadlines from chrome.storage.local.
 *
 * On first run after the migration from sync → local, any deadlines previously
 * stored in chrome.storage.sync are moved to local and removed from sync.
 * chrome.storage.local has a 5 MB limit (vs sync's 8 KB per-key cap),
 * which is far more suitable for storing arrays of deadline objects.
 */
export async function loadDeadlines(): Promise<Deadline[]> {
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
export async function saveDeadlines(deadlines: Deadline[]): Promise<void> {
  await chrome.storage.local.set({ deadlines });
}

/** Add a single deadline, keeping the list sorted by dueDate ascending. */
export async function addDeadline(deadline: Deadline): Promise<void> {
  const deadlines = await loadDeadlines();
  deadlines.push(deadline);
  deadlines.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  await saveDeadlines(deadlines);
}

/** Remove a deadline by id. */
export async function deleteDeadline(id: string): Promise<void> {
  const deadlines = await loadDeadlines();
  await saveDeadlines(deadlines.filter((d) => d.id !== id));
}

/**
 * Update the due date of an existing deadline and clear its dateTBA flag.
 * Re-sorts the list after updating so the card moves to its correct position.
 */
export async function setDeadlineDate(id: string, dueDate: string): Promise<void> {
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
export async function loadSkipSubmitConfirm(): Promise<boolean> {
  const result = await chrome.storage.local.get('skipSubmitConfirm');
  return result.skipSubmitConfirm === true;
}

/** Persist the user's choice to skip the submit confirmation in future. */
export async function saveSkipSubmitConfirm(skip: boolean): Promise<void> {
  await chrome.storage.local.set({ skipSubmitConfirm: skip });
}

// ── App settings ──────────────────────────────────────────────────────────────

/** Load app settings from chrome.storage.local (returns defaults if not set). */
export async function loadSettings(): Promise<AppSettings> {
  const result = await chrome.storage.local.get('appSettings');
  const saved = result.appSettings ?? {};
  return {
    defaultSemester: (saved.defaultSemester as 1 | 2) ?? 1,
    overduePosition: (saved.overduePosition as 'top' | 'bottom') ?? 'bottom',
  };
}

/** Persist app settings to chrome.storage.local. */
export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const current = await loadSettings();
  await chrome.storage.local.set({ appSettings: { ...current, ...settings } });
}
