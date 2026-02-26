// ── Tests: ics/parser.ts ──────────────────────────────────────────────────────
// parseIcs, parseIcsDate, matchIcsToDeadlines, detectTimetableUnits

import { describe, it, expect } from "vitest";
import {
  parseIcs,
  parseIcsDate,
  matchIcsToDeadlines,
  detectTimetableUnits,
  EXAM_KEYWORDS,
} from "../parser";
import type { Deadline } from "../../types";

// ── parseIcsDate ──────────────────────────────────────────────────────────────

describe("parseIcsDate", () => {
  it("parses a UTC datetime string", () => {
    const d = parseIcsDate("DTSTART:20261109T090000Z");
    expect(d).not.toBeNull();
    // 09:00 UTC on 9 Nov 2026
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(10); // 0-based
    expect(d!.getUTCDate()).toBe(9);
    expect(d!.getUTCHours()).toBe(9);
  });

  it("parses a Perth local datetime (UTC+8)", () => {
    // 09:00 Perth = 01:00 UTC
    const d = parseIcsDate("DTSTART;TZID=Australia/Perth:20261109T090000");
    expect(d).not.toBeNull();
    expect(d!.getUTCHours()).toBe(1); // 9 - 8 = 1
    expect(d!.getUTCDate()).toBe(9);
  });

  it("parses an all-day date", () => {
    const d = parseIcsDate("DTSTART;VALUE=DATE:20261109");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(10); // November, 0-based
    expect(d!.getDate()).toBe(9);
  });

  it("returns null for an unrecognised format", () => {
    expect(parseIcsDate("DTSTART:not-a-date")).toBeNull();
    expect(parseIcsDate("NOCONN")).toBeNull();
  });
});

// ── parseIcs ──────────────────────────────────────────────────────────────────

// Minimal valid .ics text with two events
const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:COMP1005 Final Examination
DTSTART:20261109T090000Z
DTEND:20261109T120000Z
END:VEVENT
BEGIN:VEVENT
SUMMARY:MATH1019 Mid-Semester Test
DTSTART:20260316T130000Z
END:VEVENT
BEGIN:VEVENT
SUMMARY:No unit code here
DTSTART:20260401T100000Z
END:VEVENT
END:VCALENDAR`;

describe("parseIcs", () => {
  it("returns one event per VEVENT block", () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events).toHaveLength(3);
  });

  it("extracts summary and dtstart correctly", () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events[0].summary).toBe("COMP1005 Final Examination");
    expect(events[0].dtstart.getUTCFullYear()).toBe(2026);
    expect(events[0].dtstart.getUTCMonth()).toBe(10); // November
  });

  it("extracts unit codes from SUMMARY", () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events[0].unitCode).toBe("COMP1005");
    expect(events[1].unitCode).toBe("MATH1019");
  });

  it("sets unitCode to undefined when no unit code is in the summary", () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events[2].unitCode).toBeUndefined();
  });

  it("parses dtend when present", () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events[0].dtend).toBeDefined();
    expect(events[1].dtend).toBeUndefined();
  });

  it("returns empty array for empty or invalid input", () => {
    expect(parseIcs("")).toEqual([]);
    expect(parseIcs("BEGIN:VCALENDAR\nEND:VCALENDAR")).toEqual([]);
  });

  it("skips events without a summary or dtstart", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20260401T100000Z
END:VEVENT
END:VCALENDAR`;
    expect(parseIcs(ics)).toHaveLength(0);
  });
});

// ── detectTimetableUnits ──────────────────────────────────────────────────────

describe("detectTimetableUnits", () => {
  it("extracts unique unit codes and sorts them", () => {
    const events = parseIcs(SAMPLE_ICS);
    const info = detectTimetableUnits(events);
    expect(info.units).toEqual(["COMP1005", "MATH1019"]);
  });

  it("infers semester 1 from a February–June event", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:COMP1005 Lab
DTSTART:20260316T090000Z
END:VEVENT
END:VCALENDAR`;
    const { semester } = detectTimetableUnits(parseIcs(ics));
    expect(semester).toBe(1);
  });

  it("infers semester 2 from a July–November event", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:COMP1005 Lab
DTSTART:20260803T090000Z
END:VEVENT
END:VCALENDAR`;
    const { semester } = detectTimetableUnits(parseIcs(ics));
    expect(semester).toBe(2);
  });

  it("returns empty units list when no unit codes are present", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Staff Meeting
DTSTART:20260401T090000Z
END:VEVENT
END:VCALENDAR`;
    const { units } = detectTimetableUnits(parseIcs(ics));
    expect(units).toEqual([]);
  });
});

// ── matchIcsToDeadlines ───────────────────────────────────────────────────────

function makeTbaDeadline(overrides: {
  id: string;
  title: string;
  unit: string;
}): Deadline {
  return {
    dueDate: new Date(9999, 11, 31).toISOString(),
    dateTBA: true,
    source: "manual",
    addedAt: new Date().toISOString(),
    ...overrides,
  } as Deadline;
}

describe("matchIcsToDeadlines", () => {
  const events = parseIcs(SAMPLE_ICS); // COMP1005 Final Exam + MATH1019 Mid-Sem Test

  it("matches an ICS event to a TBA deadline by unit code", () => {
    const deadlines = [
      makeTbaDeadline({
        id: "1",
        title: "Final Examination",
        unit: "COMP1005",
      }),
    ];
    const matches = matchIcsToDeadlines(events, deadlines);
    expect(matches).toHaveLength(1);
    expect(matches[0].deadlineId).toBe("1");
  });

  it("gives high confidence when a keyword appears in both summary and title", () => {
    const deadlines = [
      makeTbaDeadline({
        id: "1",
        title: "Final Examination",
        unit: "COMP1005",
      }),
    ];
    const matches = matchIcsToDeadlines(events, deadlines);
    expect(matches[0].confidence).toBe("high");
  });

  it("gives low confidence when unit matches but no keyword overlap", () => {
    const deadlines = [
      makeTbaDeadline({ id: "1", title: "Group Project", unit: "COMP1005" }),
    ];
    const matches = matchIcsToDeadlines(events, deadlines);
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe("low");
  });

  it("does not match when unit codes differ", () => {
    const deadlines = [
      makeTbaDeadline({ id: "1", title: "Final Exam", unit: "ELEN1000" }),
    ];
    const matches = matchIcsToDeadlines(events, deadlines);
    expect(matches).toHaveLength(0);
  });

  it("does not match deadlines that already have a date (dateTBA not set)", () => {
    const dated: Deadline = {
      id: "1",
      title: "Final Examination",
      unit: "COMP1005",
      dueDate: new Date(2026, 10, 9).toISOString(),
      source: "manual",
      addedAt: new Date().toISOString(),
    };
    const matches = matchIcsToDeadlines(events, [dated]);
    expect(matches).toHaveLength(0);
  });
});

// ── EXAM_KEYWORDS ─────────────────────────────────────────────────────────────

describe("EXAM_KEYWORDS", () => {
  it("contains the expected terms", () => {
    expect(EXAM_KEYWORDS).toContain("exam");
    expect(EXAM_KEYWORDS).toContain("final");
    expect(EXAM_KEYWORDS).toContain("test");
    expect(EXAM_KEYWORDS).toContain("quiz");
  });
});
