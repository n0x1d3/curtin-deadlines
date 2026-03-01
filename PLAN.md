# PLAN.md — Codebase Compliance Cleanup

_Last updated: 2026-03-01_
_Status: DRAFT_
_Spec: See SPEC.md_

## Approach

Fix in strict priority order — run `bun run test && bun run lint` after every step. Commits are atomic: one logical change per commit. File splits use barrel re-exports so no import paths change in consumers. Build gate (`bun run build`) run before final merge.

---

## Priority 1: Must-Have Fixes (no architecture change)

### Step 1 — ESLint errors (`src/ics/parser.ts`)

**File:** `src/ics/parser.ts`, inside `extractTimetableSessions()`.

ESLint flags `year` (line 480) and `semStartMonth` (line 486). These are part of a dead-code block — removing `semStartMonth` causes a cascade: `semester` (which only feeds `semStartMonth`) becomes unused, then `month` (which only feeds `semester`) becomes unused, and `year` was already unused. All four variables must be removed:

```ts
// Remove these four dead lines entirely:
const year = earliest.getFullYear();       // unused
const month = earliest.getMonth() + 1;     // only used by semester below
const semester: 1 | 2 = month >= 2 && month <= 6 ? 1 : 2;  // only used by semStartMonth below
const semStartMonth = semester === 1 ? 1 : 6;  // assigned but never read
```

Before deleting, confirm that `semester` and `month` are not referenced anywhere else in `extractTimetableSessions()`. If `semester` is used elsewhere in the function, remove only `semStartMonth` and `year` and prefix the others with `_`.

_Gate: `bun run lint` exits 0 after this step._

### Step 2 — ESLint warnings (`src/pdf/extract.ts`, `src/storage/__tests__/backup.test.ts`)

**File:** `src/pdf/extract.ts`

Add `// eslint-disable-next-line @typescript-eslint/no-explicit-any` immediately above each of lines 14, 181, 194. Each suppression must be followed by (or preceded by) a comment explaining why: the pdf.js operator list API is untyped and there is no meaningful alternative type.

**File:** `src/storage/__tests__/backup.test.ts`

Add `// eslint-disable-next-line @typescript-eslint/no-explicit-any` above line 247 in the test file.

_Gate: `bun run lint` exits 0 with 0 errors and 0 warnings after this step._

### Step 3 — Prettier formatting (commit working-tree fixes)

The 7 files already reformatted in the working tree need to be committed:
- `config/paths.js`
- `config/webpack.common.js`
- `config/webpack.config.js`
- `public/manifest.json`
- `public/sidePanel.html`
- `public/testPage.html`
- `src/sidePanel.css`

Verify with `bunx prettier --check --ignore-unknown "{config,public,src}/**/*.{html,css,js,ts,json}"` before committing. Do not add or remove any formatting configuration.

_Gate: format check exits 0._

### Step 4 — Silent catch block (`src/sidePanel.ts:803`)

**File:** `src/sidePanel.ts`, approximately line 803.

The catch block `} catch {` intentionally hides the week-preview element on invalid input. Add an inline comment inside the catch body explaining the intent:

```ts
} catch {
  // Intentional: hide the date preview when the week input cannot be parsed
  preview.classList.add("hidden");
}
```

Do NOT add `console.error` or `console.debug` — this catch fires on every keystroke during normal input and would produce spurious noise in DevTools.

_Gate: `bun run test` passes after this step._

### Step 5 — innerHTML escaping (`src/ui/cards.ts`, `src/sidePanel.ts`)

**File:** `src/ui/cards.ts`, line 175

Change:
```ts
? `<span class="card-dot">·</span><span class="card-weight">${focus.weight}%</span>`
```
To:
```ts
? `<span class="card-dot">·</span><span class="card-weight">${escapeHtml(String(focus.weight))}%</span>`
```

**File:** `src/sidePanel.ts`, approximately line 313

Change:
```ts
${item.weight ? `<span class="conf-weight-badge">${item.weight}%</span>` : ""}
```
To:
```ts
${item.weight ? `<span class="conf-weight-badge">${escapeHtml(String(item.weight))}%</span>` : ""}
```

The `weight` field is a string or number from API/PDF parsing and must be treated as external input.

Confirm `escapeHtml` is already imported at the top of each file before making these changes.

_Gate: `bun run test` passes._

