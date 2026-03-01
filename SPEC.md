# SPEC.md — Codebase Compliance Cleanup

_Last updated: 2026-03-01_
_Status: DRAFT_

## Problem

The codebase has drifted from the standards in `/Users/n0xde/Files/CLAUDE.md`:

- `bun run lint` exits 1 — 2 ESLint errors (unused variables) + 4 warnings
- 7 files have Prettier violations at HEAD (auto-fixed in working tree — commit pending)
- 1 catch block silently swallows errors (`sidePanel.ts:803`)
- 2 `innerHTML` sites interpolate `weight` (API/PDF string) without `escapeHtml()`
- 8 source files exceed the ~300-line limit (6 fixable; 2 deferred architectural debt)
- Documentation error: project CLAUDE.md says `bun test` runs vitest — it doesn't; bun's native runner ignores `vitest.config.ts` and is incompatible with `vi.setSystemTime` and jsdom

None are user-visible failures today, but they represent accumulated technical debt that blocks reliable CI and onboarding.

## Goals

All of the following must be true on the cleanup branch before merge:

1. `bun run lint` exits 0 — zero errors, zero warnings (or all remaining warnings explicitly suppressed with inline comments explaining why)
2. `bun run format --check` exits 0 — zero Prettier violations (i.e. `bunx prettier --check --ignore-unknown "{config,public,src}/**/*.{html,css,js,ts,json}"` passes)
3. `bun run test` exits 0 — all 222 tests pass (current baseline; no regressions)
4. `bun run build` succeeds — webpack build produces a valid extension bundle
5. Every `catch` block either logs via `console.error` / `console.debug` at minimum, or carries an explicit inline comment explaining why logging is intentionally omitted
6. Every `innerHTML` site that interpolates `weight` (string from API/PDF data) wraps it in `escapeHtml()`
7. Project `CLAUDE.md` commands section corrected: `bun test` → `bun run test`

## Non-Goals

The following are explicitly out of scope for this cleanup:

- **No behavior changes** — output, timing, and user-facing results must be identical before and after
- **No new features** — no new UI elements, options, or data paths
- **No API or module interface changes** — all existing import paths must continue to work unchanged; use barrel re-exports if splitting files
- **`src/sidePanel.ts` (1120 lines)** — file-length compliance deferred (P4); too intertwined with DOM/Chrome API orchestration to split safely in isolation
- **`src/testPage.ts` (2162 lines)** — file-length compliance deferred (P4) for the same reason
- **New test suites** for `storage/index.ts` or `api/outlineApi.ts` — blocked by Chrome API dependency / network-only constraints
- **`no-explicit-any` in `src/pdf/extract.ts`** (3 instances) — the operators list from pdf.js is genuinely dynamic; suppress with `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + rationale comment rather than retyping
- **`no-explicit-any` in `src/storage/__tests__/backup.test.ts`** (1 warning in test code) — suppress with `// eslint-disable-next-line` if needed
- **CSS, HTML, config files** — Prettier auto-format only; no manual content changes beyond formatting
- **Function-length enforcement** (~40-line limit) — deferred; too entangled with file-split work to enforce independently; assess after splits complete

## Context

### Audit snapshot — 2026-03-01

**ESLint (`bun run lint`):**
```
src/ics/parser.ts:480  error  'year' assigned but never used
src/ics/parser.ts:486  error  'semStartMonth' assigned but never used
src/pdf/extract.ts:14  warning  no-explicit-any  (deferred — suppress)
src/pdf/extract.ts:181 warning  no-explicit-any  (deferred — suppress)
src/pdf/extract.ts:194 warning  no-explicit-any  (deferred — suppress)
src/storage/__tests__/backup.test.ts:247  warning  no-explicit-any  (deferred)
```

**Prettier:**
7 files had violations at HEAD. Already auto-fixed in working tree (committed to clean state as part of this cleanup). Files: `config/paths.js`, `config/webpack.common.js`, `config/webpack.config.js`, `public/manifest.json`, `public/sidePanel.html`, `public/testPage.html`, `src/sidePanel.css`.

**Tests:**
- `bun run test` (vitest): **222/222 pass** — baseline confirmed, no failures
- `bun test` (bun native runner): incompatible — ignores `vitest.config.ts`; jsdom and `vi.setSystemTime` unavailable. Root cause is documentation misalignment, not broken tests.

**Silent catch:**
- `src/sidePanel.ts:803` — `} catch { preview.classList.add("hidden") }` — intentional but undocumented

**Unescaped `innerHTML` interpolations:**
- `src/ui/cards.ts:175` — `${focus.weight}%` — no `escapeHtml()`; weight is a string from API/PDF
- `src/sidePanel.ts:313` — `${item.weight}%` — no `escapeHtml()`; same source

