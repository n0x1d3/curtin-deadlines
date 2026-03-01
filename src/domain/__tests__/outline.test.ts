// ── Tests: domain/outline.ts ──────────────────────────────────────────────────
// parseAsTask and parsePcText (DOMParser available via vitest jsdom environment)

import { describe, it, expect } from "vitest";
import { parseAsTask, parsePcText, outlineToDeadlines } from "../outline";
import type { UobOutline } from "../outline";

// ── parseAsTask ───────────────────────────────────────────────────────────────

describe("parseAsTask", () => {
  const SAMPLE_AS_TASK = `1| Assignment| 40 percent| ULOs assessed 1|2|4;\n2| Practical Test| 20 percent| ULOs assessed 2|3;\n3| Final Examination| 40 percent| ULOs assessed 1|2|3|4|`;

  it("returns one item per assessment row", () => {
    const items = parseAsTask(SAMPLE_AS_TASK);
    expect(items).toHaveLength(3);
  });

  it("extracts title correctly", () => {
    const items = parseAsTask(SAMPLE_AS_TASK);
    expect(items[0].title).toBe("Assignment");
    expect(items[1].title).toBe("Practical Test");
    expect(items[2].title).toBe("Final Examination");
  });

  it('extracts weight when "N percent" is present', () => {
    const items = parseAsTask(SAMPLE_AS_TASK);
    expect(items[0].weight).toBe(40);
    expect(items[1].weight).toBe(20);
    expect(items[2].weight).toBe(40);
  });

  it("returns undefined weight when not present", () => {
    const asTask = "1| Assignment| no weight info|;\n";
    const items = parseAsTask(asTask);
    expect(items[0].weight).toBeUndefined();
  });

  it("extracts ULO outcomes when present", () => {
    const items = parseAsTask(SAMPLE_AS_TASK);
    expect(items[0].outcomes).toBe("1,2,4");
    expect(items[1].outcomes).toBe("2,3");
    expect(items[2].outcomes).toBe("1,2,3,4");
  });

  it("returns undefined outcomes when ULO column is absent", () => {
    const asTask = "1| Assignment| 40 percent|;";
    const items = parseAsTask(asTask);
    expect(items[0].outcomes).toBeUndefined();
  });

  it("returns empty array for empty string", () => {
    expect(parseAsTask("")).toEqual([]);
  });

  it("skips rows with fewer than 2 pipe-separated columns", () => {
    expect(parseAsTask("just a sentence without pipes")).toEqual([]);
  });

  it("handles trailing semicolons correctly", () => {
    const asTask = "1| Lab Report| 10 percent|;";
    const items = parseAsTask(asTask);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Lab Report");
  });
});

// ── parsePcText ───────────────────────────────────────────────────────────────

// Minimal HTML table matching the PC_TEXT format used by unit outlines
const SAMPLE_PC_TEXT = `
<table>
  <tr>
    <th>Teaching Week</th>
    <th>Begin Date</th>
    <th>Assessment</th>
  </tr>
  <tr>
    <td>1</td>
    <td>2 February</td>
    <td>-</td>
  </tr>
  <tr>
    <td>5</td>
    <td>2 March</td>
    <td>Prac Test 1 (20%)</td>
  </tr>
  <tr>
    <td>10</td>
    <td>4 May</td>
    <td>Assignment (23:59 3rd May) (40%)</td>
  </tr>
</table>`;

