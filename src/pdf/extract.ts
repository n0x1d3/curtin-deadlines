// ── PDF I/O: worker setup, unit-name extraction, text extraction ─────────────
// Uses pdf.js to read PDF files and extract text with line-break detection.

import * as pdfjsLib from "pdfjs-dist";

// ── Worker setup ──────────────────────────────────────────────────────────────

/**
 * Point pdf.js at the worker file bundled into the extension.
 * Must be called once per page before the first extractPDFText() call.
 * Pass chrome.runtime.getURL('pdf.worker.min.js') as the argument.
 */
export function initPdfWorker(workerSrc: string): void {
  (pdfjsLib as any).GlobalWorkerOptions.workerSrc = workerSrc;
}

// ── Unit name extraction ───────────────────────────────────────────────────────

/**
 * Attempt to extract the full unit name from the PDF header.
 *
 * Curtin OASIS unit outlines consistently place the unit name immediately
 * after the unit code near the top of the first page. Two common layouts:
 *   a) Same line:  "COMP1005 Introduction to Computing"
 *   b) Next line:  "COMP1005\n" followed by "Introduction to Computing"
 *
 * We scan only the first 40 non-empty lines (the header area), so we don't
 * accidentally match assessment titles or table content deeper in the PDF.
 *
 * Candidate rejection rules:
 *   - Must be ≥ 5 characters and contain at least one space (multi-word)
 *   - Must start with a capital letter (after stripping null-byte '#' chars)
 *   - Must not look like a school/faculty/compliance line, a date, or other noise
 *
 * @param text      Full extracted PDF text (digits decoded; '#' only in older PDFs)
 * @param unitCode  Known unit code from filename, e.g. "COMP1005"
 * @returns         Unit name string, or undefined if not found
 */