The following `innerHTML` sites were audited and are **already safe**:
- `src/sidePanel.ts:89,249,265,303,435` — all dynamic values pass through `escapeHtml()` or are numeric/boolean locals
- `src/ui/wireIcs.ts:80,177` — `escapeHtml(unit)` already applied; `semester`/`year` are numbers
- `src/ui/cards.ts:190,366,418,424,449` — all string interpolations use `escapeHtml()`; numeric/boolean locals are safe
- `src/testPage.ts` — uses local `escHtml()` wrapper consistently; one instance (`a.weight` at line 1257) mirrors the same pattern as the cards/sidePanel issues but is deferred (developer-only page)

**Files over ~300 lines (non-deferred):**

| File | Lines | Action |
|------|-------|--------|
| `src/domain/outline.ts` | 624 | Split + barrel re-export |
| `src/api/outlineApi.ts` | 621 | Split + barrel re-export |
| `src/ics/parser.ts` | 533 | Split + barrel re-export |
| `src/ui/cards.ts` | 491 | Split + barrel re-export |
| `src/pdf/parseAssessments.ts` | 487 | Split + barrel re-export |
| `src/ui/wireIcs.ts` | 371 | Split if clean boundary exists |
| `src/sidePanel.ts` | 1120 | **Deferred (P4)** |
| `src/testPage.ts` | 2162 | **Deferred (P4)** |

## Requirements

### Must Have

- [ ] `bun run lint` exits 0
  - [ ] Remove or `_`-prefix `year` at `src/ics/parser.ts:480`
  - [ ] Remove or `_`-prefix `semStartMonth` at `src/ics/parser.ts:486`
  - [ ] Suppress 3× `no-explicit-any` in `src/pdf/extract.ts` (lines 14, 181, 194) with `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + one-line rationale comment each
  - [ ] Suppress 1× `no-explicit-any` in `src/storage/__tests__/backup.test.ts:247` with `// eslint-disable-next-line`
- [ ] `bun run format --check` exits 0 — commit the 7 auto-formatted files
- [ ] `bun run test` passes 222/222 after every change (gate before each commit)
- [ ] `bun run build` succeeds (gate before merge; catches broken imports from splits)
- [ ] `src/sidePanel.ts:803` — add `// intentional: hide preview on malformed week input` comment to the empty catch body (do NOT add `console.debug` — this fires on every keystroke during normal input and would produce spurious noise in DevTools)
- [ ] `src/ui/cards.ts:175` — wrap `focus.weight` in `escapeHtml()`
- [ ] `src/sidePanel.ts:313` — wrap `item.weight` in `escapeHtml()`
- [ ] Project `CLAUDE.md` (`/Users/n0xde/Files/Code Test Environment/curtindeadlines/CLAUDE.md`) — commands section: `bun test` → `bun run test`

### Should Have

- [ ] `src/domain/outline.ts` — split into sub-modules ≤300 lines each; barrel re-export from original path preserving all exported names
- [ ] `src/api/outlineApi.ts` — split into sub-modules; barrel re-export; ensure no circular imports
- [ ] `src/ics/parser.ts` — split into sub-modules; barrel re-export
- [ ] `src/ui/cards.ts` — split into sub-modules; barrel re-export
- [ ] `src/pdf/parseAssessments.ts` — split into sub-modules; barrel re-export
- [ ] `src/ui/wireIcs.ts` — split only if a clean functional boundary exists between the unit-detection UI and the ICS-matching UI; skip if boundary would be arbitrary

### Won't Have (this iteration)

- `sidePanel.ts` / `testPage.ts` file-length compliance (P4)
- New test suites for untestable modules (`storage/index.ts`, `api/outlineApi.ts`)
- Function-length enforcement (~40-line limit) — assess after file splits
- `testPage.ts` weight escaping (multiple sites; developer-only page, lower risk)

## Success Criteria

A passing codebase looks like:

```
$ bun run lint    → exit 0, 0 errors, 0 warnings
$ bun run format --check → exit 0
$ bun run test    → 222/222 pass (or more if new tests added)
$ bun run build   → exit 0, bundle produced in build/
```

Plus: all non-deferred source files ≤ 300 lines, `weight` fields escaped in cards and sidePanel, catch block documented, CLAUDE.md corrected.

## Open Questions

1. **`api/outlineApi.ts` circular import risk** — the file has both low-level primitives (`osPost`, `fetchModuleVersion`) that are used by higher-level functions (`fetchOutline`, `getAllUnitCodes`). The split boundary must be verified against the import graph before implementation to prevent circular dependencies. Proposed: split into `api/outline/http.ts` (primitives), `api/outline/units.ts`, `api/outline/fetch.ts` (orchestrators); outlineApi.ts becomes a barrel.

2. **`wireIcs.ts` split decision** — implementer to decide after reading the file. If the unit-detection section (lines ~1–150) and the ICS-matching section (lines ~150–371) have no shared state, split. Otherwise defer.

## Review History

| Round | Reviewer | Verdict | Date |
|-------|----------|---------|------|
| 1 | code-reviewer | NEEDS FIXES | 2026-03-01 |
| 2 | code-reviewer | APPROVED | 2026-03-01 |
