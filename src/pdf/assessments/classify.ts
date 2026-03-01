/** True when a line contains only a percentage value. */
export function isPercentLine(line: string): boolean {
  return /^\s*[\d#\s]*%\s*$/.test(line);
}

/** True when a line ends with a percentage suffix after task title text. */
export function endsWithPercent(line: string): boolean {
  return /\S.*\s*[\d#\s]*%\s*$/.test(line);
}

/** Strip the trailing percent token from a title+percent line. */
export function extractTitleFromPercentLine(line: string): string {
  return line.replace(/\s*[\d#\s]*%\s*$/, "").trim();
}

/** True when a line is structural noise (headers, footers, garbled sequences). */
export function isNoiseLine(line: string): boolean {
  const significant = line.replace(/[\s,#]/g, "");
  if (significant.length <= 1 && line.length > 3) return true;
  return (
    /^(Week:|Day:|Time:)/i.test(line) ||
    /^(Task\s*$|Value\s*$|Date Due|Unit\s*$|Outcome|Late\s*$|Extension|Accepted|Considered)/i.test(
      line,
    ) ||
    /^(Assessment Schedule|Assessment$|Faculty of|WASM:|CRICOS|Page\s+\d|The only auth)/i.test(
      line,
    ) ||
    /\b(No\s+No|Yes\s+Yes|Yes\s+No|No\s+Yes)\b/i.test(line) ||
    /^\*/.test(line) ||
    /^[*\s]+$/.test(line)
  );
}

/**
 * True when the week or day value indicates the deadline is not a fixed date.
 * Covers TBA markers, descriptive week phrases, and relative day phrases.
 */
export function isTBAValue(val: string): boolean {
  return /\b(TBA|TBC|exam(ination)? (week|period)|teaching week|study week|flexible|as per|schedule|after your|hours after|centrally|one week after|during|fortnightly|weekly|bi-?weekly)\b/i.test(
    val,
  );
}

/** True when a line looks like Unit Learning Outcomes data (digits and commas). */
export function isOutcomesLine(line: string): boolean {
  return /^[\d][\d,\s]*$/.test(line) && line.length < 20;
}

/** True when a line is a standalone yes/no flag. */
export function isYesNoLine(line: string): boolean {
  return /^(yes|no)$/i.test(line);
}

/** True when a line holds a combined "Yes No" / "No Yes" / etc. pair. */
export function isCombinedYesNo(line: string): boolean {
  return /^(yes|no)\s+(yes|no)\s*$/i.test(line);
}

/** True when a line looks like meta-block data (outcomes or yes/no flags). */
export function isMetaValue(line: string): boolean {
  return isOutcomesLine(line) || isYesNoLine(line) || isCombinedYesNo(line);
}
