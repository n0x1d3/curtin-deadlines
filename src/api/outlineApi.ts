import type { PendingDeadline } from "../types";
import {
  type UobOutline,
  parseAsTask,
  outlineToDeadlines,
} from "../domain/outline";
import { fetchUobOutline, getUnitLookup } from "./outlineLookup";

/**
 * Fetches the unit outline for the given unit code, semester, and year, and
 * returns PendingDeadline objects ready for the confirmation UI.
 */
export async function fetchOutline(
  unitCode: string,
  semester: 1 | 2,
  year: number,
): Promise<PendingDeadline[]> {
  const code = unitCode.trim().toUpperCase();
  const outline = await fetchUobOutline(code, semester, year);
  return outlineToDeadlines(outline, code, semester, year);
}

/** Rich outline data returned by fetchOutlineData for the test panel. */
export interface OutlineData {
  asTask: string;
  pcText: string;
  asTaskItems: Array<{ title: string; weight?: number; outcomes?: string }>;
  parsed: PendingDeadline[];
  rawOutline: Record<string, unknown>;
}

/**
 * Like fetchOutline but also returns raw AS_TASK + PC_TEXT strings and
 * parsed AS_TASK rows for the test panel.
 */
export async function fetchOutlineData(
  unitCode: string,
  semester: 1 | 2,
  year: number,
): Promise<OutlineData> {
  const code = unitCode.trim().toUpperCase();
  const outline = await fetchUobOutline(code, semester, year);
  return {
    asTask: outline.AS_TASK ?? "",
    pcText: outline.PC_TEXT ?? "",
    asTaskItems: parseAsTask(outline.AS_TASK ?? ""),
    parsed: outlineToDeadlines(outline, code, semester, year),
    rawOutline: outline as unknown as Record<string, unknown>,
  };
}

/** Returns every known Curtin unit code, sorted alphabetically. */
export async function getAllUnitCodes(): Promise<string[]> {
  const lookup = await getUnitLookup();
  return Object.keys(lookup).sort();
}

export type { UobOutline };
