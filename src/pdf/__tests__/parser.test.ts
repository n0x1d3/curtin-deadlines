// ── Tests: pdf/parser.ts ──────────────────────────────────────────────────────
// Covers the four pure/testable functions: parseUnitName, parseAssessments,
// parseProgramCalendar, mergeWithCalendar, addSequenceNumbers.
// initPdfWorker and extractPDFText are excluded (require pdf.js worker + File).

import { describe, it, expect } from "vitest";
import {
  parseUnitName,
  parseAssessments,
  parseProgramCalendar,
  mergeWithCalendar,
  addSequenceNumbers,
} from "..";
import type { PendingDeadline } from "../../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal PendingDeadline fixture — supply only what each test needs. */
function pending(
  overrides: Pick<PendingDeadline, "title" | "unit" | "isTBA"> &
    Partial<PendingDeadline>,
): PendingDeadline {
  return { semester: 1, year: 2026, ...overrides };
}

// ── parseUnitName ─────────────────────────────────────────────────────────────

describe("parseUnitName", () => {
  it("extracts the unit name from a (V. #) delimiter line", () => {
    const text =
      "COMP # # # #   (V. # ) Introduction to Computing\nOther content";
    expect(parseUnitName(text, "COMP1005")).toBe("Introduction to Computing");
  });

  it("strips '#' null-byte placeholders from the captured name", () => {
    // '#' chars embedded in the name itself are stripped and spaces collapsed
    const text = "COMP # # # #   (V. # ) Fundamentals of ## Computing\nFooter";
    expect(parseUnitName(text, "COMP1005")).toBe("Fundamentals of Computing");
  });

  it("handles multi-digit version numbers as well as '#' placeholders", () => {
    const text = "UNIT # # # #   (V. 12) Advanced Networking Systems\nContent";
    expect(parseUnitName(text, "UNIT1234")).toBe("Advanced Networking Systems");
  });

  it("returns undefined when the (V.) delimiter is absent", () => {
    const text = "COMP1005\nIntroduction to Computing\nSchool of EECMS";
    expect(parseUnitName(text, "COMP1005")).toBeUndefined();
  });

  it("returns undefined when unitCode is empty", () => {
    const text = "COMP # # # #   (V. # ) Introduction to Computing";
    expect(parseUnitName(text, "")).toBeUndefined();
  });

  it("does not find a name placed after the first 20 header lines", () => {
    // Pad 21 blank lines before the real unit name line — parser only scans first 20 non-empty lines
    const padding = Array.from({ length: 21 }, (_, i) => `Line ${i + 1}`);
    const text = [...padding, "COMP # # # #   (V. # ) Late Name"].join("\n");
    expect(parseUnitName(text, "COMP1005")).toBeUndefined();
  });

  it("rejects candidates that are shorter than 5 characters", () => {
    // "AB" is too short to be a real unit name
    const text = "COMP # # # #   (V. # ) AB\nOther";
    expect(parseUnitName(text, "COMP1005")).toBeUndefined();
  });

  it("rejects candidates with no space (single-word names)", () => {
    const text = "COMP # # # #   (V. # ) Computing\nOther";
    expect(parseUnitName(text, "COMP1005")).toBeUndefined();
  });
});

// ── parseAssessments ──────────────────────────────────────────────────────────