### Step 6 — CLAUDE.md correction

**File:** `src/../CLAUDE.md` (project root: `/Users/n0xde/Files/Code Test Environment/curtindeadlines/CLAUDE.md`)

In the `## Commands` section, change:
```
bun test          # run vitest test suite (jsdom env)
```
To:
```
bun run test      # run vitest test suite (jsdom env)
```

`bun test` invokes bun's native test runner which ignores `vitest.config.ts`. `bun run test` runs the `"test": "vitest run"` script.

---

## Priority 2: Should-Have File Splits

**Rules for all splits:**
- Original file becomes a barrel re-export — every name it currently exports must continue to be re-exported from it
- No existing consumer file (`sidePanel.ts`, etc.) should need any import path changes
- After each split: `bun run test && bun run lint && bun run build` must all pass
- Each sub-module should be ≤300 lines

### Step 7 — Split `src/ics/parser.ts` (533 lines)

Lowest circular-import risk. Has good test coverage.

**New files to create:**

`src/ics/parseIcs.ts` (~120 lines)
- Move: `parseIcs()`, `parseIcsDate()`
- Imports needed: `IcsEvent` from `../types`

`src/ics/matchIcs.ts` (~160 lines)
- Move: `matchIcsToDeadlines()`, `matchIcsDatedConflicts()`, `matchIcsByWeekAndSession()`, `scoreEvent()` (private), `HIGH`/`MED` constants
- Imports needed: `IcsEvent`, `IcsMatch`, `Deadline` from `../types`; `isFinalExamType` from `../domain/deadlines`

`src/ics/detectTimetable.ts` (~130 lines)
- Move: `detectTimetableUnits()`, `extractTimetableSessions()`, `dateToSemesterWeek()` (private), `EXAM_KEYWORDS`, `SESSION_TYPE_KEYWORDS`
- Imports needed: `IcsEvent`, `TimetableInfo` from `../types`

**Update `src/ics/parser.ts`** → barrel re-export:
```ts
export { parseIcs, parseIcsDate } from "./parseIcs";
export { matchIcsToDeadlines, matchIcsDatedConflicts, matchIcsByWeekAndSession } from "./matchIcs";
export { detectTimetableUnits, extractTimetableSessions, EXAM_KEYWORDS } from "./detectTimetable";
// SESSION_TYPE_KEYWORDS is private — do NOT re-export from the barrel
```

### Step 8 — Split `src/ui/cards.ts` (491 lines)

**New files to create:**

`src/ui/cards/confirm.ts` (~80 lines)
- Move: `submitConfirmHTML()`, `wireSubmitConfirm()`
- These are only used internally by `buildTbaCard` — make them non-exported if possible

`src/ui/cards/tba.ts` (~210 lines)
- Move: `buildTbaCard()` and any helpers used exclusively by it
- Imports: `CardDeps` from `./deps`; `escapeHtml`, `truncate` from `../../utils/format`; `formatDate` etc.

`src/ui/cards/normal.ts` (~100 lines)
- Move: `buildNormalCard()` and its direct helpers
- Imports: `CardDeps`; format utils

`src/ui/cards/series.ts` (~60 lines)
- Move: `buildSeriesFooter()`

`src/ui/cards/deps.ts` (~20 lines)
- Move: `CardDeps` interface

**Update `src/ui/cards.ts`** → barrel:
```ts
export type { CardDeps } from "./cards/deps";
export { buildTbaCard } from "./cards/tba";
export { buildNormalCard } from "./cards/normal";
export { buildSeriesFooter } from "./cards/series";
```

### Step 9 — Split `src/pdf/parseAssessments.ts` (487 lines)

**New files to create:**

`src/pdf/assessments/classify.ts` (~80 lines)
- Move: `isPercentLine`, `endsWithPercent`, `extractTitleFromPercentLine`, `isNoiseLine`, `isTBAValue`, `isOutcomesLine`, `isYesNoLine`, `isCombinedYesNo`, `isMetaValue`, `isLateAcceptedLine`, `isExtensionLine` and any similar classifier functions

`src/pdf/assessments/week.ts` (~60 lines)
- Move: `extractAllWeeks`, `normalizeWeekLabel`, `extractTitleFromPercentLine` (if week-related)

