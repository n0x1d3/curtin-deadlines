# Curtin Deadlines — TODO

## Current State (as of 2026-02-24, updated)
- Multi-PDF upload (up to 4 at once); confirmation shows per-file section headers
- PDF parsing working for COMP1005, MATH1019, PRRE1003 (ELEN1000 layout unsupported → TBA fallback)
- Assessment schedule parser (`parseAssessments`) + Program Calendar parser (`parseProgramCalendar`) both implemented
- `mergeWithCalendar` upgrades TBA schedule items with calendar week data
- Multi-week expansion (e.g. "Teaching weeks 2,...,12" → one item per week)
- Sequential numbering: recurring assessments auto-numbered (Practical Test 1, 2, … etc.)
- `#` null-byte placeholder stripping in weekLabel and exactTime display
- Calendar week dates use `calendarWeekCount` offset (teaching + non-teaching) for accurate mid-semester break handling
- PRRE1003 dot-free non-teaching rows (`"# April Tuition Free Week"`) handled via `NO_DOT_WEEK_ROW` pattern
- NO_DOT_WEEK_ROW handler now extracts trailing assessment content (e.g. `"... Lab B report"`) — fixes missing PRRE1003 items
- TBA items now checked by default in confirmation UI (so ELEN1000's 4 TBA items show up)
- ELEN1000 `(x #)` recurrence-count suffixes stripped from titles — "Laboratory Report" not "Laboratory Report (x )"
- `isTBAValue` now covers "fortnightly", "weekly", "bi-weekly" weekStr values
- Confirmation checklist UI with Cal/TBA badges
- Deadline cards with urgency colours, countdown, delete
- Manual add form (week mode + date mode)
- ICS export with VALARM reminders
- Dark mode (saved preference)
- Blackboard scraper (contentScript.ts)
- **OutSystems API integration** (`src/api/outlineApi.ts`): fetch unit outline by unit code + semester/year
  - Unit lookup cache (30-day TTL, ~280KB, all ~6k Curtin units)
  - Per-unit availability IDs fetched fresh (no cache — IDs differ per unit)
  - Full filterList_units required in ScreenDataSetGetNew (6k+ units; < this → always returns COMP1005)
  - `parsePcText`: multi-column detection (Assessment + Workshop cols), `\xa0` fix, no-Begin-Date early return
  - `parseAsTask`: pipe-delimited assessment list → titles + weights
  - `outlineToDeadlines`: PC_TEXT primary (dated), AS_TASK TBA fallback; weight propagation to PC items
  - `titlesOverlap`: 3-strategy matching — first-word prefix, normalised exact, single-word lookup
  - Confirmed working: COMP1005 (7 items), MATH1019 (3 items), PRRE1003 (20 items), ELEN1000 (4 TBA)
  - UI: `#api-section` above drop-zone (unit code + semester + year + Fetch button)
- **Settings panel** — gear icon in header; overdue position toggle; JSON export/import; clear all; default semester
- **ICS timetable import** — drag/drop .ics file; matches TBA deadlines to timetable events by unit code + exam keyword; second pass by week number + session type (lab/workshop/tutorial/lecture); `matchReason` shown under matched deadline
- **TBA section split** — three sub-sections in card list:
  - "Exam period" — `isFinalExamType()` matches final exams only (excludes mid-sem tests, quizzes, practicals)
  - "Week N · TBC" — items with a parseable single week number in weekLabel
  - "Date TBA" — fully unknown; no week info
- **`buildWeekHints()`** — scans ALL PC_TEXT columns (not just assessmentCols) for assessment title → week number mapping; TBA fallback items now get `weekLabel: "Week N"` when the title appears anywhere in the PC_TEXT table
- Confirmation screen pre-fills `Wk(s)` input from `weekLabel` for TBA items

---

## Bugs / Parsing Fixes
- [x] Some PDFs with actual exact dates not being picked up by `parseAssessments`
  - Fixed: `weekStr === ''` was unconditionally forcing `isTBA = true` even when `parsedExactDate` was valid. Now only triggers when `!parsedExactDate`.
  - Fixed: `exactDay === ''` was forcing TBA even when `allWeeks.length > 0`. Now only triggers when both are absent.
  - Fixed: `parseOrdinalDate` now handles "# #rd May" (space-separated double-hash) pattern in addition to "##rd May" (consecutive).
- [x] MATH1019 calendar items not merging correctly with schedule TBA items
  - Fixed: `titlesMatch` now expands "Sem" → "Semester" before normalising, and uses substring matching in addition to prefix matching — so "Quiz" matches "Workshop Quiz" and "Mid-Sem Test" matches "Mid-Semester Test"
  - Fixed: `mergeWithCalendar` now uses the calendar's canonical title (from ASSESSMENT_DEFS) when upgrading a TBA schedule item, so "E-Test" → "eTest"
  - Fixed: `NON_TEACHING` regex used `examination\b` which doesn't match "Examinations" (plural). Changed to `examinations?\b` — exam-period rows no longer inflate `teachingWeekCount`, fixing wrong week numbers (e.g. eTest was week 12, now correctly week 12 with accurate date)
- [x] Mid-semester tests / quizzes / practicals incorrectly showing "Exam period" badge
  - Fixed: replaced broad `EXAM_KEYWORDS` categorisation with `isFinalExamType()` — disqualifies mid-sem/prac/lab/quiz/workshop keywords before checking for "final" or "examination"
- [x] TBA items from API had no week info → always showed "Date TBA" even when week visible in PC_TEXT
  - Fixed: `buildWeekHints()` scans all PC_TEXT columns; `outlineToDeadlines` uses result to set `weekLabel: "Week N"` on TBA fallbacks; confirmation screen pre-fills week input
- [ ] Some PDFs still not readable (image-scanned, non-OASIS template, unusual layouts)
- [ ] Bi-weekly labs: ELEN1000 "Fortnightly" weekStr shows 1 TBA item — user must type weeks manually (e.g. "2,4,6,8,10"); digit count `(x 5)` unrecoverable from null-byte encoding
- [ ] `buildWeekHints` noise risk: short/generic lecture-column entries (e.g. "Quiz" alone as a lecture topic) could create false week matches — test with more units
- [ ] Bug/error reporting for PDF submissions — collect more unit outlines to improve detection accuracy

---

## Features (Confirmed Useful)
- [x] **Numbered worksheets** — `addSequenceNumbers()` implemented; recurring assessments auto-numbered (Worksheet 1, Worksheet 2…)
- [x] **Hide future items** — show only the next upcoming instance of a recurring assessment; series footer (▶ 3 of 5 · 2 more ahead) expands all items inline
- [x] **Filter / sort bar** — unit code dropdown (dynamic), status pills (All/Upcoming/TBA/Overdue), sort toggle (Date ↕ / Unit ↕); filter state persists across re-renders
- [x] **TBA cards at top** — TBA items always float above resolved cards; within each group sorted by unit code (date sort) or unit→date (unit sort)
- [x] **Import Curtin Calendar .ics** — drag/drop timetable .ics; cross-references TBA deadlines to timetable events for exact class dates; unit checkboxes → fetch outlines from API
- [x] **Done checkmark** — ✓ button on each card; inline "Did you submit?" confirm with "Don't ask me again" checkbox (stored in chrome.storage.local); removes item on confirm
- [x] **Unit name next to unit code** — `parseUnitName(text, unitCode)` scans first 40 PDF lines; shown in card-top header as "COMP1005 · Introduction to Computing" (truncated to 32 chars); stored as `unitName?` on both `PendingDeadline` and `Deadline` interfaces
- [x] **Assessment weight / percentage** — extracted from API (AS_TASK clean text); badge in date row (e.g. "· 20%"); `conf-weight-badge` in confirmation
  - NOTE: Curtin OASIS PDFs null-byte encode digit glyphs → weight `undefined` for most PDF imports; use API for reliable weights
- [x] **Settings panel** — gear icon; default semester; overdue position (top/bottom); JSON export/import; clear all deadlines
- [ ] **Exam dates precision** — exam period is currently formula-based (teaching weeks + 2); no integration with official academic calendar PDF or Curtin exam timetable page; user must still confirm exact date from the pre-filled Monday
- [ ] **Reset "Don't ask me again"** — `skipSubmitConfirm` flag not yet exposed in settings panel (workaround: clear all via settings wipes it)
- [ ] **Clickable deadline details** — assessments to show parsed description/criteria from unit outline (structure is consistent across OASIS PDFs)
- [ ] **Due date safety revert** — week-only dates default to Monday (conservative: earliest possible due day); Friday default rejected as it could mask earlier deadlines
- [ ] **LMS submit button** — quick-link button on each card → goes to Blackboard submission page for that unit
- [ ] **Reminders tab** — push or in-extension notification scheduler

---

## Recommended Next Work
- [ ] **Test `buildWeekHints` with real units** — fetch MATH1019 from API, open DevTools, verify mid-semester test TBA item logs `[hint: Week 5]`; check other units for false positives
- [ ] **ICS second pass now more useful** — with `buildWeekHints` setting weekLabels on API TBA items, `matchIcsByWeekAndSession` (week + session-type ICS matching) should now fire for more items; test with a MATH1019 timetable .ics to confirm lab/workshop matches
- [ ] **Exam timetable integration** — Curtin releases the exam timetable mid-semester at `exams.curtin.edu.au`; scraping or parsing this PDF would let exam cards get an exact date + time instead of just the exam period range
- [ ] **ELEN1000 weekly labs** — explore whether `buildWeekHints` can now extract per-week lab assignments (each week's lab topic column might list the specific lab report); if so, could expand fortnightly TBA into per-week cards automatically
- [ ] **"Weekly" keyword expansion** — assessments described as "weekly" (e.g. "Weekly Quizzes") should be detected and expanded into one item per teaching week, the same way "Teaching weeks 2,...,12" is expanded; `isTBAValue` currently swallows "weekly" as TBA — instead it should trigger multi-week expansion across all teaching weeks for that semester
- [ ] **Week-only items without an exact day** — items that have a week number but no specific day/date should still prompt the user to add a date in the confirmation UI; the resolved date shown on the card should be clearly marked as an estimate (e.g. "~Mon Week 5") rather than a hard date, both in confirmation AND on the saved deadline card; cards with an estimated date should keep an inline edit affordance so the user can update the date later once they find out the real one (e.g. from their unit coordinator); needs a new `dateIsEstimate?: boolean` flag on `Deadline`
- [ ] **Confirmation UX: TBA with week pre-filled** — now that TBA items can have week pre-filled, consider auto-saving them without requiring the user to click "Save" (with an opt-out); reduces friction for API-fetched items with week hints

---

## Settings Menu (Planned)
- [x] **Settings panel** — accessible from a gear icon in the header
- [ ] **Reset "Don't ask me again"** for submit confirmation (`skipSubmitConfirm` flag)
- [x] **Default semester selector** (S1 / S2 pre-filled in manual form and TBA fill-ins) — `applyDefaultSemester()`
- [x] **Clear all deadlines** button (with confirmation) — `clearAllDeadlines()`
- [x] **Export / import deadlines as JSON** (backup + restore) — `exportJSON()` / `importJSON()`
- [x] **Toggle: show overdue items at top or bottom of list** — `overduePosition` setting

---

## Maybe / Explore Later
- [ ] Study timer feature
- [ ] GPA / weighted grade calculator
- [ ] All-in-one student centre concept (reminders + grades + deadlines in one panel)
- [ ] Investigate Blackboard scraper further for auto-importing assignment details
- [ ] Performance / lag check once list grows large

---

## Session Notes
- Always update this file at the end of a session before `/clear`
- Use git branches for multi-session feature work
- Delegate search/grep tasks to Explore subagent to keep main context lean