describe("parseAssessments — basic extraction", () => {
  it("extracts title, weight, exact date, and time from a standard entry", () => {
    const text = [
      "Assessment Schedule",
      "Some Assignment",
      "50 %",
      "Week: Week 5",
      "Day: 3rd May",
      "Time: 23:59",
    ].join("\n");

    const results = parseAssessments(text, "COMP1005", 2026, 1);
    expect(results).toHaveLength(1);

    const item = results[0];
    expect(item.title).toBe("Some Assignment");
    expect(item.unit).toBe("COMP1005");
    expect(item.weight).toBe(50);
    expect(item.exactDay).toBe("3rd May");
    expect(item.exactTime).toBe("23:59");
    expect(item.isTBA).toBe(false);
    // resolvedDate should be May 3 at 23:59
    expect(item.resolvedDate?.getMonth()).toBe(4); // May
    expect(item.resolvedDate?.getDate()).toBe(3);
    expect(item.resolvedDate?.getHours()).toBe(23);
    expect(item.resolvedDate?.getMinutes()).toBe(59);
  });

  it("resolves date from week number when no exact Day: is present", () => {
    const text = [
      "Assessment Schedule",
      "Online Quiz",
      "10 %",
      "Week: Week 3",
      "Day: TBA",
      "Time: TBA",
    ].join("\n");

    // Day:TBA makes isTBA=true — check the weekLabel is still captured
    const results = parseAssessments(text, "COMP1005", 2026, 1);
    expect(results).toHaveLength(1);
    expect(results[0].isTBA).toBe(true);
    expect(results[0].weekLabel).toBe("Week 3");
  });

  it("sets isTBA when both Week: and Day: are TBA", () => {
    const text = [
      "Assessment Schedule",
      "Final Exam",
      "50 %",
      "Week: TBA",
      "Day: TBA",
      "Time: TBA",
    ].join("\n");

    const results = parseAssessments(text, "COMP1005", 2026, 1);
    expect(results).toHaveLength(1);
    expect(results[0].isTBA).toBe(true);
    expect(results[0].resolvedDate).toBeUndefined();
  });

  it("sets isTBA when Week: is empty", () => {
    const text = [
      "Assessment Schedule",
      "Unknown Task",
      "10 %",
      "Week:",
      "Day: TBA",
      "Time: TBA",
    ].join("\n");

    const results = parseAssessments(text, "COMP1005", 2026, 1);
    expect(results).toHaveLength(1);
    expect(results[0].isTBA).toBe(true);
  });

  it("strips a leading item number from the title (e.g. '3 Final Exam' → 'Final Exam')", () => {
    const text = [
      "Assessment Schedule",
      "3 Final Exam",
      "40 %",
      "Week: TBA",
      "Day: TBA",
      "Time: TBA",
    ].join("\n");

    const results = parseAssessments(text, "COMP1005", 2026, 1);
    expect(results[0].title).toBe("Final Exam");
  });

  it("strips (x N) repeat-count annotation with decoded digits", () => {
    // Before null-byte decoding: "(x #)"; after decoding: "(x 5 )"
    const text = [
      "Assessment Schedule",
      "Laboratory Report (x 5 )",
      "35 %",
      "Week: TBA",
      "Day: TBA",
      "Time: TBA",
    ].join("\n");

    const results = parseAssessments(text, "ELEN1000", 2026, 1);
    expect(results[0].title).toBe("Laboratory Report");
  });

  it("passes semester and year through to results", () => {
    const text = [
      "Assessment Schedule",
      "Lab Test",
      "20 %",
      "Week: Week 2",
      "Day: TBA",
      "Time: TBA",
    ].join("\n");

    const results = parseAssessments(text, "MATH1019", 2027, 2);
    expect(results[0].unit).toBe("MATH1019");
    expect(results[0].semester).toBe(2);
    expect(results[0].year).toBe(2027);
  });
});

describe("parseAssessments — PM time parsing", () => {
  it("converts PM times correctly (e.g. 5.00 PM → 17:00)", () => {
    const text = [
      "Assessment Schedule",
      "Report",
      "30 %",
      "Week: Week 6",
      "Day: 15th June",
      "Time: 5.00 PM",
    ].join("\n");

    const results = parseAssessments(text, "COMP1005", 2026, 1);
    expect(results[0].resolvedDate?.getHours()).toBe(17);
    expect(results[0].resolvedDate?.getMinutes()).toBe(0);
  });
});

