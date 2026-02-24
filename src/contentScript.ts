// ── Blackboard content script for Curtin Deadlines ───────────────────────────
// Runs on Blackboard pages (lms.curtin.edu.au and *.blackboard.com).
// Passively scrapes assignment due dates from the current page once at
// document_idle, then sends them to the side panel via chrome.runtime.sendMessage.
//
// Supports both:
//   - Blackboard Learn Original (classic UI, table-based assignments list)
//   - Blackboard Ultra (modern SPA UI)
//
// NOTE: This is a best-effort scraper. Selectors may need updating if Blackboard
// changes its DOM structure. Scraped items are tagged source='auto' and shown
// with a badge in the side panel. Duplicates are filtered on import.

import { command } from './types';
import type { Deadline } from './types';

// ── Blackboard Original selectors ────────────────────────────────────────────

/**
 * Try to scrape assignments from Blackboard Learn Original (the legacy UI).
 * These appear in "My Grades" and assignment list pages.
 */
function scrapeOriginal(): Partial<Deadline>[] {
  const results: Partial<Deadline>[] = [];

  // Assignment rows in the "My Grades" page (assessmentListId or gradebook table)
  // Typical structure: <tr class="gradable_row"> containing:
  //   <td class="cellName"> with course title
  //   <td class="cellPoints"> or <span class="dueDate">
  const rows = document.querySelectorAll<HTMLElement>(
    'tr.gradable_row, tr[class*="grade_row"], li[id^="listItem_"]',
  );

  rows.forEach((row) => {
    // Extract unit code from the course title element
    const nameCells = row.querySelectorAll<HTMLElement>(
      '.cellName a, .description a, .assessmentTitle',
    );
    const titleEl = nameCells[0];
    if (!titleEl) return;

    const title = titleEl.textContent?.trim();
    if (!title) return;

    // Look for a due date — Blackboard renders these in various elements
    const dueDateEl = row.querySelector<HTMLElement>(
      '.dueDate, [class*="dueDate"], td.cellDue, span[id*="dueDate"]',
    );
    if (!dueDateEl) return;

    const dueDateText = dueDateEl.textContent?.trim();
    if (!dueDateText || dueDateText.toLowerCase().includes('no due date')) return;

    const dueDate = parseBbDate(dueDateText);
    if (!dueDate) return;

    // Try to extract unit code from the page URL or breadcrumb
    const unit = extractUnitFromPage();

    results.push({
      title,
      unit,
      dueDate: dueDate.toISOString(),
      source: 'auto',
    });
  });

  return results;
}

// ── Blackboard Ultra selectors ────────────────────────────────────────────────

/**
 * Try to scrape assignments from Blackboard Ultra (the modern SPA interface).
 * Ultra renders assignments as cards with data attributes.
 */
function scrapeUltra(): Partial<Deadline>[] {
  const results: Partial<Deadline>[] = [];

  // Ultra assignment cards (on the Activity Stream or To Do list)
  const cards = document.querySelectorAll<HTMLElement>(
    '[data-testid="activity-stream-item"], [class*="activityStreamItem"], [class*="todo-item"]',
  );

  cards.forEach((card) => {
    // Title element — typically an anchor or heading inside the card
    const titleEl = card.querySelector<HTMLElement>(
      'h3, h4, [class*="title"], [class*="name"], a[class*="name"]',
    );
    const title = titleEl?.textContent?.trim();
    if (!title) return;

    // Due date — look for time elements or date-labelled spans
    const dateEl = card.querySelector<HTMLElement>(
      'time, [class*="dueDate"], [class*="due-date"], [class*="dueAt"]',
    );
    if (!dateEl) return;

    // Try datetime attribute first (most reliable)
    const datetimeAttr = dateEl.getAttribute('datetime');
    let dueDate: Date | null = null;

    if (datetimeAttr) {
      dueDate = new Date(datetimeAttr);
    } else {
      dueDate = parseBbDate(dateEl.textContent?.trim() ?? '');
    }

    if (!dueDate || isNaN(dueDate.getTime())) return;

    const unit = extractUnitFromCard(card) || extractUnitFromPage();

    results.push({
      title,
      unit,
      dueDate: dueDate.toISOString(),
      source: 'auto',
    });
  });

  return results;
}

// ── Calendar / To Do page scraper ─────────────────────────────────────────────

/**
 * Scrape the Blackboard Calendar page which lists assignments with due dates
 * in a structured way. Works on both Original and Ultra calendar pages.
 */
