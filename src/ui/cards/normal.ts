import type { Deadline } from "../../types";
import {
  escapeHtml,
  truncate,
  formatDate,
  formatTime,
  getCountdown,
} from "../../utils/format";
import type { CardDeps } from "./deps";
import { submitConfirmHTML, wireSubmitConfirm } from "./confirm";

/**
 * Build a normal card — date known, shows countdown timer.
 * Returns a fully-wired card element ready to append to the DOM.
 */
export function buildNormalCard(
  focus: Deadline,
  sourceBadge: string,
  isSeries: boolean,
  sKey: string,
  deps: CardDeps,
): HTMLDivElement {
  const card = document.createElement("div");
  card.dataset.id = focus.id;

  const { label, urgencyClass } = getCountdown(focus.dueDate);
  const displayDate = formatDate(new Date(focus.dueDate));
  const displayTime = formatTime(focus.dueDate);

  // Build the date line: "Week 5 · Mon 16 Mar 2026 · 23:59 · 20%" (or subset)
  const dateParts: string[] = [];
  if (focus.weekLabel) dateParts.push(focus.weekLabel);
  dateParts.push(displayDate);
  if (displayTime) dateParts.push(displayTime);
  // Append weight to the date line if known
  if (focus.weight)
    dateParts.push(`<span class="card-weight">${focus.weight}%</span>`);
  const dateLineHTML = dateParts
    .map((p, i) => (i > 0 ? `<span class="card-dot">·</span> ${p}` : p))
    .join(" ");

  // Unit name sub-label (shown after the unit code in the card header)
  const unitNameHTML = focus.unitName
    ? `<span class="card-dot" style="opacity:0.3">·</span><span class="card-unit-name">${escapeHtml(truncate(focus.unitName, 32))}</span>`
    : "";

  // Meta row: outcomes + late/extension policy (only when data available)
  const metaHTML =
    focus.outcomes ||
    focus.lateAccepted !== undefined ||
    focus.extensionConsidered !== undefined
      ? `<div class="card-meta">
          ${focus.outcomes ? `<span class="card-meta-item">LO&nbsp;${escapeHtml(focus.outcomes)}</span>` : ""}
          ${focus.lateAccepted !== undefined ? `<span class="card-meta-item${focus.lateAccepted ? "" : " meta-no"}" title="Late submissions accepted: ${focus.lateAccepted ? "Yes" : "No"}">Late:&nbsp;${focus.lateAccepted ? "Yes" : "No"}</span>` : ""}
          ${focus.extensionConsidered !== undefined ? `<span class="card-meta-item${focus.extensionConsidered ? "" : " meta-no"}" title="Extension considered: ${focus.extensionConsidered ? "Yes" : "No"}">Ext:&nbsp;${focus.extensionConsidered ? "Yes" : "No"}</span>` : ""}
        </div>`
      : "";

  card.className = `deadline-card ${urgencyClass}`;
  card.innerHTML = `
        <div class="card-top">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="card-unit">${escapeHtml(focus.unit)}</span>
            ${unitNameHTML}
            ${sourceBadge}
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="card-countdown">${label}</span>
            <button class="card-complete" title="Mark as submitted" aria-label="Mark ${escapeHtml(focus.title)} as submitted">✓</button>
            <button class="card-delete" title="Delete deadline" aria-label="Delete ${escapeHtml(focus.title)}">×</button>
          </div>
        </div>
        <div class="card-title">${escapeHtml(focus.title)}</div>
        ${metaHTML}
        <div class="card-date">${dateLineHTML}</div>
        ${submitConfirmHTML()}
      `;

  wireSubmitConfirm(card, focus, isSeries, sKey, deps);
  return card;
}
