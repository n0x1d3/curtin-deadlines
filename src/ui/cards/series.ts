import type { Deadline } from "../../types";
import { deleteDeadline } from "../../storage";
import { escapeHtml, formatDate, getCountdown } from "../../utils/format";
import type { CardDeps } from "./deps";

/**
 * Build the series footer and expanded list for a group of related deadlines.
 * Returns both elements — caller appends footer to the card and expandedEl after it.
 */
export function buildSeriesFooter(
  group: Deadline[],
  focus: Deadline,
  upcoming: Deadline[],
  sKey: string,
  deps: CardDeps,
): { footer: HTMLDivElement; expandedEl: HTMLDivElement } {
  const focusIdx = group.indexOf(focus) + 1;
  // "ahead" = items that are upcoming and not TBA (excludes the focus itself)
  const aheadCount = upcoming.length > 0 ? upcoming.length - 1 : 0;

  // Footer bar — shows position in series; click to expand/collapse
  const footer = document.createElement("div");
  footer.className = "series-footer";
  footer.setAttribute("role", "button");
  footer.setAttribute("tabindex", "0");

  // Expanded panel — rendered once, toggled visible by the footer
  const expandedEl = document.createElement("div");
  expandedEl.className = "series-expanded";
  if (!deps.expandedSeries.has(sKey)) expandedEl.classList.add("hidden");

  // Update footer label to match the current open/closed state
  const setFooterText = (open: boolean): void => {
    if (open) {
      footer.innerHTML = `<span class="series-caret">▲</span> All ${group.length} in series`;
    } else {
      const aheadText =
        aheadCount > 0
          ? ` · <span class="series-ahead">${aheadCount} more ahead</span>`
          : "";
      footer.innerHTML = `<span class="series-caret">▶</span> ${focusIdx} of ${group.length}${aheadText}`;
    }
  };

  setFooterText(deps.expandedSeries.has(sKey));

  // Build a compact row for each item in the group (all, including focus)
  for (const item of group) {
    const isOverdue = !item.dateTBA && new Date(item.dueDate) <= deps.now;
    const isFocus = item.id === focus.id;

    const row = document.createElement("div");
    row.className = [
      "series-item",
      isFocus ? "series-focus" : "",
      isOverdue ? "series-overdue" : "",
      item.dateTBA ? "series-tba" : "",
    ]
      .filter(Boolean)
      .join(" ");

    // Date and countdown labels for the compact row
    const dateLabel = item.dateTBA ? "TBA" : formatDate(new Date(item.dueDate));
    const ctdLabel = item.dateTBA ? "" : getCountdown(item.dueDate).label;

    row.innerHTML = `
          <span class="series-item-title">${escapeHtml(item.title)}</span>
          <span class="series-item-date">${escapeHtml(dateLabel)}</span>
          ${ctdLabel ? `<span class="series-item-ctd">${escapeHtml(ctdLabel)}</span>` : ""}
          <button class="series-item-del" aria-label="Delete ${escapeHtml(item.title)}">×</button>
        `;

    // Delete individual series item; keep series expanded after deletion
    row
      .querySelector(".series-item-del")!
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        deps.expandedSeries.add(sKey);
        await deleteDeadline(item.id);
        await deps.onRerender();
      });

    expandedEl.appendChild(row);
  }

  // Toggle open/close on click or keyboard Enter/Space
  const toggleExpand = (): void => {
    const open = deps.expandedSeries.has(sKey);
    if (open) {
      deps.expandedSeries.delete(sKey);
      expandedEl.classList.add("hidden");
    } else {
      deps.expandedSeries.add(sKey);
      expandedEl.classList.remove("hidden");
    }
    setFooterText(!open);
  };

  footer.addEventListener("click", toggleExpand);
  footer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleExpand();
    }
  });

  return { footer, expandedEl };
}