describe("parseAssessments — null-byte '#' date placeholders", () => {
  it("resolves '#rd May' (single hash) as May 3", () => {
    const text = [
      "Assessment Schedule",
      "Report",
      "20 %",
      "Week: Week 3",
      "Day: #rd May",
      "Time: 23:59",
    ].join("\n");

    const item = parseAssessments(text, "COMP1005", 2026, 1)[0];
    expect(item.resolvedDate?.getMonth()).toBe(4); // May
    expect(item.resolvedDate?.getDate()).toBe(3);
  });

  it("resolves '##nd August' (double hash) as August 22", () => {
    const text = [
      "Assessment Schedule",
      "Final Report",
      "30 %",
      "Week: Week 10",
      "Day: ##nd August",
      "Time: 23:59",
    ].join("\n");

    const item = parseAssessments(text, "COMP1005", 2026, 1)[0];
    expect(item.resolvedDate?.getMonth()).toBe(7); // August
    expect(item.resolvedDate?.getDate()).toBe(22);
  });

  it("resolves '# #rd June' (spaced double hash) as June 23", () => {
    const text = [
      "Assessment Schedule",
      "Portfolio",
      "25 %",
      "Week: Week 8",
      "Day: # #rd June",
      "Time: 23:59",
    ].join("\n");

    const item = parseAssessments(text, "COMP1005", 2026, 1)[0];
    expect(item.resolvedDate?.getMonth()).toBe(5); // June
    expect(item.resolvedDate?.getDate()).toBe(23);
  });
});

describe("parseAssessments — multi-week expansion", () => {
  it("expands a comma-separated week list into one item per week", () => {
    const text = [
      "Assessment Schedule",
      "Lab Report",
      "10 %",
      "Week: Teaching weeks 3,5,7",
      "Day: After class",
      "Time: 23:59",
    ].join("\n");

    const results = parseAssessments(text, "COMP1005", 2026, 1);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.week)).toEqual([3, 5, 7]);
    expect(results.every((r) => r.title === "Lab Report")).toBe(true);
    expect(results.every((r) => !r.isTBA)).toBe(true);
  });

  it("expands a week range into one item per week", () => {
    const text = [
      "Assessment Schedule",
      "Workshop Report",
      "5 %",
      "Week: Weeks 2-4",
      "Day: After class",
      "Time: 23:59",
    ].join("\n");

    const results = parseAssessments(text, "COMP1005", 2026, 1);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.week)).toEqual([2, 3, 4]);
  });

  it("sets resolvedDate to weekToDate result for each expanded week", () => {
    const text = [
      "Assessment Schedule",
      "Weekly Quiz",
      "5 %",
      "Week: Weeks 1-2",
      "Day: After class",
      "Time: 23:59",
    ].join("\n");

    const results = parseAssessments(text, "COMP1005", 2026, 1);
    // Week 1 S1 2026 = Feb 16; week 2 = Feb 23
    expect(results[0].resolvedDate?.getMonth()).toBe(1); // Feb
    expect(results[0].resolvedDate?.getDate()).toBe(16);
    expect(results[1].resolvedDate?.getDate()).toBe(23);
  });
});

describe("parseAssessments — outcomes and late/extension capture", () => {
  // Meta values (outcomes, late, ext) appear between Day: and Time: in the
  // extracted PDF text — the PDF renderer groups right-columns for ALL rows
  // into a single block before the first Time: label.

  it("captures outcomes and combined Yes/No late+extension (between Day: and Time:)", () => {
    const text = [
      "Assessment Schedule",
      "Assignment",
      "40 %",
      "Week: Week 11",
      "Day: 3rd May",
      "1,2,4", // meta block: outcomes
      "Yes Yes", // meta block: late + ext combined
      "Time: 23:59",
    ].join("\n");

    const item = parseAssessments(text, "COMP1005", 2026, 1)[0];
    expect(item.outcomes).toBe("1,2,4");
    expect(item.lateAccepted).toBe(true);
    expect(item.extensionConsidered).toBe(true);
  });

  it("captures separate Yes/No lines for late and extension", () => {
    const text = [
      "Assessment Schedule",
      "Final Examination",
      "40 %",
      "Week: Examination Period",
      "Day: TBA",
      "1,2,3,4", // meta block: outcomes
      "No", // meta block: late
      "Yes", // meta block: ext
      "Time: TBA",
    ].join("\n");

    const item = parseAssessments(text, "COMP1005", 2026, 1)[0];
    expect(item.outcomes).toBe("1,2,3,4");
    expect(item.lateAccepted).toBe(false);
    expect(item.extensionConsidered).toBe(true);
  });

  it("captures No Yes combined on one line", () => {
    const text = [
      "Assessment Schedule",
      "Mid-Sem Test",
      "45 %",
      "Week: 5",
      "Day: TBC",
      "3,5", // meta block: outcomes
      "No Yes", // meta block: late + ext combined
      "Time: TBC",
    ].join("\n");

    const item = parseAssessments(text, "MATH1019", 2026, 1)[0];
    expect(item.outcomes).toBe("3,5");
    expect(item.lateAccepted).toBe(false);
    expect(item.extensionConsidered).toBe(true);
  });

  it("leaves outcomes/lateAccepted/extensionConsidered undefined when not present", () => {
    const text = [
      "Assessment Schedule",
      "Quiz",
      "10 %",
      "Week: Week 3",
      "Day: TBA",
      "Time: TBA",
    ].join("\n");

    const item = parseAssessments(text, "COMP1005", 2026, 1)[0];
    expect(item.outcomes).toBeUndefined();
    expect(item.lateAccepted).toBeUndefined();
    expect(item.extensionConsidered).toBeUndefined();
  });

  it("propagates outcomes to all expanded weeks in a multi-week item", () => {
    const text = [
      "Assessment Schedule",
      "Lab Report",
      "20 %",
      "Week: Weeks 3,5,7",
      "Day: After class",
      "2,3", // meta block: outcomes
      "Yes Yes", // meta block: late + ext combined
      "Time: 23:59",
    ].join("\n");

    const results = parseAssessments(text, "COMP1005", 2026, 1);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.outcomes === "2,3")).toBe(true);
    expect(results.every((r) => r.lateAccepted === true)).toBe(true);
    expect(results.every((r) => r.extensionConsidered === true)).toBe(true);
  });
});