describe("parsePcText", () => {
  it("returns one item per non-empty assessment cell", () => {
    const items = parsePcText(SAMPLE_PC_TEXT, "COMP1005", 1, 2026);
    expect(items).toHaveLength(2); // week 1 has "-", week 5 and week 10 have assessments
  });

  it("sets unit code and semester on all items", () => {
    const items = parsePcText(SAMPLE_PC_TEXT, "COMP1005", 1, 2026);
    expect(items.every((i) => i.unit === "COMP1005")).toBe(true);
    expect(items.every((i) => i.semester === 1)).toBe(true);
  });

  it("parses the title by stripping weight and time annotations", () => {
    const items = parsePcText(SAMPLE_PC_TEXT, "COMP1005", 1, 2026);
    expect(items[0].title).toBe("Prac Test 1");
    expect(items[1].title).toBe("Assignment");
  });

  it('extracts weight from "(N%)" annotation', () => {
    const items = parsePcText(SAMPLE_PC_TEXT, "COMP1005", 1, 2026);
    expect(items[0].weight).toBe(20);
    expect(items[1].weight).toBe(40);
  });

  it('extracts exactTime from "(HH:MM Date)" annotation', () => {
    const items = parsePcText(SAMPLE_PC_TEXT, "COMP1005", 1, 2026);
    expect(items[1].exactTime).toBe("23:59");
  });

  it("uses the Begin Date as the default resolved date", () => {
    const items = parsePcText(SAMPLE_PC_TEXT, "COMP1005", 1, 2026);
    // Week 5 Begin Date is 2 March 2026
    expect(items[0].resolvedDate!.getMonth()).toBe(2); // March = 2
    expect(items[0].resolvedDate!.getDate()).toBe(2);
  });

  it("sets isTBA to false for all items (they have begin dates)", () => {
    const items = parsePcText(SAMPLE_PC_TEXT, "COMP1005", 1, 2026);
    expect(items.every((i) => i.isTBA === false)).toBe(true);
  });

  it("sets weekLabel from the Week column", () => {
    const items = parsePcText(SAMPLE_PC_TEXT, "COMP1005", 1, 2026);
    expect(items[0].weekLabel).toBe("Week 5");
    expect(items[1].weekLabel).toBe("Week 10");
  });

  it("returns empty array for empty input", () => {
    expect(parsePcText("", "COMP1005", 1, 2026)).toEqual([]);
  });

  it("returns empty array when no Begin Date column and no TW-embedded dates", () => {
    // "5" alone in the TW cell is not a TW-embedded date (needs "5\n2 Mar" format)
    const noDateTable =
      "<table><tr><th>Week</th><th>Assessment</th></tr><tr><td>5</td><td>Quiz</td></tr></table>";
    expect(parsePcText(noDateTable, "COMP1005", 1, 2026)).toEqual([]);
  });
});

// ── parsePcText — TW-embedded date format (ELEN1000-style) ───────────────────

const TW_EMBEDDED_PC_TEXT = `
<table>
  <tr><th>TW</th><th>Topic</th><th>Lab</th><th>Tut. and Quiz</th></tr>
  <tr><td>1\n16 Feb</td><td>DC Circuits</td><td>0 Learning the ropes</td><td>0 About thinking</td></tr>
  <tr><td>Kirchoff laws</td><td>1.2, 2.1</td><td></td></tr>
  <tr><td>3\n2 Mar</td><td>AC Circuits</td><td>The Piano Project Part 1</td><td>2 DC analysis</td></tr>
  <tr><td>5\n16 Mar</td><td>Semiconductors</td><td>The Piano Project Part 2</td><td>4 AC analysis</td></tr>
</table>`;

