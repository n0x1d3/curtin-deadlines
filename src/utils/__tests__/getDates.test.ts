// ── Tests: utils/getDates.ts ──────────────────────────────────────────────────
// Focus areas: known-year override table, formula fallback, weekToDate arithmetic,
// and parseOrdinalDate edge cases (standard + null-byte '#' placeholders).

import { describe, it, expect } from "vitest";
import {
  getDates,
  getSemesterWeeks,
  weekToDate,
  parseOrdinalDate,
} from "../getDates";

// ── getDates ──────────────────────────────────────────────────────────────────

describe("getDates", () => {
  it("returns verified override data for 2026 S1", () => {
    const s1 = getDates(2026)[1];
    expect(s1.start).toEqual({ month: 2, day: 16 });
    expect(s1.end).toEqual({ month: 5, day: 22 });
    expect(s1.weeks).toBe(14);
  });

  it("returns verified override data for 2026 S2", () => {
    const s2 = getDates(2026)[2];
    expect(s2.start).toEqual({ month: 7, day: 20 });
    expect(s2.end).toEqual({ month: 10, day: 23 });
    expect(s2.weeks).toBe(14);
  });

  it("returns override data for 2027 and 2028", () => {
    expect(getDates(2027)[1].start).toEqual({ month: 2, day: 15 });
    expect(getDates(2028)[1].start).toEqual({ month: 2, day: 14 });
  });

  it("falls back to formula for 2025 (pre-2026)", () => {
    const data = getDates(2025);
    // Formula: 4th Monday of February 2025 = Feb 24 (Feb 1 is Saturday → first Mon is Feb 3 → +3 weeks)
    expect(data[1].start).toEqual({ month: 2, day: 24 });
    expect(data[1].weeks).toBe(13);
  });

  it("formula-based years use 13 teaching weeks", () => {
    expect(getDates(2024)[1].weeks).toBe(13);
    expect(getDates(2025)[2].weeks).toBe(13);
  });
});

// ── getSemesterWeeks ──────────────────────────────────────────────────────────

describe("getSemesterWeeks", () => {
  it("returns 14 for 2026 S1 and S2 (override table)", () => {
    expect(getSemesterWeeks(2026, 1)).toBe(14);
    expect(getSemesterWeeks(2026, 2)).toBe(14);
  });

  it("returns 13 for 2025 (formula fallback)", () => {
    expect(getSemesterWeeks(2025, 1)).toBe(13);
  });
});

// ── weekToDate ────────────────────────────────────────────────────────────────

describe("weekToDate", () => {
  it("week 1 S1 2026 is Mon 16 Feb 2026 (semester start)", () => {
    const d = weekToDate(1, 2026, 1);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(1); // 0-indexed: 1 = February
    expect(d.getDate()).toBe(16);
  });

  it("week 5 S1 2026 is Mon 16 Mar 2026 (per source code example)", () => {
    // Week 1 = Feb 16 → week 5 = Feb 16 + 4*7 = Mar 16
    const d = weekToDate(1, 2026, 5);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // March
    expect(d.getDate()).toBe(16);
  });

  it("dayOffset shifts the result within the week", () => {
    // Week 1, Mon = Feb 16; +1=Tue, +4=Fri
    const tue = weekToDate(1, 2026, 1, 1);
    expect(tue.getDate()).toBe(17);
    const fri = weekToDate(1, 2026, 1, 4);
    expect(fri.getDate()).toBe(20);
  });

  it("week 1 S2 2026 is Mon 20 Jul 2026 (S2 start)", () => {
    const d = weekToDate(2, 2026, 1);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // July
    expect(d.getDate()).toBe(20);
  });

  it("advances correctly for week 14 (last week of 2026 S1)", () => {
    // Week 14 = Feb 16 + 13*7 = Feb 16 + 91 days = May 18
    // (Feb: +12 days to end, Mar: +31, Apr: +30, May: +18 = 91)
    const d = weekToDate(1, 2026, 14);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // May
    expect(d.getDate()).toBe(18);
  });
});

// ── parseOrdinalDate ──────────────────────────────────────────────────────────