describe("parseAssessments — isTBAValue detection", () => {
  it.each([
    "Exam week",
    "Examination period",
    "TBA",
    "TBC",
    "Flexible submission",
    "As per schedule",
    "Fortnightly",
    "Weekly submission",
  ])('marks isTBA=true for Day value "%s"', (day) => {
    const text = [
      "Assessment Schedule",
      "Task",
      "10 %",
      "Week: Week 3",
      `Day: ${day}`,
      "Time: TBA",
    ].join("\n");
    expect(parseAssessments(text, "COMP1005", 2026, 1)[0].isTBA).toBe(true);
  });

  it("resolves an exact Day: date even when Week: is a descriptive TBA phrase", () => {
    // Regression: "Week: Study week" triggered isTBAValue, marking the item TBA
    // even though "Day: 29 May 2026" contains a concrete calendar date.
    const text = [
      "Assessment Schedule",
      "Final examination",
      "45 %",
      "Week: Study week",
      "Day: 29 May 2026",
      "Time: 1 pm",
    ].join("\n");
    const item = parseAssessments(text, "ELEN1000", 2026, 1)[0];
    expect(item.isTBA).toBe(false);
    expect(item.resolvedDate?.getFullYear()).toBe(2026);
    expect(item.resolvedDate?.getMonth()).toBe(4); // May = index 4
    expect(item.resolvedDate?.getDate()).toBe(29);
  });
});

// ── parseProgramCalendar ──────────────────────────────────────────────────────

