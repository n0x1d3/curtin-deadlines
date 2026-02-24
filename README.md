# Curtin Deadlines

A Chrome extension that tracks all your Curtin University assessment deadlines in one place.

Add deadlines by dropping your unit outline PDF, fetching them automatically via the Curtin unit outline API, or entering them manually. All data is stored locally in Chrome storage — nothing leaves your browser except the API calls to `curtin.outsystems.app`.

---

## Features

- **PDF import** — drop your unit outline PDF and deadlines are extracted automatically from the assessment schedule and program calendar tables (supports the standard Curtin OASIS template)
- **API fetch** — enter a unit code (e.g. `COMP1005`) and semester to pull clean assessment titles, weights, and due dates directly from the Curtin unit outline hub (no login required)
- **Manual add** — add a deadline by week number or exact date; live preview shows the resolved calendar date
- **Timetable `.ics` import** — drag in your Curtin timetable export to cross-reference TBA deadlines against your actual class schedule
- **TBA handling** — deadlines with unknown dates are grouped by type (exam period / week known / fully unknown) and can be filled in from an inline form on each card
- **Recurring assessments** — "Teaching weeks 2–12" style entries expand into one card per week; sequential numbering applied automatically (Worksheet 1, Worksheet 2…)
- **Urgency colours** — cards are coloured by how soon the deadline is (urgent / soon / ok / overdue)
- **Series collapsing** — recurring assessments collapse to show only the next upcoming item; expand inline to see all
- **ICS export** — export all deadlines as a `.ics` calendar file with built-in VALARM reminders
- **Settings panel** — default semester, overdue position, JSON backup/restore, clear all
- **Dark mode**

---

## Screenshots

> Coming soon

---

## Installation (dev)

### Prerequisites

- Node.js 18+
- npm

### Build

```bash
npm install
npm run build       # production build → build/
npm run watch       # dev build with file watching
npm run format      # run prettier
```

### Load in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `build/` folder

---

## Project Structure

```
src/
  sidePanel.ts        # all UI logic: PDF parsing, rendering, confirmation, ICS export
  sidePanel.css       # styles (CSS variables, dark mode)
  background.ts       # service worker; opens side panel, handles ICS download
  contentScript.ts    # Blackboard scraper (injected into LMS pages)
  types.ts            # shared enums and interfaces (Deadline, PendingDeadline)
  api/
    outlineApi.ts     # Curtin OutSystems API integration
  utils/
    getDates.ts       # semester date arithmetic (weekToDate, getSemesterWeeks)
public/
  sidePanel.html      # panel HTML
  manifest.json       # Chrome MV3 manifest
config/
  webpack.config.js   # build config (common + dev/prod via webpack-merge)
```

---

## How PDF Parsing Works

The extension parses the standard Curtin OASIS unit outline PDF (the one you download from the unit outline hub). It reads two sections:

1. **Assessment Schedule table** — extracts assessment titles, week numbers, days, times, and weights
2. **Program Calendar table** — extracts week-by-week content to fill in dates for items that listed "TBA" in the schedule

Null-byte encoded glyphs (a quirk of OASIS PDFs) are replaced with `#` placeholders. The parser handles both single-digit and double-digit week/day numbers, including the space-separated double-hash variant (`# #`) that some PDF renderers produce.

Limitations:
- Image-scanned PDFs are not supported
- Non-OASIS layouts (e.g. ELEN1000) fall back to TBA — use the API fetch instead

---

## How the API Fetch Works

The Curtin unit outline hub runs on OutSystems and exposes unauthenticated public endpoints. The extension calls these directly — **no Curtin login is required**.

1. Unit code → look up `UNIT_CD` + `UNIT_VERS` from a cached unit list (~280KB, refreshed every 30 days)
2. Fetch the per-unit availability ID for the selected semester (always fresh, ~18KB)
3. POST to `ScreenDataSetGetNew` → receive unit outline including the program calendar HTML table and pipe-delimited assessment list
4. Parse `AS_TASK` for clean titles + weights; parse `PC_TEXT` for actual due dates

---

## Contributing

Contributions are welcome. Good places to start:

- **More unit outline layouts** — if your unit outline doesn't parse correctly, open an issue with the unit code and semester and we can add support
- **Items on the TODO list** — see [TODO.md](TODO.md) for known bugs and planned features
- **Tests** — no test runner is currently configured; adding one (e.g. Vitest) would be valuable

### Dev workflow

```bash
git clone https://github.com/n0x1d3/curtin-deadlines.git
cd curtin-deadlines
npm install
npm run watch
# load build/ in Chrome, make changes, reload the extension
```

Please open an issue before starting large changes so we can discuss the approach first.

---

## Supported Units (tested)

| Unit | Semester | Method | Notes |
|------|----------|--------|-------|
| COMP1005 | S1 2026 | PDF + API | Full dates, 7 items |
| MATH1019 | S1 2026 | PDF + API | Full dates, 3+ items |
| PRRE1003 | S1 2026 | PDF + API | 20 items including bi-weekly lab reports |
| ELEN1000 | S1 2026 | API only | PDF layout unsupported; 4 TBA items from API |

---

## License

MIT