describe("parsePcText — TW-embedded dates", () => {
  it("extracts Lab and Quiz items when TW cells carry embedded dates", () => {
    const items = parsePcText(TW_EMBEDDED_PC_TEXT, "ELEN1000", 1, 2026);
    expect(items.length).toBeGreaterThan(0);
  });

  it("skips continuation (sub) rows and uses the correct teaching-week date", () => {
    const items = parsePcText(TW_EMBEDDED_PC_TEXT, "ELEN1000", 1, 2026);
    // Week 1 begin date = 16 Feb
    const week1Lab = items.find(
      (i) => i.weekLabel === "Week 1" && i.title.startsWith("Lab"),
    );
    expect(week1Lab).toBeDefined();
    expect(week1Lab!.resolvedDate!.getMonth()).toBe(1); // February
    expect(week1Lab!.resolvedDate!.getDate()).toBe(16);
  });

  it("prefixes Lab items with 'Lab' for titlesOverlap matching", () => {
    const items = parsePcText(TW_EMBEDDED_PC_TEXT, "ELEN1000", 1, 2026);
    expect(items.some((i) => i.title.startsWith("Lab "))).toBe(true);
  });

  it("prefixes Quiz items with 'Quiz' for titlesOverlap matching", () => {
    const items = parsePcText(TW_EMBEDDED_PC_TEXT, "ELEN1000", 1, 2026);
    expect(items.some((i) => i.title.startsWith("Quiz "))).toBe(true);
  });

  it("only extracts Quiz items from full-width rows (alignment guard)", () => {
    const items = parsePcText(TW_EMBEDDED_PC_TEXT, "ELEN1000", 1, 2026);
    // Sub-row (Kirchoff row) has no Quiz cell — should not produce a Quiz item for week 1 extra
    const quizItems = items.filter((i) => i.title.startsWith("Quiz"));
    // Expect exactly 3 quiz items (weeks 1, 3, 5) — not 4 (the sub-row must be skipped)
    expect(quizItems).toHaveLength(3);
  });

  it("sets weekLabel correctly on TW-embedded items", () => {
    const items = parsePcText(TW_EMBEDDED_PC_TEXT, "ELEN1000", 1, 2026);
    const week3Lab = items.find(
      (i) => i.weekLabel === "Week 3" && i.title.startsWith("Lab"),
    );
    expect(week3Lab).toBeDefined();
    expect(week3Lab!.resolvedDate!.getDate()).toBe(2); // 2 Mar
  });

  it("TW-embedded quiz items are dated (have resolvedDate) regardless of AS_TASK matching", () => {
    // parsePcText extracts dated items from TW-embedded mode; they have
    // isTBA=false because they carry a resolvedDate from the TW cell.
    // Weight propagation from "Online tests" is intentionally not attempted —
    // the quiz↔test synonym was removed because it caused false positives
    // (e.g. "Mid-Sem Test" matching "Workshop Quiz").
    const outline: UobOutline = {
      UnitNumber: "ELEN1000",
      Title: "Electrical Systems",
      Avail_Study_Period: "Semester 1",
      Avail_Year: "2026",
      AS_TASK: "1| Online tests| 10 percent|",
      PC_TEXT: TW_EMBEDDED_PC_TEXT,
    };
    const items = outlineToDeadlines(outline, "ELEN1000", 1, 2026);
    const datedItems = items.filter((i) => !i.isTBA);
    expect(datedItems.length).toBeGreaterThan(0);
  });
});

// ── outlineToDeadlines ────────────────────────────────────────────────────────