describe("parseProgramCalendar", () => {
  it("returns empty array when no 'Program Calendar' section exists", () => {
    expect(
      parseProgramCalendar("Some unrelated text", "COMP1005", 2026, 1),
    ).toEqual([]);
  });

  it("extracts a known assessment keyword from a week row", () => {
    const text = [
      "Program Calendar",
      "1 . 1 Feb Lectures only",
      "2 . 8 Feb Quiz",
    ].join("\n");

    const results = parseProgramCalendar(text, "COMP1005", 2026, 1);
    expect(results.some((r) => r.title === "Quiz" && r.week === 2)).toBe(true);
  });

  it("does not produce results for weeks with no matching keywords", () => {
    const text = ["Program Calendar", "1 . 1 Feb Lectures and tutorial"].join(
      "\n",
    );

    expect(parseProgramCalendar(text, "COMP1005", 2026, 1)).toHaveLength(0);
  });

  it("non-teaching rows increment calendarWeekCount so subsequent weeks get the correct number", () => {
    // Week 3 is Study Week (non-teaching) — week 4 must still be labelled week 4, not 3
    const text = [
      "Program Calendar",
      "1 . 1 Feb Teaching",
      "2 . 8 Feb Teaching",
      "3 . 15 Feb Study Week",
      "4 . 22 Feb Quiz",
    ].join("\n");

    const results = parseProgramCalendar(text, "COMP1005", 2026, 1);
    const quiz = results.find((r) => r.title === "Quiz");
    expect(quiz).toBeDefined();
    expect(quiz!.week).toBe(4);
  });

  it("does not produce results for non-teaching (Study Week) rows", () => {
    const text = ["Program Calendar", "1 . 1 Feb Study Week"].join("\n");

    expect(parseProgramCalendar(text, "COMP1005", 2026, 1)).toHaveLength(0);
  });

  it("extracts multiple assessment types from one week row", () => {
    const text = [
      "Program Calendar",
      "1 . 1 Feb Assignment and Quiz submission",
    ].join("\n");

    const results = parseProgramCalendar(text, "COMP1005", 2026, 1);
    const titles = results.map((r) => r.title);
    expect(titles).toContain("Assignment");
    expect(titles).toContain("Quiz");
  });

  it("deduplicates the same title+unit+week within a single week row", () => {
    // "Quiz Quiz" should not produce two Quiz items for the same week
    const text = ["Program Calendar", "1 . 1 Feb Quiz Quiz"].join("\n");

    const results = parseProgramCalendar(text, "COMP1005", 2026, 1);
    expect(results.filter((r) => r.title === "Quiz")).toHaveLength(1);
  });

  it("sets resolvedDate relative to semester start (not a fixed date)", () => {
    // S1 2026 starts Feb 16 — week 1 row date = Feb 16
    const text = ["Program Calendar", "1 . 1 Feb Quiz"].join("\n");

    const results = parseProgramCalendar(text, "COMP1005", 2026, 1);
    expect(results[0].resolvedDate?.getMonth()).toBe(1); // Feb
    expect(results[0].resolvedDate?.getDate()).toBe(16);
  });
});

// ── mergeWithCalendar ─────────────────────────────────────────────────────────