function scrapeCalendar(): Partial<Deadline>[] {
  const results: Partial<Deadline>[] = [];

  // Calendar items have a consistent structure across Bb versions
  const calItems = document.querySelectorAll<HTMLElement>(
    '[class*="calendarItem"], [class*="calendar-item"], li[class*="event"]',
  );

  calItems.forEach((item) => {
    const titleEl = item.querySelector<HTMLElement>('[class*="title"], [class*="name"], a');
    const title = titleEl?.textContent?.trim();
    if (!title) return;

    // Due date from time element or data attribute
    const timeEl = item.querySelector<HTMLElement>('time');
    const dateAttr = timeEl?.getAttribute('datetime');
    let dueDate: Date | null = null;

    if (dateAttr) {
      dueDate = new Date(dateAttr);
    } else {
      const dateText = item.querySelector('[class*="date"]')?.textContent?.trim() ?? '';
      dueDate = parseBbDate(dateText);
    }

    if (!dueDate || isNaN(dueDate.getTime())) return;

    const unit = extractUnitFromCard(item) || extractUnitFromPage();

    results.push({
      title,
      unit,
      dueDate: dueDate.toISOString(),
      source: 'auto',
    });
  });

  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Attempt to parse a Blackboard date string into a Date object.
 * Blackboard uses various date formats:
 *   "14 April, 2026 11:59 PM"
 *   "Apr 14, 2026 11:59 PM"
 *   "2026-04-14T23:59:00.000Z"
 * Relies on the browser's Date constructor for ISO strings and
 * applies locale-aware heuristics for text dates.
 */
function parseBbDate(text: string): Date | null {
  if (!text) return null;

  // ISO 8601 format — pass directly to Date constructor
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const d = new Date(text);
    return isNaN(d.getTime()) ? null : d;
  }

  // Try the browser's built-in parser (handles many locale formats)
  const d = new Date(text);
  if (!isNaN(d.getTime())) return d;

  // Clean up common Blackboard date noise and retry
  // e.g. "Due: 14 April, 2026 11:59 PM" → "14 April, 2026 11:59 PM"
  const cleaned = text.replace(/^Due:\s*/i, '').replace(/\s+/g, ' ').trim();
  const d2 = new Date(cleaned);
  return isNaN(d2.getTime()) ? null : d2;
}

/**
 * Try to extract a unit code from a card element.
 * Ultra often includes course codes in sub-text like "(COMP1005)"
 */
function extractUnitFromCard(el: HTMLElement): string {
  const text = el.textContent ?? '';
  const match = text.match(/\b([A-Z]{2,4}\d{4})\b/);
  return match?.[1] ?? '';
}

/**
 * Try to extract a unit code from the current page URL or breadcrumb.
 * Blackboard course URLs typically contain the course code.
 */
function extractUnitFromPage(): string {
  // Check URL for course code pattern
  const urlMatch = window.location.pathname.match(/\/courses\/([A-Z]{2,4}\d{4})/i);
  if (urlMatch) return urlMatch[1].toUpperCase();

  // Check breadcrumb navigation
  const breadcrumb = document.querySelector<HTMLElement>(
    '#breadcrumbs, nav[aria-label="breadcrumb"], [class*="breadcrumb"]',
  );
  if (breadcrumb) {
    const codeMatch = breadcrumb.textContent?.match(/\b([A-Z]{2,4}\d{4})\b/);
    if (codeMatch) return codeMatch[1].toUpperCase();
  }

  // Check page title
  const titleMatch = document.title.match(/\b([A-Z]{2,4}\d{4})\b/);
  if (titleMatch) return titleMatch[1].toUpperCase();

  return 'UNKNOWN';
}

/** Deduplicate results by unit + title combination. */
function deduplicateResults(results: Partial<Deadline>[]): Partial<Deadline>[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.unit ?? ''}|${r.title ?? ''}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  // Run all three scrapers and merge the results
  const original = scrapeOriginal();
  const ultra = scrapeUltra();
  const calendar = scrapeCalendar();

  const combined = deduplicateResults([...original, ...ultra, ...calendar]);

  // Only send a message if we actually found something
  if (combined.length === 0) return;

  // Send results to the side panel (or any listening extension page)
  chrome.runtime.sendMessage({
    command: command.scrapeResult,
    deadlines: combined,
  });
}

// Run once after the page has fully loaded
main();
