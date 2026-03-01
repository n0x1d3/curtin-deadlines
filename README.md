# Curtin Deadlines

A Chrome extension that tracks Curtin University assessment deadlines. Never miss a deadline again.

**Install:** [Download from GitHub Releases](#installation) or [load from source](#developer-setup).

**Version:** 0.1.0 | **License:** MIT

## Features

- **PDF Import** – Drop a unit outline PDF and extract all assessment deadlines automatically (supports Curtin OASIS template)
- **API Fetch** – Enter a unit code + semester to pull titles, weights, and due dates (no login required)
- **Timetable Import** – Drag in your Curtin `.ics` timetable to auto-resolve "TBA" deadlines to class schedules and exam dates
- **Manual Entry** – Add deadlines by week number or exact date with live calendar preview
- **TBA Management** – Deadlines grouped by type (exam period / week known / fully unknown); resolve inline with a card form
- **Series Support** – "Teaching weeks 2–12" entries expand with auto-numbering (e.g., "Lab Report 1", "Lab Report 2", …)
- **Urgency Colors** – Visual indicators (overdue / urgent / soon / ok)
- **Series Collapsing** – See only the next upcoming deadline; expand to view full series
- **ICS Export** – Generate a `.ics` calendar file with VALARM reminders
- **Dark Mode** – Toggle in Settings
- **Backup & Restore** – Export deadlines to JSON, restore anytime
- **Default Semester** – Pre-set your primary semester to speed up API fetches
- **Local Storage** – All deadlines stored privately in Chrome; no accounts or syncing

## Screenshot & Demo

The main interface displays:
- A list of all upcoming deadlines grouped by status (overdue / urgent / soon / ok / TBA)
- A form to add new deadlines manually
- A drop zone to import PDFs or `.ics` files
- Quick links to API fetch and Settings

For a visual tour, see the [GitHub Pages landing page](https://n0x1d3.github.io/curtin-deadlines/).

## Installation

### End Users

1. **Download** the latest release from [GitHub Releases](https://github.com/n0x1d3/curtin-deadlines/releases)
2. **Unzip** the `build/` folder
3. Open Chrome and go to `chrome://extensions/`
4. **Enable "Developer mode"** (top-right toggle)
5. **Load unpacked** → select the `build/` folder
6. Click the **Curtin Deadlines** icon in your toolbar to open the side panel

### Developers

**Prerequisites:**
- Node 22.x (LTS)
- Bun 1.3.9+ ([install](https://bun.sh))

**Setup:**

```bash
git clone https://github.com/n0x1d3/curtin-deadlines.git
cd curtin-deadlines
bun install
bun run build
```

**Load in Chrome:**
1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `build/` folder
4. Click the extension icon to open the side panel

**Development mode** (with hot reload):

```bash
bun run watch
```

This rebuilds the extension after each file change. Reload the extension in Chrome to see updates.

## Development

### Commands

```bash
bun install          # Install dependencies
bun run build        # Production build → build/
bun run watch        # Dev mode with file watching
bun run test         # Run test suite (vitest, 222 tests)
bun run test:watch   # Watch mode for tests
bun run lint         # ESLint on src/**/*.ts
bun run lint:fix     # Auto-fix linting errors
bun run format       # Prettier on {src,config,public}/**
```

### Project Structure

```
curtin-deadlines/
├── build/                      # Compiled output (webpack)
├── config/
│   └── webpack.config.js       # Webpack 5 bundle config
├── public/
│   ├── manifest.json           # Chrome MV3 manifest
│   ├── sidePanel.html          # Main UI
│   ├── testPage.html           # Developer test panel
│   └── icons/                  # Extension icons
├── src/
│   ├── sidePanel.ts            # Main UI orchestrator
│   ├── background.ts           # Service worker (chrome.downloads)
│   ├── contentScript.ts        # Blackboard scraper (unused, placeholder)
│   ├── types.ts                # Shared interfaces
│   │
│   ├── api/
│   │   ├── outlineApi.ts       # Public API (fetchOutline, fetchOutlineData)
│   │   ├── outlineHttp.ts      # HTTP primitives
│   │   └── outlineLookup.ts    # Unit lookup & availability
│   │
│   ├── domain/
│   │   ├── deadlines.ts        # Pure deadline logic (seriesKey, parseWeekInput, etc.)
│   │   ├── outline.ts          # Barrel: outlineToDeadlines, parseAsTask, parsePcText
│   │   ├── parseAsTask.ts      # AS_TASK format parser
│   │   └── parsePcText.ts      # PC_TEXT HTML parser
│   │
│   ├── ics/
│   │   ├── parser.ts           # Barrel
│   │   ├── parseIcs.ts         # parseIcs(), parseIcsDate()
│   │   ├── matchIcs.ts         # Deadline matching
│   │   ├── detectTimetable.ts  # Unit + session detection
│   │   └── export.ts           # ICS export (chrome.runtime.sendMessage)
│   │
│   ├── pdf/
│   │   ├── index.ts            # Barrel: mergeWithCalendar(), addSequenceNumbers()
│   │   ├── extract.ts          # pdf.js I/O
│   │   ├── parseAssessments.ts # Barrel
│   │   ├── assessments/        # classify.ts, week.ts, parse.ts
│   │   ├── parseProgramCalendar.ts
│   │   └── __tests__/          # 221 comprehensive tests
│   │
│   ├── storage/
│   │   ├── index.ts            # Chrome storage helpers
│   │   ├── backup.ts           # JSON export/import
│   │   └── __tests__/          # Storage tests
│   │
│   ├── ui/
│   │   ├── cards.ts            # Barrel
│   │   ├── cards/              # deps.ts, tba.ts, normal.ts, series.ts, confirm.ts
│   │   ├── toast.ts            # showToast()
│   │   ├── wireIcs.ts          # ICS section wiring
│   │   ├── wirePdf.ts          # PDF drop zone wiring
│   │   ├── wireSettings.ts     # Settings panel wiring
│   │   └── __tests__/
│   │
│   └── utils/
│       ├── getDates.ts         # Semester date arithmetic
│       ├── format.ts           # escapeHtml, formatDate, etc.
│       └── __tests__/
│
├── src/**/__tests__/           # Test files (222 tests total)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .eslintrc.json
└── README.md (this file)
```

### Architecture Overview

**Data Model:**

The core `Deadline` interface (in `src/types.ts`) represents a single assessment:

```typescript
interface Deadline {
  id: string;
  title: string;
  unitCode: string;
  dueDate: string | null;      // ISO 8601 date or null for TBA
  week: number | null;          // Week number (1–14) or null
  weight: string | null;        // E.g., "10%", "?"
  outcomes?: string[];          // Learning outcomes
  lateAccepted?: boolean;        // PDF-sourced metadata
  extensionConsidered?: boolean;
  source: 'manual' | 'auto' | 'api' | 'pdf' | 'ics';
  semester: string;
  isFinalExam?: boolean;        // True for exam-type deadlines
  seriesKey?: string;           // Groups recurring items (e.g., "lab-reports")
  sequenceNumber?: number;      // Position in series (1, 2, 3, …)
}
```

**Data Flow:**

```
PDF Import:
  Drop PDF → extractPDFText (pdf.js) → parseAssessments + parseProgramCalendar →
  mergeWithCalendar → showConfirmation → saveDeadlines

API Fetch:
  Unit code input → fetchOutline (outlineApi) → parseAsTask + parsePcText + outlineToDeadlines →
  showConfirmation → saveDeadlines

ICS Import (Timetable):
  Drop .ics → parseIcs → detectTimetableUnits → fetchOutline (each unit) →
  matchIcsToDeadlines → resolveIcsMatches → showConfirmation → setDeadlineDate
```

**Key Modules:**

| Module | Purpose | Type |
|--------|---------|------|
| `api/outlineApi.ts` | Fetch unit data from Curtin OutSystems API | Network |
| `domain/deadlines.ts` | Pure deadline logic (grouping, filtering, parsing week input) | Pure TS |
| `domain/outline.ts` | Parse API response into Deadline objects | Pure TS |
| `ics/parser.ts` | Parse `.ics` timetable and match to deadlines | Pure TS |
| `pdf/extract.ts` | Read PDF text and fix null-byte encoded glyphs | PDF I/O |
| `pdf/parseAssessments.ts` | Extract Assessment Schedule table from PDF | Pure TS |
| `pdf/parseProgramCalendar.ts` | Extract Program Calendar (week → date mapping) | Pure TS |
| `storage/index.ts` | Chrome storage wrapper (loadDeadlines, saveDeadlines) | Chrome API |
| `ui/cards.ts` | Render deadline cards and confirmation dialogs | DOM |
| `sidePanel.ts` | Main orchestrator (tie all modules together) | DOM + Chrome API |

**Dependency Rules:**

- `domain/` and `utils/` → **zero Chrome API**; pure TypeScript, fully testable
- `storage/` → Chrome storage only; no DOM
- `ui/` → DOM only; use dependency injection to avoid circular imports
- `api/` and `ics/` → can use Chrome storage and network calls
- `sidePanel.ts` → freely uses DOM and Chrome APIs

### PDF Parsing

Curtin OASIS PDFs contain two main tables:

1. **Assessment Schedule** – rows with title, week/date, weight
2. **Program Calendar** – week → calendar date mapping

The parser:
- Extracts text via `pdf.js` (pdf.js-dist)
- Fixes null-byte encoded glyphs (Curtin PDFs map digits 0–9 and ligatures to U+0000) by reading accessibility metadata (`ActualText` from BDC operators)
- Parses table structure via regex (week/date/weight patterns)
- Merges Assessment Schedule with Program Calendar to convert week numbers to dates
- Deduplicates near-duplicate deadlines (within 3 days)
- Inherits weight and metadata when matching to API results

**Limitations:**
- Only works with Curtin OASIS template
- Image-scanned PDFs not supported
- Non-OASIS layouts fall back to TBA

### API Integration

Fetches unit data from **curtin.outsystems.app** (unauthenticated endpoints):

- No login required
- Cached unit list (~280KB, 30-day TTL)
- Per-unit availability IDs (always fresh)
- POST `ScreenDataSetGetNew` for assessment data
- Parses two response formats: `AS_TASK` (individual assessments) and `PC_TEXT` (program calendar HTML)

See `src/api/outlineApi.ts` for details.

### ICS Timetable Import

To resolve "TBA" deadlines:

1. **Detect** – Scans `.ics` entries for Curtin timetables (class sessions, exams)
2. **Fetch** – Pulls unit data for each detected unit via API
3. **Match** – Links TBA deadlines to ICS entries by week number or session type
4. **Resolve** – Shows user a confirmation dialog to resolve dates
5. **Update** – Sets `dueDate` for confirmed TBA items

### Testing

```bash
bun run test          # Run all 222 tests
bun run test:watch   # Watch mode
```

Tests are located in `src/**/__tests__/`:

- `domain/deadlines.test.ts` – deadline grouping, series expansion, filtering
- `domain/outline.test.ts` – outline parsing (AS_TASK, PC_TEXT)
- `ics/parser.test.ts` – ICS parsing and deadline matching
- `pdf/parseAssessments.test.ts` – PDF table extraction
- `pdf/parseProgramCalendar.test.ts` – calendar parsing
- `utils/format.test.ts` – formatting utilities
- `storage/backup.test.ts` – JSON export/import

**Coverage:** ~80% on business logic (pure functions). Chrome API and DOM code is not unit tested.

## Tested Units

The extension has been validated against real Curtin unit PDFs and API data:

| Unit | Semester | Methods | Assessment Count | Notes |
|------|----------|---------|------------------|-------|
| COMP1005 | S1 2026 | PDF, API | 7 | Full dates, complete Assessment Schedule |
| MATH1019 | S1 2026 | PDF, API | 3+ | Multiple assignment types |
| PRRE1003 | S1 2026 | PDF, API | 20 | Bi-weekly lab reports, many recurring items |
| ELEN1000 | S1 2026 | API only | 4 TBA | Non-OASIS PDF layout; API fallback |

## Contributing

### Development Workflow

1. **Explore** – Read relevant source files and understand the context
2. **Plan** – For multi-file changes, outline the approach in a comment or issue
3. **Code** – Follow the code style below
4. **Test** – Write tests alongside features (~80% coverage target)
5. **Lint** – Run `bun run lint:fix` before committing
6. **Commit** – Use [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat: add dark mode`, `fix: resolve null-byte glyphs`)
7. **PR** – One logical change per PR; reference a GitHub issue if one exists

### Code Style

- **ESLint + Prettier** – Auto-format with `bun run format` and `bun run lint:fix`
- **TypeScript** – Strict mode; all types explicit
- **Comments** – Explain *why*, not just *what*
- **Functions** – Max ~40 lines; prefer small, focused functions
- **Files** – Max ~300 lines; split if larger
- **Naming** – Descriptive, avoid abbreviations (e.g., `parseWeekInput` not `parseWkIn`)

### Branching

- Feature: `feature/short-description`
- Fix: `fix/short-description`
- Chore: `chore/short-description`

Never commit directly to `main`.

### Before You Submit

```bash
bun run format
bun run lint:fix
bun run test
bun run build
```

All tests must pass and the build must succeed.

## FAQ

**Q: Is my data shared with anyone?**
A: No. All deadlines are stored locally in your browser's Chrome storage. The extension only contacts Curtin's OutSystems API to fetch unit data (no personal information is sent).

**Q: Why no Chrome Web Store?**
A: The extension is in active development. Once stable, it may be submitted.

**Q: Can I use this on other browsers?**
A: Currently Chrome only. Manifest V3 is the target; porting to Firefox/Safari would require changes to the manifest and background service worker.

**Q: What if a PDF won't parse?**
A: The extension supports the Curtin OASIS template. If your PDF has a different layout, try the API fetch instead (unit code + semester). If the PDF has no Assessment Schedule table, all items will be added as TBA.

**Q: Can I sync deadlines across devices?**
A: Not yet. You can export deadlines to JSON in Settings, then import them on another device.

**Q: What if I find a bug?**
A: Open a [GitHub issue](https://github.com/n0x1d3/curtin-deadlines/issues) with details (unit code, PDF file, steps to reproduce).

## License

MIT – See [LICENSE](https://github.com/n0x1d3/curtin-deadlines/blob/main/LICENSE) for details.

## Links

- **GitHub:** [n0x1d3/curtin-deadlines](https://github.com/n0x1d3/curtin-deadlines)
- **Issues:** [Report bugs or request features](https://github.com/n0x1d3/curtin-deadlines/issues)
- **Landing Page:** [GitHub Pages site](https://n0x1d3.github.io/curtin-deadlines/)
