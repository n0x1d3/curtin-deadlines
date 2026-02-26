// ── Tests: domain/deadlines.ts ────────────────────────────────────────────────
// All functions are pure and have no side effects — no mocking needed.

import { describe, it, expect } from "vitest";
import {
  seriesKey,
  parseWeekInput,
  isFinalExamType,
  extractSingleWeek,
  buildDeadlineSections,
} from "../deadlines";
import type { Deadline } from "../../types";

// ── seriesKey ─────────────────────────────────────────────────────────────────

describe("seriesKey", () => {
  it("strips trailing number from title so numbered items share a key", () => {
    expect(seriesKey("COMP1005", "Practical Test 1")).toBe(
      "COMP1005|Practical Test",
    );
    expect(seriesKey("COMP1005", "Practical Test 3")).toBe(
      "COMP1005|Practical Test",
    );
  });

  it("keeps the full title when there is no trailing number", () => {
    expect(seriesKey("COMP1005", "Final Examination")).toBe(
      "COMP1005|Final Examination",
    );
    expect(seriesKey("MATH1019", "Assignment")).toBe("MATH1019|Assignment");
  });

  it("uses the unit code as namespace so different units never share a key", () => {
    const a = seriesKey("COMP1005", "Lab Report 1");
    const b = seriesKey("MATH1019", "Lab Report 1");
    expect(a).not.toBe(b);
  });

  it("handles a single-word title without trailing number", () => {
    expect(seriesKey("ELEN1000", "Quiz")).toBe("ELEN1000|Quiz");
  });
});

// ── parseWeekInput ────────────────────────────────────────────────────────────

describe("parseWeekInput", () => {
  it("parses a single week number", () => {
    expect(parseWeekInput("5")).toEqual([5]);
  });

  it("expands an inclusive range", () => {
    expect(parseWeekInput("5-7")).toEqual([5, 6, 7]);
    expect(parseWeekInput("5–7")).toEqual([5, 6, 7]); // en-dash
  });

  it("parses a comma-separated list", () => {
    expect(parseWeekInput("1,3,5,7")).toEqual([1, 3, 5, 7]);
  });

  it("ignores spaces around values", () => {
    expect(parseWeekInput("1, 3, 5")).toEqual([1, 3, 5]);
  });

  it("clamps values to 1–20", () => {
    expect(parseWeekInput("0,1,20,21")).toEqual([1, 20]);
  });

  it("returns empty array for blank input", () => {
    expect(parseWeekInput("")).toEqual([]);
    expect(parseWeekInput("   ")).toEqual([]);
  });

  it("skips non-numeric tokens", () => {
    expect(parseWeekInput("abc")).toEqual([]);
  });
});

// ── isFinalExamType ───────────────────────────────────────────────────────────

describe("isFinalExamType", () => {
  // Should return true — exam-period items
  it.each([
    "Final Examination",
    "Final Exam",
    "Examination",
    "End of Semester Exam",
  ])('returns true for "%s"', (title) => {
    expect(isFinalExamType(title)).toBe(true);
  });

  // Should return false — in-semester items
  it.each([
    "Mid-Semester Test",
    "Midsem Test",
    "Mid Sem Exam", // "mid sem" disqualifier
    "Online Test",
    "Practical Test",
    "Lab Report",
    "Quiz",
    "Workshop",
    "Tutorial Exercise",
    "Weekly eTest",
    "E-Test",
    "Worksheet",
  ])('returns false for "%s"', (title) => {
    expect(isFinalExamType(title)).toBe(false);
  });
});

// ── extractSingleWeek ─────────────────────────────────────────────────────────

describe("extractSingleWeek", () => {
  it("extracts a plain week number", () => {
    expect(extractSingleWeek("Week 7")).toBe(7);
    expect(extractSingleWeek("During Week 5 lab")).toBe(5);
    expect(extractSingleWeek("24 hours after workshop Week 10")).toBe(10);
  });

  it("is case-insensitive", () => {
    expect(extractSingleWeek("WEEK 3")).toBe(3);
    expect(extractSingleWeek("week 12")).toBe(12);
  });

  it("returns null for ranges", () => {
    // "Weeks" (plural) does not match the /\bweek\s+\d+/ pattern
    expect(extractSingleWeek("Teaching weeks 2-12")).toBeNull();
  });

  it("returns null for blank or undefined", () => {
    expect(extractSingleWeek(undefined)).toBeNull();
    expect(extractSingleWeek("")).toBeNull();
  });

  it("returns null for labels with no week number", () => {
    expect(extractSingleWeek("Fortnightly")).toBeNull();
    expect(extractSingleWeek("Exam period")).toBeNull();
  });
});

