// ── Date and time formatting utilities ────────────────────────────────────────
// Pure formatting functions — no Chrome API dependencies, no DOM access.

/** Format a Date as "Mon 16 Mar 2026". */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Format the time component of an ISO date string as "HH:MM".
 * Returns null when the time is midnight (00:00) — treated as an all-day entry.
 */
export function formatTime(isoDate: string): string | null {
  const d = new Date(isoDate);
  const h = d.getHours();
  const m = d.getMinutes();
  // Midnight means no specific time was set — don't show it
  if (h === 0 && m === 0) return null;
  return d.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Compute a human-readable countdown string and urgency CSS class for a deadline.
 * @param isoDate  ISO 8601 due date string
 * @returns        { label: "in 3 days", urgencyClass: "soon" }
 */
export function getCountdown(isoDate: string): {
  label: string;
  urgencyClass: string;
} {
  const now = new Date();
  const due = new Date(isoDate);
  const diffMs = due.getTime() - now.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMs < 0) {
    return { label: "overdue", urgencyClass: "overdue" };
  } else if (diffMins < 60) {
    return {
      label: `in ${diffMins} min${diffMins !== 1 ? "s" : ""}`,
      urgencyClass: "urgent",
    };
  } else if (diffHours < 48) {
    return {
      label: `in ${diffHours} hour${diffHours !== 1 ? "s" : ""}`,
      urgencyClass: "urgent",
    };
  } else if (diffDays < 7) {
    return {
      label: `in ${diffDays} day${diffDays !== 1 ? "s" : ""}`,
      urgencyClass: "soon",
    };
  } else {
    return { label: `in ${diffDays} days`, urgencyClass: "ok" };
  }
}

/** Returns the current full year as a number. */
export function defaultYear(): number {
  return new Date().getFullYear();
}

/** Escape HTML special characters to prevent XSS when injecting text content. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Truncate a string to at most `max` characters, appending "…" if cut. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