describe("parseOrdinalDate — standard ordinal dates", () => {
  it("parses a standard ordinal date with suffix", () => {
    const d = parseOrdinalDate("3rd May", 2026);
    expect(d).not.toBeNull();
    expect(d!.getMonth()).toBe(4); // May
    expect(d!.getDate()).toBe(3);
  });

  it("parses double-digit day", () => {
    const d = parseOrdinalDate("12th April", 2026);
    expect(d!.getMonth()).toBe(3); // April
    expect(d!.getDate()).toBe(12);
  });

  it("parses without ordinal suffix (bare number)", () => {
    const d = parseOrdinalDate("21 June", 2026);
    expect(d!.getMonth()).toBe(5); // June
    expect(d!.getDate()).toBe(21);
  });

  it("ignores time component after the month name", () => {
    // "3rd May 23:59" — only the date portion is extracted
    const d = parseOrdinalDate("3rd May 23:59", 2026);
    expect(d!.getDate()).toBe(3);
    expect(d!.getMonth()).toBe(4);
  });

  it("is case-insensitive for month names", () => {
    expect(parseOrdinalDate("5th MARCH", 2026)!.getMonth()).toBe(2);
    expect(parseOrdinalDate("10th january", 2026)!.getMonth()).toBe(0);
  });

  it("accepts 3-letter month abbreviations", () => {
    expect(parseOrdinalDate("4th Aug", 2026)!.getMonth()).toBe(7);
    expect(parseOrdinalDate("9th Dec", 2026)!.getMonth()).toBe(11);
  });

  it("returns null for an unrecognised month", () => {
    expect(parseOrdinalDate("3rd Xyz", 2026)).toBeNull();
  });

  it("sets the year from the parameter", () => {
    const d = parseOrdinalDate("1st January", 2027);
    expect(d!.getFullYear()).toBe(2027);
  });
});

describe("parseOrdinalDate — null-byte '#' placeholders (single digit)", () => {
  it("#st → 1st", () => {
    const d = parseOrdinalDate("#st May", 2026);
    expect(d!.getDate()).toBe(1);
    expect(d!.getMonth()).toBe(4);
  });

  it("#nd → 2nd", () => {
    const d = parseOrdinalDate("#nd June", 2026);
    expect(d!.getDate()).toBe(2);
  });

  it("#rd → 3rd", () => {
    const d = parseOrdinalDate("#rd July", 2026);
    expect(d!.getDate()).toBe(3);
  });

  it("#th → null (ambiguous: 4th, 5th … 9th all valid)", () => {
    // 'th' is not matched by the placeholder regex — unresolvable
    expect(parseOrdinalDate("#th May", 2026)).toBeNull();
  });
});

describe("parseOrdinalDate — null-byte '#' placeholders (double digit)", () => {
  it("##nd → 22nd", () => {
    const d = parseOrdinalDate("##nd August", 2026);
    expect(d!.getDate()).toBe(22);
    expect(d!.getMonth()).toBe(7);
  });

  it("##rd → 23rd", () => {
    const d = parseOrdinalDate("##rd September", 2026);
    expect(d!.getDate()).toBe(23);
    expect(d!.getMonth()).toBe(8);
  });

  it("##st → null (ambiguous: 21st or 31st)", () => {
    expect(parseOrdinalDate("##st October", 2026)).toBeNull();
  });

  it("##th → null (ambiguous multi-digit 'th' suffix)", () => {
    expect(parseOrdinalDate("##th November", 2026)).toBeNull();
  });
});

describe("parseOrdinalDate — spaced double-hash placeholder ('# #nd May')", () => {
  it("# #nd → 22nd", () => {
    const d = parseOrdinalDate("# #nd May", 2026);
    expect(d!.getDate()).toBe(22);
    expect(d!.getMonth()).toBe(4);
  });

  it("# #rd → 23rd", () => {
    const d = parseOrdinalDate("# #rd June", 2026);
    expect(d!.getDate()).toBe(23);
    expect(d!.getMonth()).toBe(5);
  });

  it("# #st → null (ambiguous: 21st or 31st)", () => {
    expect(parseOrdinalDate("# #st July", 2026)).toBeNull();
  });
});

describe("parseOrdinalDate — unresolvable / malformed inputs", () => {
  it("returns null for empty string", () => {
    expect(parseOrdinalDate("", 2026)).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(parseOrdinalDate("   ", 2026)).toBeNull();
  });

  it("returns null for a string with no date information", () => {
    expect(parseOrdinalDate("TBA", 2026)).toBeNull();
    expect(parseOrdinalDate("Week 5", 2026)).toBeNull();
  });

  it("trims leading/trailing whitespace before parsing", () => {
    const d = parseOrdinalDate("  3rd May  ", 2026);
    expect(d!.getDate()).toBe(3);
  });
});
