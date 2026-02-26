// ── Tests: utils/format.ts ────────────────────────────────────────────────────
// All functions are pure (or depend only on Date) — vi.useFakeTimers() used
// to pin "now" for getCountdown and defaultYear.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatDate, formatTime, getCountdown, defaultYear } from "../format";

// ── formatDate ────────────────────────────────────────────────────────────────

describe("formatDate", () => {
  it("returns weekday, day, month abbreviation, and year for a known date", () => {
    // 16 Mar 2026 is a Monday — verifies all four components are present
    const result = formatDate(new Date(2026, 2, 16));
    expect(result).toMatch(/Mon/i);
    expect(result).toMatch(/16/);
    expect(result).toMatch(/Mar/i);
    expect(result).toMatch(/2026/);
  });

  it("returns the correct weekday for each day of a known week", () => {
    // Week of 16 Mar 2026 — confirms day-of-week mapping is correct
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    days.forEach((day, i) => {
      expect(formatDate(new Date(2026, 2, 16 + i))).toMatch(
        new RegExp(day, "i"),
      );
    });
  });
});

// ── formatTime ────────────────────────────────────────────────────────────────

describe("formatTime", () => {
  it("returns HH:MM for a time with hours and minutes", () => {
    // No timezone offset — parsed as local time; hours and minutes extracted via getHours/getMinutes
    expect(formatTime("2026-03-16T14:30:00")).toBe("14:30");
  });

  it("returns null for midnight (00:00) — treated as all-day", () => {
    expect(formatTime("2026-03-16T00:00:00")).toBeNull();
  });

  it("returns a time string for one minute past midnight — not all-day", () => {
    // Only exact midnight is suppressed; 00:01 is a real time
    expect(formatTime("2026-03-16T00:01:00")).not.toBeNull();
  });

  it("zero-pads single-digit hours and minutes", () => {
    expect(formatTime("2026-03-16T09:05:00")).toBe("09:05");
  });
});

// ── getCountdown ──────────────────────────────────────────────────────────────
// Pin "now" to a fixed moment so all relative calculations are deterministic.

describe("getCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T12:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns overdue for a past date", () => {
    expect(getCountdown("2026-03-15T12:00:00")).toEqual({
      label: "overdue",
      urgencyClass: "overdue",
    });
  });

  it("returns minutes for < 60 minutes away (urgencyClass: urgent)", () => {
    expect(getCountdown("2026-03-16T12:30:00")).toEqual({
      label: "in 30 mins",
      urgencyClass: "urgent",
    });
  });

  it('uses singular "min" for exactly 1 minute away', () => {
    expect(getCountdown("2026-03-16T12:01:00")).toEqual({
      label: "in 1 min",
      urgencyClass: "urgent",
    });
  });

  it("returns hours for 1–47 hours away (urgencyClass: urgent)", () => {
    // 24 hours away — diffHours = 24, still within the < 48h branch
    expect(getCountdown("2026-03-17T12:00:00")).toEqual({
      label: "in 24 hours",
      urgencyClass: "urgent",
    });
  });

  it('uses singular "hour" for exactly 1 hour away', () => {
    // 60 mins → diffMins = 60 (not < 60), falls through to hours branch
    expect(getCountdown("2026-03-16T13:00:00")).toEqual({
      label: "in 1 hour",
      urgencyClass: "urgent",
    });
  });

  it("returns days for 2–6 days away (urgencyClass: soon)", () => {
    // 48 hours = earliest point that reaches the days branch
    expect(getCountdown("2026-03-18T12:00:00")).toEqual({
      label: "in 2 days",
      urgencyClass: "soon",
    });
  });

  it("returns days with urgencyClass ok for >= 7 days away", () => {
    expect(getCountdown("2026-03-23T12:00:00")).toEqual({
      label: "in 7 days",
      urgencyClass: "ok",
    });
  });

  it("returns days with urgencyClass ok well beyond 7 days", () => {
    expect(getCountdown("2026-04-16T12:00:00")).toEqual({
      label: "in 31 days",
      urgencyClass: "ok",
    });
  });
});

// ── defaultYear ───────────────────────────────────────────────────────────────

describe("defaultYear", () => {
  it("returns the current full year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T12:00:00"));
    expect(defaultYear()).toBe(2026);
    vi.useRealTimers();
  });
});