// ── buildDeadlineSections ─────────────────────────────────────────────────────

// Helper to create minimal Deadline objects for testing
function makeDeadline(
  overrides: Partial<Deadline> & { id: string; title: string; unit: string },
): Deadline {
  return {
    dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString(), // 1 week from now
    source: "manual",
    addedAt: new Date().toISOString(),
    ...overrides,
  } as Deadline;
}

describe("buildDeadlineSections", () => {
  const upcoming1 = makeDeadline({
    id: "1",
    title: "Assignment",
    unit: "COMP1005",
    dueDate: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  });
  const upcoming2 = makeDeadline({
    id: "2",
    title: "Lab Report",
    unit: "MATH1019",
    dueDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  });
  const overdue1 = makeDeadline({
    id: "3",
    title: "Quiz",
    unit: "COMP1005",
    dueDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  });
  const examTba = makeDeadline({
    id: "4",
    title: "Final Examination",
    unit: "COMP1005",
    dueDate: new Date(9999, 11, 31).toISOString(),
    dateTBA: true,
  });
  const weekTba = makeDeadline({
    id: "5",
    title: "Mid-Sem Test",
    unit: "MATH1019",
    dueDate: new Date(9999, 11, 31).toISOString(),
    dateTBA: true,
    weekLabel: "Week 7",
  });
  const fullTba = makeDeadline({
    id: "6",
    title: "Online Quiz",
    unit: "ELEN1000",
    dueDate: new Date(9999, 11, 31).toISOString(),
    dateTBA: true,
  });

  const allDeadlines = [
    upcoming1,
    upcoming2,
    overdue1,
    examTba,
    weekTba,
    fullTba,
  ];
  const defaultOpts = {
    filterUnit: "",
    filterStatus: "all" as const,
    sortBy: "date" as const,
    overduePosition: "bottom" as const,
  };

  it("returns all items when no filter is applied", () => {
    const { display } = buildDeadlineSections(allDeadlines, defaultOpts);
    expect(display).toHaveLength(allDeadlines.length);
  });

  it("places overdue items at the bottom by default", () => {
    const { display } = buildDeadlineSections(allDeadlines, defaultOpts);
    const lastItem = display[display.length - 1];
    expect(lastItem.id).toBe(overdue1.id);
  });

  it('places overdue items before upcoming when overduePosition is "top"', () => {
    const { display } = buildDeadlineSections(allDeadlines, {
      ...defaultOpts,
      overduePosition: "top",
    });
    const overdueIdx = display.findIndex((d) => d.id === overdue1.id);
    const upcomingIdx = display.findIndex((d) => d.id === upcoming1.id);
    // Overdue must appear before the first upcoming item; TBA items may still precede both
    expect(overdueIdx).toBeGreaterThanOrEqual(0);
    expect(overdueIdx).toBeLessThan(upcomingIdx);
  });

  it("filters by unit code", () => {
    const { display } = buildDeadlineSections(allDeadlines, {
      ...defaultOpts,
      filterUnit: "COMP1005",
    });
    expect(display.every((d) => d.unit === "COMP1005")).toBe(true);
  });

  it("filters to upcoming only (excludes TBA and overdue)", () => {
    const { display } = buildDeadlineSections(allDeadlines, {
      ...defaultOpts,
      filterStatus: "upcoming",
    });
    expect(
      display.every((d) => !d.dateTBA && new Date(d.dueDate) > new Date()),
    ).toBe(true);
    expect(display.some((d) => d.dateTBA)).toBe(false);
    expect(
      display.some((d) => !d.dateTBA && new Date(d.dueDate) <= new Date()),
    ).toBe(false);
  });

  it("filters to TBA only", () => {
    const { display } = buildDeadlineSections(allDeadlines, {
      ...defaultOpts,
      filterStatus: "tba",
    });
    expect(display.every((d) => !!d.dateTBA)).toBe(true);
    expect(display).toHaveLength(3); // examTba, weekTba, fullTba
  });

  it("splits TBA into exam / week-known / fully-unknown sub-groups when multiple exist", () => {
    const { sections } = buildDeadlineSections(allDeadlines, {
      ...defaultOpts,
      filterStatus: "tba",
    });
    // All three TBA sub-groups are present, so labels should appear
    const labels = sections.map((s) => s.label).filter(Boolean);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).toContain("Exam period · date TBC");
    expect(labels).toContain("Week scheduled · date TBC");
    expect(labels).toContain("Date unknown");
  });

  it("omits section labels when only one TBA sub-group is present", () => {
    const { sections } = buildDeadlineSections([examTba], {
      ...defaultOpts,
      filterStatus: "tba",
    });
    expect(sections.every((s) => s.label === null)).toBe(true);
  });
});
