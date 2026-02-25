// ── Tests: domain/outline.ts ──────────────────────────────────────────────────
// parseAsTask and parsePcText (DOMParser available via vitest jsdom environment)

import { describe, it, expect } from 'vitest';
import { parseAsTask, parsePcText, outlineToDeadlines } from '../outline';
import type { UobOutline } from '../outline';

// ── parseAsTask ───────────────────────────────────────────────────────────────

describe('parseAsTask', () => {
  const SAMPLE_AS_TASK = `1| Assignment| 40 percent| ULOs assessed 1|2|4;\n2| Practical Test| 20 percent| ULOs assessed 2|3;\n3| Final Examination| 40 percent| ULOs assessed 1|2|3|4|`;

  it('returns one item per assessment row', () => {
    const items = parseAsTask(SAMPLE_AS_TASK);
    expect(items).toHaveLength(3);
  });

  it('extracts title correctly', () => {
    const items = parseAsTask(SAMPLE_AS_TASK);
    expect(items[0].title).toBe('Assignment');
    expect(items[1].title).toBe('Practical Test');
    expect(items[2].title).toBe('Final Examination');
  });

  it('extracts weight when "N percent" is present', () => {
    const items = parseAsTask(SAMPLE_AS_TASK);
    expect(items[0].weight).toBe(40);
    expect(items[1].weight).toBe(20);
    expect(items[2].weight).toBe(40);
  });

  it('returns undefined weight when not present', () => {
    const asTask = '1| Assignment| no weight info|;\n';
    const items = parseAsTask(asTask);
    expect(items[0].weight).toBeUndefined();
  });

  it('returns empty array for empty string', () => {
    expect(parseAsTask('')).toEqual([]);
  });

  it('skips rows with fewer than 2 pipe-separated columns', () => {
    expect(parseAsTask('just a sentence without pipes')).toEqual([]);
  });

  it('handles trailing semicolons correctly', () => {
    const asTask = '1| Lab Report| 10 percent|;';
    const items = parseAsTask(asTask);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Lab Report');
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

describe('parsePcText', () => {
  it('returns one item per non-empty assessment cell', () => {
    const items = parsePcText(SAMPLE_PC_TEXT, 'COMP1005', 1, 2026);
    expect(items).toHaveLength(2); // week 1 has "-", week 5 and week 10 have assessments
  });

  it('sets unit code and semester on all items', () => {
    const items = parsePcText(SAMPLE_PC_TEXT, 'COMP1005', 1, 2026);
    expect(items.every((i) => i.unit === 'COMP1005')).toBe(true);
    expect(items.every((i) => i.semester === 1)).toBe(true);
  });

  it('parses the title by stripping weight and time annotations', () => {
    const items = parsePcText(SAMPLE_PC_TEXT, 'COMP1005', 1, 2026);
    expect(items[0].title).toBe('Prac Test 1');
    expect(items[1].title).toBe('Assignment');
  });

  it('extracts weight from "(N%)" annotation', () => {
    const items = parsePcText(SAMPLE_PC_TEXT, 'COMP1005', 1, 2026);
    expect(items[0].weight).toBe(20);
    expect(items[1].weight).toBe(40);
  });

  it('extracts exactTime from "(HH:MM Date)" annotation', () => {
    const items = parsePcText(SAMPLE_PC_TEXT, 'COMP1005', 1, 2026);
    expect(items[1].exactTime).toBe('23:59');
  });

  it('uses the Begin Date as the default resolved date', () => {
    const items = parsePcText(SAMPLE_PC_TEXT, 'COMP1005', 1, 2026);
    // Week 5 Begin Date is 2 March 2026
    expect(items[0].resolvedDate!.getMonth()).toBe(2); // March = 2
    expect(items[0].resolvedDate!.getDate()).toBe(2);
  });

  it('sets isTBA to false for all items (they have begin dates)', () => {
    const items = parsePcText(SAMPLE_PC_TEXT, 'COMP1005', 1, 2026);
    expect(items.every((i) => i.isTBA === false)).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(parsePcText('', 'COMP1005', 1, 2026)).toEqual([]);
  });

  it('returns empty array when no Begin Date column is found', () => {
    const noDateTable = '<table><tr><th>Week</th><th>Assessment</th></tr><tr><td>5</td><td>Quiz</td></tr></table>';
    expect(parsePcText(noDateTable, 'COMP1005', 1, 2026)).toEqual([]);
  });
});

// ── outlineToDeadlines ────────────────────────────────────────────────────────

describe('outlineToDeadlines', () => {
  const OUTLINE: UobOutline = {
    UnitNumber: 'COMP1005',
    Title: 'Fundamentals of Programming',
    Avail_Study_Period: 'Semester 1',
    Avail_Year: '2026',
    AS_TASK: '1| Prac Test| 20 percent|;\n2| Final Examination| 40 percent|;\n3| Assignment| 40 percent|',
    PC_TEXT: SAMPLE_PC_TEXT, // Prac Test 1 (20%), Assignment (40%) in table
  };

  it('returns items from both PC_TEXT and AS_TASK (TBA fallback)', () => {
    const items = outlineToDeadlines(OUTLINE, 'COMP1005', 1, 2026);
    // PC_TEXT: Prac Test 1, Assignment (2 items)
    // AS_TASK TBA fallback: Final Examination (not in calendar)
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('adds TBA item for AS_TASK entries not found in PC_TEXT', () => {
    const items = outlineToDeadlines(OUTLINE, 'COMP1005', 1, 2026);
    const tba = items.filter((i) => i.isTBA);
    // Final Examination is in AS_TASK but not in the calendar → TBA
    expect(tba.some((i) => /final/i.test(i.title))).toBe(true);
  });

  it('propagates AS_TASK weight to matched PC_TEXT items without weight annotation', () => {
    // Create an outline where the calendar cell has no "(N%)" tag but AS_TASK has a weight
    const outline: UobOutline = {
      ...OUTLINE,
      AS_TASK: '1| Prac Test| 20 percent|',
      PC_TEXT: `<table>
        <tr><th>Begin Date</th><th>Assessment</th></tr>
        <tr><td>2 March</td><td>Prac Test 1</td></tr>
      </table>`,
    };
    const items = outlineToDeadlines(outline, 'COMP1005', 1, 2026);
    const prac = items.find((i) => /prac/i.test(i.title));
    expect(prac).toBeDefined();
    expect(prac!.weight).toBe(20);
  });
});
