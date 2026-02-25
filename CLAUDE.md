# CLAUDE.md — Curtin Deadlines Chrome Extension

This file provides guidance to Claude Code when working on this codebase.

## Commands

```bash
npm run build     # production build → build/
npm run watch     # dev build with file-watch (reload extension after each change)
npm run format    # run prettier on src/, config/, public/
```

Tests: `npm test` (Vitest, jsdom env). Test files live in `src/**/__tests__/`.

## Architecture

Chrome Manifest V3 extension. TypeScript + Webpack 5. All source in `src/`, compiled output in `build/`.

### Entry Points

| File | Purpose |
|------|---------|
| `src/sidePanel.ts` | Main UI — rendering, forms, PDF drop, ICS import, settings |
| `src/testPage.ts` | Developer test panel (opened from Settings) |
| `src/contentScript.ts` | Injected into Blackboard; scrapes deadline data |
| `src/background.ts` | Service worker; handles `chrome.downloads` for ICS export |

### Module Layout (post-refactor)

```
src/
  types.ts                — All shared interfaces: Deadline, PendingDeadline, AppSettings,
                            IcsEvent, IcsMatch, TimetableInfo, command enum
  storage/
    index.ts              — Chrome storage helpers (loadDeadlines, saveDeadlines, etc.)
    backup.ts             — JSON export / import (exportJSON, importJSON)
  utils/
    getDates.ts           — Semester date arithmetic (weekToDate, getSemesterWeeks, etc.)
    format.ts             — Formatting utilities (formatDate, formatTime, getCountdown, defaultYear)
  domain/
    deadlines.ts          — Pure deadline logic: seriesKey, parseWeekInput, isFinalExamType,
                            extractSingleWeek, buildDeadlineSections, DeadlineSection
    outline.ts            — Pure outline parsing: parseAsTask, parsePcText, outlineToDeadlines,
                            UobOutline interface (no Chrome APIs, no network)
  api/
    outlineApi.ts         — Network code: osPost, fetchModuleVersion, getUnitLookup,
                            getAvailabilityResult, fetchUobOutline, fetchOutline,
                            fetchOutlineData, getAllUnitCodes
  ics/
    parser.ts             — ICS parsing: parseIcs, parseIcsDate, matchIcsToDeadlines,
                            matchIcsByWeekAndSession, detectTimetableUnits, EXAM_KEYWORDS
    export.ts             — ICS calendar export (exportICS → chrome.runtime.sendMessage)
  pdf/
    parser.ts             — PDF text extraction and parsing (shared with testPage)
```

### Dependency Rules

- `domain/` and `utils/` — zero Chrome API usage; pure TypeScript. Safe to unit-test.
- `storage/` — Chrome storage only; no DOM access.
- `ics/`, `api/` — may use Chrome storage (api/) or Chrome messaging (ics/export.ts).
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
- **`buildDeadlineSections`** is a pure function — `renderDeadlines` passes module-level state as explicit params so it's testable.
- **`importJSON`** in `storage/backup.ts` does NOT call `renderDeadlines()` — caller is responsible.
- **`clearAllDeadlines`** was removed — inlined as `await saveDeadlines([]); await renderDeadlines()`.
- **`outlineToDeadlines`** and all PC_TEXT/AS_TASK parsing live in `domain/outline.ts`; `outlineApi.ts` only does network/cache work.
- **`Deadline.source`** values: `'manual' | 'auto' | 'api' | 'pdf' | 'ics'`.

## Development Workflow

1. `npm run build` — check it compiles cleanly before committing.
2. Load the unpacked extension from `build/` in `chrome://extensions`.
3. For UI changes: `npm run watch`, then reload the extension after each build.
4. For domain logic changes: changes in `domain/` and `utils/` are safe to test in isolation.