describe("mergeWithCalendar", () => {
  it("upgrades a TBA schedule item when a calendar item title matches", () => {
    const schedule = [
      pending({ title: "Quiz", unit: "COMP1005", isTBA: true }),
    ];
    const calendar = [
      pending({
        title: "Quiz",
        unit: "COMP1005",
        week: 3,
        weekLabel: "Week 3",
        resolvedDate: new Date(2026, 1, 16),
        isTBA: false,
        calSource: true,
      }),
    ];

    const result = mergeWithCalendar(schedule, calendar);
    expect(result).toHaveLength(1);
    expect(result[0].isTBA).toBe(false);
    expect(result[0].week).toBe(3);
    // Calendar title takes priority
    expect(result[0].title).toBe("Quiz");
  });

  it("appends a calendar item when no TBA match exists in the schedule", () => {
    const schedule = [
      pending({
        title: "Assignment",
        unit: "COMP1005",
        isTBA: false,
        resolvedDate: new Date(2026, 4, 3),
      }),
    ];
    const calendar = [
      pending({
        title: "Quiz",
        unit: "COMP1005",
        week: 2,
        weekLabel: "Week 2",
        resolvedDate: new Date(2026, 1, 23),
        isTBA: false,
        calSource: true,
      }),
    ];

    const result = mergeWithCalendar(schedule, calendar);
    expect(result).toHaveLength(2);
  });

  it("does not append a calendar item that duplicates an already-resolved schedule item for the same week", () => {
    const schedule = [
      pending({
        title: "Quiz",
        unit: "COMP1005",
        week: 3,
        isTBA: false,
        resolvedDate: new Date(2026, 2, 2),
      }),
    ];
    const calendar = [
      pending({
        title: "Quiz",
        unit: "COMP1005",
        week: 3,
        weekLabel: "Week 3",
        resolvedDate: new Date(2026, 2, 2),
        isTBA: false,
        calSource: true,
      }),
    ];

    const result = mergeWithCalendar(schedule, calendar);
    expect(result).toHaveLength(1);
  });

  it("does not append a calendar item whose date is within 3 days of an existing resolved item (off-by-one-day dedup)", () => {
    // Schedule has Assignment due Sunday May 3; calendar places it in week 12 starting Mon May 4.
    // These represent the same deadline — the 1-day gap should suppress the calendar append.
    const schedule = [
      pending({
        title: "Assignment",
        unit: "COMP1005",
        week: 11,
        isTBA: false,
        resolvedDate: new Date(2026, 4, 3), // Sun May 3
      }),
    ];
    const calendar = [
      pending({
        title: "Assignment",
        unit: "COMP1005",
        week: 12,
        weekLabel: "Week 12",
        resolvedDate: new Date(2026, 4, 4), // Mon May 4
        isTBA: false,
        calSource: true,
      }),
    ];

    const result = mergeWithCalendar(schedule, calendar);
    expect(result).toHaveLength(1);
    // Keeps the schedule item (which has the exact due date, not the calendar week start)
    expect(result[0].week).toBe(11);
  });

  it("inherits weight from an existing resolved item when appending a calendar-only instance", () => {
    // Schedule has one TBA Practical Test with 20%; calendar has 5 occurrences.
    // After merging, the first calendar item upgrades the TBA entry.
    // Items 2-5 should be appended and should inherit the 20% weight.
    const schedule = [
      pending({
        title: "Practical Test",
        unit: "COMP1005",
        isTBA: true,
        weight: 20,
      }),
    ];
    const calWeeks = [3, 5, 7, 11, 13];
    const calendar = calWeeks.map((w) =>
      pending({
        title: "Practical Test",
        unit: "COMP1005",
        week: w,
        weekLabel: `Week ${w}`,
        resolvedDate: new Date(2026, 1, w * 7), // arbitrary
        isTBA: false,
        calSource: true,
      }),
    );

    const result = mergeWithCalendar(schedule, calendar);
    const numbered = addSequenceNumbers(result);
    expect(numbered).toHaveLength(5);
    expect(numbered.every((r) => r.weight === 20)).toBe(true);
  });

  it("matches 'Sem Test' to 'Semester Test' via the Sem→Semester normalisation", () => {
    // norm() expands \bSem\b → Semester before comparing
    const schedule = [
      pending({ title: "Semester Test", unit: "COMP1005", isTBA: true }),
    ];
    const calendar = [
      pending({
        title: "Sem Test",
        unit: "COMP1005",
        week: 5,
        weekLabel: "Week 5",
        resolvedDate: new Date(2026, 2, 16),
        isTBA: false,
        calSource: true,
      }),
    ];

    const result = mergeWithCalendar(schedule, calendar);
    expect(result).toHaveLength(1);
    expect(result[0].isTBA).toBe(false);
  });

  it("matches when one title contains the other (prefix relationship)", () => {
    // "Lab Report" ⊂ "Lab Report — Week 3" via titlesMatch's includes() check
    const schedule = [
      pending({ title: "Lab Report", unit: "COMP1005", isTBA: true }),
    ];
    const calendar = [
      pending({
        title: "Lab Report",
        unit: "COMP1005",
        week: 4,
        resolvedDate: new Date(2026, 2, 9),
        isTBA: false,
        calSource: true,
      }),
    ];

    const result = mergeWithCalendar(schedule, calendar);
    expect(result).toHaveLength(1);
    expect(result[0].week).toBe(4);
  });

  it("does not match TBA items when titles are unrelated", () => {
    // Different titles — TBA not upgraded; calendar item appended as new
    const schedule = [
      pending({ title: "Assignment", unit: "COMP1005", isTBA: true }),
    ];
    const calendar = [
      pending({
        title: "Quiz",
        unit: "COMP1005",
        week: 3,
        resolvedDate: new Date(2026, 2, 2),
        isTBA: false,
        calSource: true,
      }),
    ];

    const result = mergeWithCalendar(schedule, calendar);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.title === "Assignment")?.isTBA).toBe(true);
    expect(result.find((r) => r.title === "Quiz")?.isTBA).toBe(false);
  });

  it("matches a ligature-broken title to its correct form via fuzzy gap matching", () => {
    // Regression: PDF null-byte ligature extraction produces "Reection Task"
    // (the 'fl' glyph was a null byte → stripped → gap). The fuzzy ligature check
    // allows a gap of 1–3 chars starting with 'f'/'s' to bridge the difference.
    const schedule = [
      pending({ title: "Reection Task", unit: "ELEN1000", isTBA: true }),
    ];
    const calendar = [
      pending({
        title: "Reflection Task",
        unit: "ELEN1000",
        week: 13,
        weekLabel: "Study week",
        resolvedDate: new Date(2026, 4, 22),
        isTBA: false,
        calSource: true,
      }),
    ];

    const result = mergeWithCalendar(schedule, calendar);
    expect(result).toHaveLength(1);
    expect(result[0].isTBA).toBe(false);
    // Calendar title wins
    expect(result[0].title).toBe("Reflection Task");
  });

  it("does not fuzzy-match unrelated titles that happen to have a length-2 gap", () => {
    // "Test And Quiz" vs "Test Quiz" — gap = "An" (does not start with f/s) → no match
    const schedule = [
      pending({ title: "Test Quiz", unit: "COMP1005", isTBA: true }),
    ];
    const calendar = [
      pending({
        title: "Test And Quiz",
        unit: "COMP1005",
        week: 3,
        resolvedDate: new Date(2026, 2, 2),
        isTBA: false,
        calSource: true,
      }),
    ];

    const result = mergeWithCalendar(schedule, calendar);
    // No match — both items kept separately
    expect(result).toHaveLength(2);
  });
});

