// ── Service worker for Curtin Deadlines ──────────────────────────────────────
// Two responsibilities:
//   1. Open the side panel when the user clicks the extension icon.
//   2. Receive ICS data from the side panel and trigger a file download.

import { command } from "./types";

// Open the side panel in the current tab when the toolbar icon is clicked.
// The side panel stays open while the user browses, unlike a popup.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Listen for messages from the side panel requesting an ICS download.
// The side panel sends: { command: 'downloadICS', value: icsString, filename: 'Curtin Deadlines...' }
chrome.runtime.onMessage.addListener((request) => {
  if (request.command === command.downloadICS) {
    // Encode the ICS text as a data URL so chrome.downloads can handle it
    const dataUrl =
      "data:text/calendar;charset=utf-8," +
      encodeURIComponent(request.value as string);
    const filename: string = request.filename ?? "Curtin Deadlines.ics";
    chrome.downloads.download({ url: dataUrl, filename });
  }
});
