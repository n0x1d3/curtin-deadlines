import type { PendingDeadline } from "../types";

/**
 * Parses the pipe-delimited AS_TASK field from the unit outline.
 *
 * Format (one row per line, semicolon-terminated):
 *   "1| Assignment| 40 percent| ULOs assessed 1|2|4;\n"
 *   "2| Practical Test| 20 percent| ULOs assessed 2|3;\n"
 *   "3| Final Examination| 40 percent| ULOs assessed 1|2|3|4|"
 *
 * Returns [{title, weight?, outcomes?}, ...] for each assessment row.
 * Weight and outcomes are absent when the relevant columns are missing.
 * Note: late/extension flags are not present in the API response — PDF-only.
 */
export function parseAsTask(
  asTask: string,
): Array<
  Pick<PendingDeadline, "title"> & { weight?: number; outcomes?: string }
> {
  if (!asTask) return [];

  // Split into individual assessment rows on ";\n" or trailing ";"
  const rows = asTask.split(/;\s*\n|;\s*$/).filter((r) => r.trim());
  const results: Array<
    Pick<PendingDeadline, "title"> & { weight?: number; outcomes?: string }
  > = [];

  for (const row of rows) {
    // Columns: [num, title, weight_description, ULO_refs...]
    const cols = row.split(/\|\s*/);
    if (cols.length < 2) continue;

    const title = cols[1]?.trim() ?? "";
    if (!title) continue;

    // Extract numeric weight from "40 percent" format
    const weightStr = cols[2] ?? "";
    const weightMatch = weightStr.match(/(\d+)\s*percent/i);
    const weight = weightMatch ? parseInt(weightMatch[1]) : undefined;

    // Extract ULO numbers from cols[3..n].
    // cols[3] = "ULOs assessed 1" (first number embedded in text),
    // subsequent cols = bare numbers ("2", "4", …) or empty strings.
    const uloNums: string[] = [];
    for (const col of cols.slice(3)) {
      const raw = col
        .trim()
        .replace(/^ULOs?\s+assessed\s*/i, "")
        .replace(/[;|]+$/, "")
        .trim();
      if (/^\d+$/.test(raw)) uloNums.push(raw);
    }
    const outcomes = uloNums.length > 0 ? uloNums.join(",") : undefined;

    results.push({ title, weight, outcomes });
  }

  return results;
}
