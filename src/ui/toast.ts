// ── Toast notification system ─────────────────────────────────────────────────
// Provides non-blocking user feedback to replace alert() calls.
// Toasts are stacked in a fixed container (bottom-right), auto-dismiss after a
// type-dependent duration, and support multi-line messages without innerHTML.

export type ToastType = "error" | "success" | "info";

// Auto-dismiss durations in milliseconds
const DURATIONS: Record<ToastType, number> = {
  error: 5000,
  success: 3000,
  info: 3000,
};

// Maximum number of toasts visible at once; oldest is evicted when exceeded
const MAX_TOASTS = 3;

// CSS transition duration (must match .toast--exit animation duration in CSS)
const EXIT_TRANSITION_MS = 400;

// Lazily-created container — reuses an existing element if the HTML already has one
function getContainer(): HTMLElement {
  const existing = document.getElementById("toast-container");
  if (existing) return existing;

  const container = document.createElement("div");
  container.id = "toast-container";

  // Attach to .app so the container sits inside the extension's root element
  const app = document.querySelector(".app") ?? document.body;
  app.appendChild(container);
  return container;
}

// Removes a toast by playing its exit animation, then detaching from the DOM
function dismissToast(toast: HTMLElement): void {
  toast.classList.add("toast--exit");

  // Remove on transitionend; fall back to a hard timeout in case the event
  // never fires (e.g. element was removed by another code path first)
  const fallback = setTimeout(() => toast.remove(), EXIT_TRANSITION_MS);

  toast.addEventListener(
    "transitionend",
    () => {
      clearTimeout(fallback);
      toast.remove();
    },
    { once: true },
  );
}

// Creates and displays a toast with the given message and type.
// Supports multi-line messages: newlines become <br> elements (no innerHTML — XSS safe).
export function showToast(message: string, type: ToastType): void {
  const container = getContainer();

  // Evict the oldest toast if we've hit the stack limit
  const existing = container.querySelectorAll<HTMLElement>(".toast");
  if (existing.length >= MAX_TOASTS) {
    dismissToast(existing[0]);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");

  // Build message content — split on \n, insert text nodes + <br> elements
  // so we never use innerHTML (prevents XSS from error messages)
  const lines = message.split("\n");
  lines.forEach((line, i) => {
    toast.appendChild(document.createTextNode(line));
    if (i < lines.length - 1) {
      toast.appendChild(document.createElement("br"));
    }
  });

  // Close button — lets users dismiss before the timeout
  const closeBtn = document.createElement("button");
  closeBtn.className = "toast__close";
  closeBtn.setAttribute("aria-label", "Dismiss notification");
  closeBtn.appendChild(document.createTextNode("✕"));
  closeBtn.addEventListener("click", () => dismissToast(toast));
  toast.appendChild(closeBtn);

  container.appendChild(toast);

  // Auto-dismiss after the type-specific duration
  setTimeout(() => {
    // Guard: toast may have already been dismissed via the close button
    if (toast.isConnected) dismissToast(toast);
  }, DURATIONS[type]);
}