describe("outlineToDeadlines", () => {
  const OUTLINE: UobOutline = {
    UnitNumber: "COMP1005",
    Title: "Fundamentals of Programming",
    Avail_Study_Period: "Semester 1",
    Avail_Year: "2026",
    AS_TASK:
      "1| Prac Test| 20 percent|;\n2| Final Examination| 40 percent|;\n3| Assignment| 40 percent|",
    PC_TEXT: SAMPLE_PC_TEXT, // Prac Test 1 (20%), Assignment (40%) in table
  };

  it("returns items from both PC_TEXT and AS_TASK (TBA fallback)", () => {
    const items = outlineToDeadlines(OUTLINE, "COMP1005", 1, 2026);
    // PC_TEXT: Prac Test 1, Assignment (2 items)
    // AS_TASK TBA fallback: Final Examination (not in calendar)
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it("adds TBA item for AS_TASK entries not found in PC_TEXT", () => {
    const items = outlineToDeadlines(OUTLINE, "COMP1005", 1, 2026);
    const tba = items.filter((i) => i.isTBA);
    // Final Examination is in AS_TASK but not in the calendar → TBA
    expect(tba.some((i) => /final/i.test(i.title))).toBe(true);
  });

  it("propagates AS_TASK outcomes to matched PC_TEXT items", () => {
    const outline: UobOutline = {
      ...OUTLINE,
      AS_TASK: "1| Prac Test| 20 percent| ULOs assessed 2|3|",
      PC_TEXT: `<table>
        <tr><th>Begin Date</th><th>Assessment</th></tr>
        <tr><td>2 March</td><td>Prac Test 1</td></tr>
      </table>`,
    };
    const items = outlineToDeadlines(outline, "COMP1005", 1, 2026);
    const prac = items.find((i) => /prac/i.test(i.title));
    expect(prac?.outcomes).toBe("2,3");
  });

  it("includes outcomes on TBA fallback items", () => {
    const outline: UobOutline = {
      ...OUTLINE,
      AS_TASK: "1| Final Examination| 40 percent| ULOs assessed 1|2|3|4|",
      PC_TEXT: `<table>
        <tr><th>Begin Date</th><th>Assessment</th></tr>
      </table>`,
    };
    const items = outlineToDeadlines(outline, "COMP1005", 1, 2026);
    const tba = items.find((i) => /final/i.test(i.title));
    expect(tba?.isTBA).toBe(true);
    expect(tba?.outcomes).toBe("1,2,3,4");
  });

  it("propagates AS_TASK weight to matched PC_TEXT items without weight annotation", () => {
    // Create an outline where the calendar cell has no "(N%)" tag but AS_TASK has a weight
    const outline: UobOutline = {
      ...OUTLINE,
      AS_TASK: "1| Prac Test| 20 percent|",
      PC_TEXT: `<table>
        <tr><th>Begin Date</th><th>Assessment</th></tr>
        <tr><td>2 March</td><td>Prac Test 1</td></tr>
      </table>`,
    };
    const items = outlineToDeadlines(outline, "COMP1005", 1, 2026);
    const prac = items.find((i) => /prac/i.test(i.title));
    expect(prac).toBeDefined();
    expect(prac!.weight).toBe(20);
  });

  it("resolves date from week hint when AS_TASK item appears in a non-assessment column", () => {
    // "Mid-Sem Test" is in the Lecture/Workshop column (not Assessment Due) at week 5.
    // parsePcText skips that column, so outlineToDeadlines falls back to AS_TASK.
    // buildWeekHints finds it via the Lecture/Workshop column and supplies week 5.
    // outlineToDeadlines should use weekToDate(5) → 16 Mar 2026 and set isTBA=false.
    const outline: UobOutline = {
      ...OUTLINE,
      AS_TASK: "1| Mid-Sem Test| 45 percent|",
      PC_TEXT: `<table>
        <tr><th>Week</th><th>Begin Date</th><th>Lecture/Workshop</th><th>Assessment Due</th></tr>
        <tr><td>5.</td><td>16 March</td><td>Mid-Semester Test</td><td></td></tr>
      </table>`,
    };
    const items = outlineToDeadlines(outline, "COMP1005", 1, 2026);
    const midSem = items.find((i) => /mid/i.test(i.title));
    expect(midSem).toBeDefined();
    expect(midSem!.isTBA).toBe(false);
    // weekToDate(1, 2026, 5) = 16 Mar 2026
    expect(midSem!.resolvedDate?.getMonth()).toBe(2); // March
    expect(midSem!.resolvedDate?.getDate()).toBe(16);
    expect(midSem!.weekLabel).toBe("Week 5");
  });

  it("does not let a bare 'test' keyword match a 3-word title like 'Mid-Semester Test'", () => {
    // Regression: 'E-Test' words-reduces to ['test'], which strategy-3 was
    // incorrectly matching against 'Mid-Semester Test'.  The guard
    // (longWords.length > 2 → false) prevents this; weights must not be divided.
    const outline: UobOutline = {
      ...OUTLINE,
      AS_TASK: "1| Mid-Sem Test| 45 percent|;\n2| E-Test| 10 percent|",
      PC_TEXT: `<table>
        <tr><th>Begin Date</th><th>Assessment Due</th></tr>
        <tr><td>16 March</td><td>Mid-Semester Test</td></tr>
        <tr><td>18 May</td><td>eTest</td></tr>
      </table>`,
    };
    const items = outlineToDeadlines(outline, "COMP1005", 1, 2026);
    const midSem = items.find((i) => /mid/i.test(i.title));
    const eTest = items.find((i) => /etest/i.test(i.title));
    // Each should carry the full AS_TASK weight (no cross-matching → no division)
    expect(midSem?.weight).toBe(45);
    expect(eTest?.weight).toBe(10);
  });

  it("divides AS_TASK group weight equally when one entry matches multiple PC items", () => {
    // "Worksheets" (36%) matches 3 worksheet items — each should get 36/3 = 12%,
    // not the full 36% (which would inflate the sum to 108%).
    const outline: UobOutline = {
      ...OUTLINE,
      AS_TASK: "1| Worksheets| 36 percent|",
      PC_TEXT: `<table>
        <tr><th>Begin Date</th><th>Assessment</th></tr>
        <tr><td>2 March</td><td>Worksheet R1</td></tr>
        <tr><td>9 March</td><td>Worksheet M1</td></tr>
        <tr><td>16 March</td><td>Worksheet P1</td></tr>
      </table>`,
    };
    const items = outlineToDeadlines(outline, "PRRE1003", 1, 2026);
    const worksheets = items.filter((i) => /worksheet/i.test(i.title));
    expect(worksheets).toHaveLength(3);
    // 36 / 3 = 12 each; sum stays at 36
    expect(worksheets.every((w) => w.weight === 12)).toBe(true);
  });
});