`src/pdf/assessments/parse.ts` (~300 lines)
- Move: `parseAssessments()` main function + row-building logic
- Imports: from classify.ts and week.ts

**Update `src/pdf/parseAssessments.ts`** → barrel:
```ts
export { parseAssessments } from "./assessments/parse";
```
(Other functions are private helpers — do not re-export unless currently exported.)

Check which names `parseAssessments.ts` currently exports (`export function` or `export const`) before writing the barrel.

### Step 10 — Split `src/domain/outline.ts` (624 lines)

Dependency chain: `outlineToDeadlines` → `parsePcText` → `buildWeekHints`; `outlineToDeadlines` → `parseAsTask`.

**New files to create:**

`src/domain/parseAsTask.ts` (~120 lines)
- Move: `parseAsTask()`
- Imports: `PendingDeadline` from `../types`; no other domain imports (pure, no circular risk)

`src/domain/parsePcText.ts` (~320 lines)
- Move: `parsePcText()`, `buildWeekHints()` (private helper, keep unexported)
- Imports: `PendingDeadline` from `../types`; `parseOrdinalDate`, `weekToDate` from `../utils/getDates`
- Note: uses `DOMParser` — this is available in the extension context and in vitest/jsdom; do not add a polyfill

**Update `src/domain/outline.ts`** → keep `UobOutline` interface + `outlineToDeadlines()` + `titlesOverlap()` (private) + barrel re-exports:
```ts
export { parseAsTask } from "./parseAsTask";
export { parsePcText } from "./parsePcText";
export type { UobOutline } from "./outline"; // self
// outlineToDeadlines remains defined here
```

After split, `outline.ts` should be ~130 lines (interface + outlineToDeadlines + titlesOverlap + barrel).

### Step 11 — Split `src/api/outlineApi.ts` (621 lines)

Most complex split. Dependency chain must be linear to avoid circular imports:
`outlineApi.ts` → `outlineLookup.ts` → `outlineHttp.ts`

**New files to create:**

`src/api/outlineHttp.ts` (~180 lines)
- Move: `osPost()`, `fetchModuleVersion()`, `buildMinimalBody()`, `osListItem()`, `EMPTY_DD_ITEM`, `EMPTY_AVAIL_ITEM`, `ANON_CLIENT_VARS`, `API_VERSIONS`, `BASE`, `MODULE_VERSION_TTL_MS`
- Move interfaces: `OsListWrapper`, `VwOsUnit`, `AvailEntry`
- All functions in this file are private (not exported) except by re-export from outlineApi.ts
- Imports: `chrome` storage for version cache only; no imports from other api/ files

`src/api/outlineLookup.ts` (~280 lines)
- Move: `getUnitLookup()`, `getAvailabilityResult()`, `fetchUobOutline()`
- Move interfaces: `UnitEntry`, `UnitLookupCache`
- Imports: from `outlineHttp.ts`; no imports from `outlineApi.ts` (no circular)

**Update `src/api/outlineApi.ts`** → keep `fetchOutline()`, `fetchOutlineData()`, `getAllUnitCodes()`, `OutlineData` interface (~160 lines) + barrel:
```ts
// Public exports from sub-modules (consumers import from outlineApi)
export async function fetchOutline(...) { ... }        // stays here
export async function fetchOutlineData(...) { ... }    // stays here
export async function getAllUnitCodes(...) { ... }      // stays here
export interface OutlineData { ... }                   // stays here
```

After split, `outlineApi.ts` should be ~160 lines.

### Step 12 — Evaluate `src/ui/wireIcs.ts` (371 lines)

**Decision: skip split.** The file has two functions (`showIcsSection` and `wireIcsSection`) that are tightly coupled: `showIcsSection` is a private function called within `wireIcsSection`, sharing the same `deps` closure. Splitting would require passing internal state as parameters, changing the internal design without benefit. Defer until P4 architectural work if needed.

---

## Files to Change

| File | Change |
|------|--------|
| `src/ics/parser.ts` | Remove unused vars; becomes barrel after split |
| `src/pdf/extract.ts` | Add 3× eslint-disable-next-line |
| `src/storage/__tests__/backup.test.ts` | Add 1× eslint-disable-next-line |
| `src/sidePanel.ts` | Add catch comment; escapeHtml on item.weight |
| `src/ui/cards.ts` | escapeHtml on focus.weight; becomes barrel after split |
| `CLAUDE.md` | Fix `bun test` → `bun run test` |
| `config/paths.js`, `config/webpack.{common,config}.js` | Prettier only (already done) |
| `public/manifest.json`, `public/sidePanel.html`, `public/testPage.html` | Prettier only (already done) |
| `src/sidePanel.css` | Prettier only (already done) |