// ── addSequenceNumbers ────────────────────────────────────────────────────────

describe("addSequenceNumbers", () => {
  it("leaves a single-occurrence item title unchanged", () => {
    const items = [
      pending({ title: "Assignment", unit: "COMP1005", isTBA: false }),
    ];
    expect(addSequenceNumbers(items)[0].title).toBe("Assignment");
  });

  it("numbers items when the same base title appears 2+ times in a unit", () => {
    const items = [
      pending({ title: "Quiz", unit: "COMP1005", isTBA: false }),
      pending({ title: "Quiz", unit: "COMP1005", isTBA: false }),
      pending({ title: "Quiz", unit: "COMP1005", isTBA: false }),
    ];
    const result = addSequenceNumbers(items);
    expect(result.map((r) => r.title)).toEqual(["Quiz 1", "Quiz 2", "Quiz 3"]);
  });

  it("does not number when a title appears once per unit even if it appears in multiple units", () => {
    // COMP1005 has 1 quiz, MATH1019 has 1 quiz — neither should be numbered
    const items = [
      pending({ title: "Quiz", unit: "COMP1005", isTBA: false }),
      pending({ title: "Quiz", unit: "MATH1019", isTBA: false }),
    ];
    const result = addSequenceNumbers(items);
    expect(result[0].title).toBe("Quiz");
    expect(result[1].title).toBe("Quiz");
  });

  it("numbers each unit's recurring title independently", () => {
    // Both units have 2 quizzes — each numbered starting from 1
    const items = [
      pending({ title: "Quiz", unit: "COMP1005", isTBA: false }),
      pending({ title: "Quiz", unit: "MATH1019", isTBA: false }),
      pending({ title: "Quiz", unit: "COMP1005", isTBA: false }),
      pending({ title: "Quiz", unit: "MATH1019", isTBA: false }),
    ];
    const result = addSequenceNumbers(items);
    expect(result[0].title).toBe("Quiz 1"); // COMP1005 #1
    expect(result[1].title).toBe("Quiz 1"); // MATH1019 #1
    expect(result[2].title).toBe("Quiz 2"); // COMP1005 #2
    expect(result[3].title).toBe("Quiz 2"); // MATH1019 #2
  });

  it("preserves all other item fields when numbering", () => {
    const items = [
      pending({ title: "Lab Report", unit: "COMP1005", isTBA: false, week: 3 }),
      pending({ title: "Lab Report", unit: "COMP1005", isTBA: false, week: 7 }),
    ];
    const result = addSequenceNumbers(items);
    expect(result[0].week).toBe(3);
    expect(result[1].week).toBe(7);
  });

  it("does not mutate the original items array", () => {
    const original = "Original Title";
    const items = [
      pending({ title: original, unit: "COMP1005", isTBA: false }),
      pending({ title: original, unit: "COMP1005", isTBA: false }),
    ];
    addSequenceNumbers(items);
    expect(items[0].title).toBe(original);
  });
});