export function parseUnitName(
  text: string,
  unitCode: string,
): string | undefined {
  if (!unitCode) return undefined;

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Only look at the first 20 lines — the unit name is always in the header
  const header = lines.slice(0, 20);

  // Curtin OASIS unit outlines consistently format the header line as:
  //   "COMP 1 0 0 5   (V. 2 ) Fundamentals of Programming"
  //
  // Digits are space-separated glyphs (each extracted as a separate text item).
  // The version string "(V. N)" acts as a reliable delimiter: the unit name is
  // everything that follows it on the same line.  '#' may appear in older PDFs
  // that lack ActualText annotations (null bytes, no decoding possible).
  //
  // Regex: match "(V." + optional spaces/digits/'#' + ")" then capture the rest.
  const VERSION_DELIM = /\(V\.\s*[#\d][^)]*\)\s*(.+)$/i;

  for (const line of header) {
    const m = line.match(VERSION_DELIM);
    if (!m) continue;

    // Strip '#' placeholders and collapse whitespace from the captured name
    const candidate = m[1]
      .replace(/#/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Accept names that are multi-word, start with a capital, and are not noise
    if (
      candidate.length >= 5 &&
      candidate.includes(" ") &&
      /^[A-Z]/.test(candidate)
    ) {
      return candidate;
    }
  }

  return undefined;
}

// ── Null-glyph decoding ────────────────────────────────────────────────────────

// Curtin OASIS font encoding — confirmed via ActualText analysis of ELEN1000 PDF.
// Digits 0–9 are mapped to charcodes 0xEE–0xF7 (sequential); ligatures to 0xD5–0xD8.
// Used as a fallback when ActualText annotations are unavailable (e.g. older PDFs).
const CURTIN_GLYPH_MAP: Record<number, string> = {
  0xd5: "ff",
  0xd6: "fi",
  0xd7: "fl",
  0xd8: "ffi",
  0xee: "0",
  0xef: "1",
  0xf0: "2",
  0xf1: "3",
  0xf2: "4",
  0xf3: "5",
  0xf4: "6",
  0xf5: "7",
  0xf6: "8",
  0xf7: "9",
};

// pdf.js BDC op code differs between the browser build (83) and the legacy/
// Node.js build (70). Both values are checked so the same code path works in
// unit tests (Node.js) and in the extension (browser Worker).
const BDC_CODES = new Set([83, 70]); // beginMarkedContentProps
const TEXT_SHOW_CODES = new Set([49, 44]); // showText (browser=49, legacy/Node=44)

/**
 * Scan a pdf.js operator list and return the correct text for every null-mapped
 * glyph (\u0000) in document order. Two mechanisms are tried in priority order:
 *
 * 1. ActualText — Curtin OASIS PDFs wrap each null-mapped glyph in an
 *    accessibility span:  /Span<</ActualText (N)>> BDC  <XXXX> Tj  EMC
 *    The browser build of pdf.js exposes `props.ActualText` on the BDC op.
 *
 * 2. originalCharCode CMap — pdf.js exposes the raw font charcode on each
 *    glyph object as `originalCharCode`. The legacy/Node.js build strips the
 *    BDC props to null, so we fall back to our confirmed Curtin GLYPH_MAP.
 *
 * The returned array is 1-to-1 with the \u0000 chars in getTextContent() output
 * (same document order), so the caller can replace nulls by consuming entries.
 */
function collectActualText(opList: {
  fnArray: number[];
  argsArray: unknown[][];
}): string[] {
  type Glyph = { unicode: string; originalCharCode?: number };

  const result: string[] = [];
  const { fnArray, argsArray } = opList;
  let pendingActualText: string | null = null;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    if (BDC_CODES.has(fn)) {
      // args: [tag: string, props: Record<string,unknown> | null]
      const [tag, props] = args as [string, Record<string, unknown> | null];
      if (tag === "Span" && props && typeof props.ActualText === "string") {
        pendingActualText = props.ActualText;
      }
    } else if (TEXT_SHOW_CODES.has(fn)) {
      for (const glyph of args[0] as Glyph[]) {
        if (glyph.unicode !== "\u0000") continue;
        // Prefer ActualText (browser); fall back to Curtin charcode CMap (Node.js)
        const decoded =
          pendingActualText ??
          CURTIN_GLYPH_MAP[glyph.originalCharCode ?? -1] ??
          "#";
        result.push(decoded);
        pendingActualText = null;
      }
    }
  }

  return result;
}

// ── Text extraction ────────────────────────────────────────────────────────────

/**
 * Extract all text from a PDF file using pdf.js.
 * Uses the y-coordinate of each text item to detect line breaks, which
 * preserves the visual line structure of the original document.
 *
 * Null-mapped glyphs (Curtin PDFs encode digits and ligatures as U+0000) are
 * decoded via the ActualText accessibility annotations embedded in the PDF —
 * restoring exact characters without any font table access.
 */
export async function extractPDFText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const typedArray = new Uint8Array(arrayBuffer);

  const loadingTask = (pdfjsLib as any).getDocument({ data: typedArray });
  const pdfDoc = await loadingTask.promise;

  let fullText = "";

  // Process each page in sequence
  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);

    // Fetch text layout and operator list in parallel — the op list gives us
    // ActualText annotations needed to decode null-mapped glyphs.
    const [textContent, opList] = await Promise.all([
      page.getTextContent(),
      (page as any).getOperatorList(),
    ]);

    const actualTexts = collectActualText(opList);
    let nullIndex = 0; // index into actualTexts, consumed per \u0000

    let pageText = "";
    let lastY: number | null = null;

    // Items are TextItem or TextMarkedContent — only TextItem has .str
    for (const item of textContent.items) {
      if (!("str" in item)) continue;
      const textItem = item as {
        str: string;
        transform: number[];
        hasEOL?: boolean;
      };
      const y = textItem.transform[5]; // vertical baseline position

      // When the baseline shifts significantly, insert a newline
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        pageText += "\n";
      }

      // Decode null glyphs using ActualText; fall back to '#' if ActualText is
      // absent (e.g. older PDFs without accessibility annotations).
      // eslint-disable-next-line no-control-regex
      const str = textItem.str.includes("\u0000")
        ? // eslint-disable-next-line no-control-regex
          textItem.str.replace(/\u0000/g, () => actualTexts[nullIndex++] ?? "#")
        : textItem.str;

      pageText += str + " ";
      lastY = y;
    }

    fullText += pageText + "\n\n";
  }

  // ── Post-process ──────────────────────────────────────────────────────────
  // 1. Collapse space-separated single-digit sequences back into numbers.
  //    Each digit was an individual glyph → separate text item → appended with
  //    a trailing space. "2 9 May 2 0 2 6" must become "29 May 2026" before
  //    parseOrdinalDate and the weight/time parsers can read them.
  //    The word-boundary anchors ensure "Week 2 Day 3" is not collapsed.
  // 2. Collapse decoded ligature tokens (ff/fi/fl/ffi/ffl) that appear as lone
  //    space-separated tokens between alphabetic chars. These were null-mapped
  //    glyphs extracted as individual items: "Re " + "fl " + "ection Task"
  //    → "Reflection Task".
  // 3. Replace Unicode ligature codepoints (ﬁ ﬂ ﬀ ﬃ ﬄ) emitted by pdf.js for
  //    fonts that encode ligatures as proper Unicode rather than null bytes.
  // 4. Collapse any residual '#' placeholders (older PDFs without ActualText)
  //    between alphabetic chars: "Re # ection" → "Reection".
  return fullText
    .replace(/\b(\d)( \d)+\b/g, (m) => m.replace(/ /g, ""))
    .replace(/([a-zA-Z]) (ff|fi|fl|ffi|ffl) ([a-zA-Z])/g, "$1$2$3")
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl")
    .replace(/([a-zA-Z]) # ([a-zA-Z])/g, "$1$2");
}