## Files to Create

| File | Purpose |
|------|---------|
| `src/ics/parseIcs.ts` | `parseIcs`, `parseIcsDate` |
| `src/ics/matchIcs.ts` | `matchIcsToDeadlines`, `matchIcsDatedConflicts`, `matchIcsByWeekAndSession` |
| `src/ics/detectTimetable.ts` | `detectTimetableUnits`, `extractTimetableSessions`, `EXAM_KEYWORDS` |
| `src/ui/cards/deps.ts` | `CardDeps` interface |
| `src/ui/cards/tba.ts` | `buildTbaCard` |
| `src/ui/cards/normal.ts` | `buildNormalCard` |
| `src/ui/cards/series.ts` | `buildSeriesFooter` |
| `src/ui/cards/confirm.ts` | `submitConfirmHTML`, `wireSubmitConfirm` |
| `src/pdf/assessments/classify.ts` | All line classifier functions |
| `src/pdf/assessments/week.ts` | Week extraction helpers |
| `src/pdf/assessments/parse.ts` | `parseAssessments` main |
| `src/domain/parseAsTask.ts` | `parseAsTask` |
| `src/domain/parsePcText.ts` | `parsePcText`, `buildWeekHints` |
| `src/api/outlineHttp.ts` | HTTP primitives, constants, body builders |
| `src/api/outlineLookup.ts` | `getUnitLookup`, `getAvailabilityResult`, `fetchUobOutline` |

## Implementation Steps

1. [ ] Fix ESLint errors: unused vars in `src/ics/parser.ts` → `bun run lint` exits 0
2. [ ] Fix ESLint warnings: eslint-disable-next-line in `pdf/extract.ts` and `backup.test.ts` → `bun run lint` exits 0 with 0 warnings
3. [ ] Commit Prettier-formatted files (already fixed in working tree) → `bun run format --check` exits 0
4. [ ] Add intentional comment to `sidePanel.ts:803` catch block
5. [ ] Wrap `focus.weight` and `item.weight` in `escapeHtml()` in cards.ts + sidePanel.ts
6. [ ] Fix `bun test` → `bun run test` in CLAUDE.md
7. [ ] Split `src/ics/parser.ts` → 3 sub-modules + barrel → all gates pass
8. [ ] Split `src/ui/cards.ts` → 4 sub-modules + barrel → all gates pass
9. [ ] Split `src/pdf/parseAssessments.ts` → 3 sub-modules + barrel → all gates pass
10. [ ] Split `src/domain/outline.ts` → 2 sub-modules + reduced barrel → all gates pass
11. [ ] Split `src/api/outlineApi.ts` → 2 new sub-modules + reduced barrel → all gates pass
12. [ ] `bun run build` → verify extension bundle produced successfully
13. [ ] Final: `bun run lint && bun run format --check && bun run test && bun run build` all exit 0

## Edge Cases

- **Barrel re-exports must re-export by name**, not `export * from` — the latter can mask missing exports at compile time
- **`buildWeekHints` is a private helper** in `parsePcText.ts` — do not export it from the barrel
- **`titlesOverlap` is private** in `outline.ts` — do not export
- **`outlineLookup.ts` must not import from `outlineApi.ts`** — would create a circular dependency
- **`wireIcs.ts` must not be split** (confirmed: tightly coupled state, no clean boundary)
- **Check `escapeHtml` import** at top of `cards.ts` and `sidePanel.ts` before adding new usages — it should already be imported; do not add a duplicate import

## Testing

- [ ] `bun run test` passes 222/222 after steps 1–6 (no splits yet)
- [ ] `bun run test` passes after each individual split (steps 7–11)
- [ ] `bun run lint` exits 0 after step 2
- [ ] `bun run build` exits 0 after step 12
- [ ] Final gate: all four commands exit 0

## Review History

| Round | Reviewer | Verdict | Date |
|-------|----------|---------|------|
| 1 | code-reviewer | NEEDS FIXES | 2026-03-01 |
