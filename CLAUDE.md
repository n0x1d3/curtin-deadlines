# CLAUDE.md — Curtin Deadlines Chrome Extension

Inherits from root `@/CLAUDE.md`. Only project-specific overrides are listed here.

## Code Style
- ESLint configured in `.eslintrc.json` (`@typescript-eslint/recommended` + Prettier) — not Airbnb (project-level override).

## Commands

```bash
bun run build     # production build → build/
bun run watch     # dev build with file-watch (reload extension after each build)
bun run format    # run prettier on src/, config/, public/
bun run lint      # run ESLint on src/**/*.ts
bun run lint:fix  # run ESLint with --fix (auto-corrects formatting)
bun test          # run vitest test suite (jsdom env)
bun run test:watch
```

Test files live in `src/**/__tests__/`.

## Architecture

Chrome Manifest V3 extension. TypeScript + Webpack 5. All source in `src/`, compiled output in `build/`.

### Entry Points

| File | Purpose |
|------|---------|
| `src/sidePanel.ts` | Main UI orchestrator — rendering, forms, confirmation, API fetch |
| `src/testPage.ts` | Developer test panel (opened from Settings) |
| `src/contentScript.ts` | Injected into Blackboard; scrapes deadline data |
| `src/background.ts` | Service worker; handles `chrome.downloads` for ICS export |

### Module Layout

```
src/
  types.ts                — All shared interfaces: Deadline, PendingDeadline, AppSettings,
                            IcsEvent, IcsMatch, TimetableInfo, command enum
  storage/
    index.ts              — Chrome storage helpers (loadDeadlines, saveDeadlines, etc.)
    backup.ts             — JSON export / import (exportJSON, importJSON)
  utils/
    getDates.ts           — Semester date arithmetic (weekToDate, getSemesterWeeks, etc.)
    format.ts             — Formatting utilities (formatDate, formatTime, getCountdown, defaultYear,
                            escapeHtml, truncate)
  ui/
    cards.ts              — Card builders: buildTbaCard, buildNormalCard, buildSeriesFooter,
                            CardDeps interface (extracted from renderDeadlines)
    toast.ts              — showToast(message, type) — replaces all alert() calls
    wireSettings.ts       — Settings panel wiring + dark mode (wireSettingsSection,
                            applyDarkMode, applyDefaultSemester, SettingsDeps)
    wireIcs.ts            — ICS import wiring + timetable UI (wireIcsSection, IcsDeps)
    wirePdf.ts            — PDF drop zone wiring (wirePDFDropZone, PdfDeps)
  domain/
    deadlines.ts          — Pure deadline logic: seriesKey, parseWeekInput, isFinalExamType,
                            extractSingleWeek, buildDeadlineSections, DeadlineSection
    outline.ts            — Pure outline parsing: parseAsTask, parsePcText, outlineToDeadlines,
                            UobOutline interface (no Chrome APIs, no network)
  api/
    outlineApi.ts         — Network code: fetchOutline, fetchOutlineData, getAllUnitCodes,
                            getUnitLookup, getAvailabilityResult, fetchModuleVersion
  ics/
    parser.ts             — ICS parsing: parseIcs, parseIcsDate, matchIcsToDeadlines,
                            matchIcsByWeekAndSession, detectTimetableUnits, EXAM_KEYWORDS
    export.ts             — ICS calendar export (exportICS → chrome.runtime.sendMessage)
  pdf/
    index.ts              — Barrel re-exports + mergeWithCalendar, addSequenceNumbers
    extract.ts            — PDF I/O: initPdfWorker, parseUnitName, extractPDFText (pdf.js)
    parseAssessments.ts   — Assessment schedule parsing from unit outline PDFs
    parseProgramCalendar.ts — Program Calendar section parsing
```

### Dependency Rules

- `domain/` and `utils/` — zero Chrome API usage; pure TypeScript. Safe to unit-test.
- `storage/` — Chrome storage only; no DOM access.
- `ics/`, `api/` — may use Chrome storage (api/) or Chrome messaging (ics/export.ts).
- `ui/` — DOM only; callbacks passed in via deps interfaces to avoid circular imports.
- `sidePanel.ts` — DOM + Chrome APIs freely; imports from all other modules.

### Data Flow

**PDF path:**
```
File drop → extractPDFText (pdf.js) → parseAssessments + parseProgramCalendar →
mergeWithCalendar → showConfirmation → saveConfirmedItems → addDeadline
```

**API path:**
```
Unit code input → fetchOutline (outlineApi) → parsePcText + parseAsTask + outlineToDeadlines →
showConfirmation → saveConfirmedItems → addDeadline
```

**ICS path (timetable import):**
```
.ics drop → parseIcs → detectTimetableUnits → fetchOutline (for each unit) → showConfirmation
                     → matchIcsToDeadlines + matchIcsByWeekAndSession → showIcsSection → setDeadlineDate
```

## Key Design Decisions

- **`isFinalExamType`** lives in `domain/deadlines.ts` (deadline classification, not ICS logic).
- **`buildDeadlineSections`** is a pure function — takes `{ filterUnit, filterStatus, sortBy, overduePosition }` as explicit opts so it's testable without DOM.
- **`showConfirmation`** takes `groups: { filename, items }[]` — supports multi-PDF; `pendingItems` is the flat concat.
- **`importJSON`** in `storage/backup.ts` does NOT call `renderDeadlines()` — caller is responsible.
- **`clearAllDeadlines`** was removed — inlined as `await saveDeadlines([]); await renderDeadlines()`.
- **`outlineToDeadlines`** and all PC_TEXT/AS_TASK parsing live in `domain/outline.ts`; `outlineApi.ts` only does network/cache work.
- **`Deadline.source`** values: `'manual' | 'auto' | 'api' | 'pdf' | 'ics'`.
- **`Deadline`** has `outcomes`, `lateAccepted`, `extensionConsidered` fields — `lateAccepted`/`extensionConsidered` are PDF-only (not in API response).
- **`overduePositionRef`** is a `{ value }` wrapper so extracted wiring modules can mutate it by reference.
- **`CardDeps.onRerender`** (not `rerender`) — renamed during P3a extraction.
