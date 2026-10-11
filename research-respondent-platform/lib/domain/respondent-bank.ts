/** Pure, literal joins. Sources remain immutable; no inference or silent overwrite. */
import { z } from "zod";
import type { Cell, Dataset } from "./workbench.ts";

const header = z.string().min(1).max(2000).refine((s) => !!s.trim());
export const bankSpecSchema = z.object({
  mode: z.enum(["merge", "join"]), leftId: z.string().uuid(), rightId: z.string().uuid(),
  leftIdHeader: header, rightIdHeader: header,
  additionalKeyHeaders: z.array(header).max(2).default([]),
  name: z.string().trim().min(1).max(200), reference: z.string().trim().min(1).max(500),
  rights: z.string().trim().min(1).max(500),
}).strict().refine((s) => s.leftId !== s.rightId, "Выберите два разных источника.")
  .refine((s) => !s.additionalKeyHeaders.includes(s.leftIdHeader) && !s.additionalKeyHeaders.includes(s.rightIdHeader)
    && new Set(s.additionalKeyHeaders).size === s.additionalKeyHeaders.length, "Столбцы ключа должны быть разными.");
export type BankSpec = z.output<typeof bankSpecSchema>;
export interface BankIssue { code: "invalid_key" | "duplicate_key" | "conflicting_value"; header: string; leftLine: number; rightLine?: number; source: "left" | "right" }
export interface BankSummary { leftRecords: number; rightRecords: number; resultRecords: number;
  addedRecords: number; matchedRecords: number; filledCells: number; duplicatesRemoved: number;
  unmatchedRecords: number; unusedProfiles: number; conflicts: number; issues: BankIssue[] }
export interface BankRowOrigin { source: "left" | "right"; line: number }
export interface BankPlan { headers: string[]; rows: Cell[][]; origins: BankRowOrigin[][]; summary: BankSummary }
const missing = (v: Cell | undefined) => v === null || v === undefined || (typeof v === "string" && !v.trim());
const equal = (a: Cell | undefined, b: Cell | undefined) => (missing(a) && missing(b)) || a === b;

export function planBank(spec: BankSpec, left: Dataset, right: Dataset): BankPlan {
  const summary: BankSummary = { leftRecords: left.rows.length, rightRecords: right.rows.length, resultRecords: 0,
    addedRecords: 0, matchedRecords: 0, filledCells: 0, duplicatesRemoved: 0, unmatchedRecords: 0, unusedProfiles: 0, conflicts: 0, issues: [] };
  const issue = (value: BankIssue) => { summary.conflicts++; if (summary.issues.length < 20) summary.issues.push(value); };
  for (const [table, name] of [[left, spec.leftIdHeader], [right, spec.rightIdHeader]] as const) {
    if (!table.headers.includes(name)) throw new TypeError("В источнике отсутствует выбранный столбец ID.");
  }
  if (spec.leftIdHeader !== spec.rightIdHeader && right.headers.includes(spec.leftIdHeader)) throw new TypeError("В правом источнике уже есть столбец с именем левого ID. Уточните заголовки.");
  for (const name of spec.additionalKeyHeaders) {
    if (!left.headers.includes(name) || (spec.mode === "merge" && !right.headers.includes(name))) throw new TypeError("В источнике отсутствует дополнительный столбец ключа.");
  }
  const headers = [...left.headers, ...right.headers.filter((h) => h !== spec.rightIdHeader && !left.headers.includes(h))];
  if (headers.length > 2000) throw new TypeError("Результат превышает 2000 столбцов. Разделите банк по методикам.");
  type Entry = { row: Dataset["rows"][number]; origins: BankRowOrigin[] };
  function index(table: Dataset, keys: string[], source: "left" | "right") {
    const columns = keys.map((h) => table.headers.indexOf(h)); const entries = new Map<string, Entry>();
    for (const row of table.rows) {
      const values = columns.map((c) => row.values[c]);
      if (values.some((v) => missing(v) || !["string", "number"].includes(typeof v) || String(v) !== String(v).trim())) {
        issue({ code: "invalid_key", header: keys.join(" + "), leftLine: row.line, source }); continue;
      }
      // JSON tuple prevents separator collisions; zero/leading zero IDs remain distinct.
      const key = JSON.stringify(values.map(String)); const previous = entries.get(key);
      if (!previous) entries.set(key, { row, origins: [{ source, line: row.line }] });
      else if (previous.row.values.every((v, i) => equal(v, row.values[i]))) {
        summary.duplicatesRemoved++; previous.origins.push({ source, line: row.line });
      } else issue({ code: "duplicate_key", header: keys.join(" + "), leftLine: previous.row.line, rightLine: row.line, source });
    }
    return entries;
  }
  const leftEntries = index(left, [spec.leftIdHeader, ...spec.additionalKeyHeaders], "left");
  const rightEntries = index(right, [spec.rightIdHeader, ...(spec.mode === "merge" ? spec.additionalKeyHeaders : [])], "right");
  const leftColumns = headers.map((h) => left.headers.indexOf(h));
  const rightColumns = headers.map((h) => right.headers.indexOf(h === spec.leftIdHeader ? spec.rightIdHeader : h));
  const rows: Cell[][] = [], origins: BankRowOrigin[][] = []; const used = new Set<string>();
  function append(a: Entry | undefined, b: Entry | undefined) {
    if ((rows.length + 1) > 5000 || (rows.length + 1) * headers.length > 250000) throw new TypeError("Результат превышает 5000 записей или 250 000 ячеек. Разделите банк.");
    const cells = headers.map((h, i) => {
      const av = a?.row.values[leftColumns[i]!] ?? null, bv = b?.row.values[rightColumns[i]!] ?? null;
      if (a && b && !missing(av) && !missing(bv) && !equal(av, bv)) issue({ code: "conflicting_value", header: h, leftLine: a.row.line, rightLine: b.row.line, source: "left" });
      if (a && b && missing(av) && !missing(bv)) summary.filledCells++;
      // Preserve the original left missing value when both sources lack a value.
      return !missing(av) ? av : !missing(bv) ? bv : a ? av : bv;
    });
    rows.push(cells); origins.push([...(a?.origins ?? []), ...(b?.origins ?? [])]);
  }
  for (const [key, entry] of leftEntries) {
    const lookup = spec.mode === "merge" ? key : JSON.stringify([String(entry.row.values[left.headers.indexOf(spec.leftIdHeader)])]);
    const match = rightEntries.get(lookup);
    if (match) { summary.matchedRecords++; used.add(lookup); }
    else if (spec.mode === "join") summary.unmatchedRecords++;
    append(entry, match);
  }
  if (spec.mode === "merge") {
    for (const [key, entry] of rightEntries) if (!leftEntries.has(key)) { append(undefined, entry); summary.addedRecords++; }
  } else summary.unusedProfiles = rightEntries.size - used.size;
  summary.resultRecords = rows.length;
  return { headers, rows, origins, summary };
}

/** Positional rows avoid object/prototype keys; JSON objects stay compatible with the importer. */
export function bankJson(plan: BankPlan): string {
  return JSON.stringify(plan.rows.map((cells) => Object.fromEntries(plan.headers.map((h, i) => [h, cells[i]]))));
}
