import { initPdfWorker, extractPDFText } from "./src/pdf/extract.ts";
import { parseAssessments } from "./src/pdf/parseAssessments.ts";
import { parseProgramCalendar } from "./src/pdf/parseProgramCalendar.ts";
import { mergeWithCalendar, addSequenceNumbers } from "./src/pdf/index.ts";
import { readFileSync } from "fs";
import { join } from "path";

const pdfPath = process.argv[2] ?? "/Users/n0xde/Downloads/ELEN1000 Electrical Systems Semester 1 2026 Bentley Perth Campus INT.pdf";
const unit = (process.argv[3] ?? "ELEN1000").toUpperCase();

initPdfWorker(join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.js"));
const buf = readFileSync(pdfPath);
const file = new File([buf], `${unit}.pdf`, { type: "application/pdf" });
const text = await extractPDFText(file);

const assessments = parseAssessments(text, unit, 2026, 1);
const calendar = parseProgramCalendar(text, unit, 2026, 1);
const merged = mergeWithCalendar(assessments, calendar);
const final = addSequenceNumbers(merged);

console.log(`=== ${unit} (${final.length} items) ===`);
for (const a of final) {
  const date = a.resolvedDate ? new Date(a.resolvedDate).toDateString() : "TBA";
  console.log(`  [${a.isTBA ? "TBA" : "OK "}] ${a.title.padEnd(40)} | w${String(a.week ?? "?").padEnd(3)} | ${date.padEnd(18)} | ${a.weight ?? "?"}%`);
}
