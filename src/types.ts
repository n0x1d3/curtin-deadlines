// ── Shared types for the Curtin Deadlines extension ───────────────────────────

/**
 * A single deadline stored in chrome.storage.sync.
 * dueDate is always a fully resolved ISO 8601 string (sortable, comparable).
 */
export interface Deadline {
  /** Unique identifier — crypto.randomUUID() */
  id: string;
  /** Task name, e.g. "Assignment 1 — Report" */
  title: string;
  /** Unit code, e.g. "COMP1005" */
  unit: string;
  /** Full unit name parsed from the PDF header, e.g. "Introduction to Computing" */
  unitName?: string;
  /** Resolved due date in ISO 8601 format (for sorting and countdown) */
  dueDate: string;
  /** Human-readable week label, e.g. "Week 5" or "Weeks 5–7"; absent for exact-date entries */
  weekLabel?: string;
  /** Assessment weight as a percentage (0–100), parsed from the "%" column in the schedule */
  weight?: number;
  /** 'manual' = entered by user; 'auto' = scraped from Blackboard */
  source: 'manual' | 'auto';
  /** ISO 8601 timestamp for when this deadline was added */
  addedAt: string;
  /**
   * True when no date could be resolved at save time (e.g. exam timetable not yet released).
   * dueDate is set to a far-future placeholder (year 9999) so the card sorts to the bottom.
   * The card renders a "Set date" button so the user can fill it in later.
   */
  dateTBA?: boolean;
}

/**
 * A deadline extracted from a PDF but not yet confirmed by the user.
 * Shown in the confirmation checklist before being saved.
 */
export interface PendingDeadline {
  /** Editable task name extracted from PDF */
  title: string;
  /** Editable unit code extracted from filename or PDF text */
  unit: string;
  /** Full unit name parsed from the PDF header, e.g. "Introduction to Computing" */
  unitName?: string;
  /** Week label extracted from PDF, e.g. "Week 5" */
  weekLabel?: string;
  /** Week number resolved from weekLabel (last week in range) */
  week?: number;
  /** Semester inferred from week label + PDF context */
  semester?: 1 | 2;
  /** Year used for date resolution */
  year?: number;
  /** Exact date string parsed from "Day:" field, e.g. "3rd May" */
  exactDay?: string;
  /** Time string parsed from "Time:" field, e.g. "23:59" */
  exactTime?: string;
  /** Pre-resolved Date object; undefined when date cannot be determined */
  resolvedDate?: Date;
  /** True when the deadline is TBA or Examination Period (should be unchecked by default) */
  isTBA: boolean;
  /** True when this item was sourced from the Program Calendar section (not the assessment schedule) */
  calSource?: boolean;
  /** Assessment weight as a percentage (0–100), parsed from the "%" column in the schedule */
  weight?: number;
}

/**
 * Message command types for communication between side panel and background.
 */
export const enum command {
  /** Background service worker triggers a .ics file download */
  downloadICS = 'downloadICS',
  /** Content script reports Blackboard deadlines to the side panel */
  scrapeResult = 'scrapeResult',
}
