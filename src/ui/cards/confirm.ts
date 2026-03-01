import type { Deadline } from "../../types";
import {
  deleteDeadline,
  loadSkipSubmitConfirm,
  saveSkipSubmitConfirm,
} from "../../storage";
import type { CardDeps } from "./deps";

/** Shared HTML for the inline submit-confirmation section (hidden by default). */
export function submitConfirmHTML(): string {
  return `
      <div class="card-submit-confirm hidden">
        <p class="card-submit-q">Did you submit this?</p>
        <label class="card-submit-skip-lbl">
          <input type="checkbox" class="card-submit-skip-chk" />
          Don't ask me again
        </label>
        <div class="card-submit-btns">
          <button type="button" class="card-submit-yes">Yes, done</button>
          <button type="button" class="card-submit-no">Cancel</button>
        </div>
      </div>
    `;
}

/**
 * Wire the complete/delete/cancel buttons on a card.
 * Both TBA and normal cards share the same confirmation flow.
 */
export function wireSubmitConfirm(
  card: HTMLDivElement,
  focus: Deadline,
  isSeries: boolean,
  sKey: string,
  deps: CardDeps,
): void {
  const confirmDiv = card.querySelector<HTMLElement>(".card-submit-confirm")!;

  // Complete button — show inline confirmation or skip dialog
  card.querySelector(".card-complete")!.addEventListener("click", async () => {
    const skip = await loadSkipSubmitConfirm();
    if (skip) {
      // Preference already set — skip the dialog and remove immediately
      if (isSeries) deps.expandedSeries.add(sKey);
      await deleteDeadline(focus.id);
      await deps.onRerender();
    } else {
      // Show the inline confirmation
      confirmDiv.classList.toggle("hidden");
    }
  });

  // "Yes, done" — optionally save the skip preference, then remove
  card
    .querySelector(".card-submit-yes")!
    .addEventListener("click", async () => {
      const skipChk = card.querySelector<HTMLInputElement>(
        ".card-submit-skip-chk",
      )!;
      if (skipChk.checked) await saveSkipSubmitConfirm(true);
      if (isSeries) deps.expandedSeries.add(sKey);
      await deleteDeadline(focus.id);
      await deps.onRerender();
    });

  // "Cancel" — hide the confirmation without doing anything
  card.querySelector(".card-submit-no")!.addEventListener("click", () => {
    confirmDiv.classList.add("hidden");
  });

  // Delete button — remove deadline, keep series expanded
  card.querySelector(".card-delete")!.addEventListener("click", async () => {
    if (isSeries) deps.expandedSeries.add(sKey);
    await deleteDeadline(focus.id);
    await deps.onRerender();
  });
}
