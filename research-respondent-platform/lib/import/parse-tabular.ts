/**
 * Minimal, dependency-free readers for tabular source documents.
 *
 * Supports CSV/TSV text exports and .xlsx workbooks (ZIP + sparse XML). The
 * platform deliberately avoids a heavy spreadsheet dependency: imports must be
 * transparent and auditable, and only cell values are read - formulas, styles
 * and macros are ignored.
 */
import { inflateRawSync } from "node:zlib";

export interface ParsedTable {
  sheetName: string;
  /** First row is treated as the header row when `hasHeader` is true. */
  headers: string[];
  rows: Array<Array<string | number | boolean | null>>;
  /** Excel row numbers (1-based) aligned with `rows`, for provenance locators. */
  rowNumbers: number[];
  warnings: string[];
}

// ------------------------------------------------------------------- CSV ---

/** RFC 4180-ish parser with delimiter sniffing and quoted-field support. */
export function parseDelimited(text: string, options: { delimiter?: string; sheetName?: string } = {}): ParsedTable {
  const content = text.replace(/^\uFEFF/, "");
  const delimiter = options.delimiter ?? sniffDelimiter(content);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }
    field += char;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const warnings: string[] = [];
  const nonEmpty = records.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (nonEmpty.length === 0) {
    return { sheetName: options.sheetName ?? "Sheet1", headers: [], rows: [], rowNumbers: [], warnings: ["No data rows found."] };
  }
  const headerRow = nonEmpty[0] ?? [];
  const headers = headerRow.map((cell, index) => (cell.trim().length > 0 ? cell.trim() : `column_${index + 1}`));
  const rows: Array<Array<string | number | boolean | null>> = [];
  const rowNumbers: number[] = [];
  for (let index = 1; index < nonEmpty.length; index += 1) {
    const row = nonEmpty[index] ?? [];
    if (row.length !== headers.length) {
      warnings.push(
        `Row ${index + 1} has ${row.length} cells while the header has ${headers.length}; extra cells were kept, missing cells are recorded as missing.`,
      );
    }
    const padded: Array<string | number | boolean | null> = [];
    for (let column = 0; column < headers.length; column += 1) {
      const cell = row[column];
      padded.push(cell === undefined || cell === "" ? null : cell);
    }
    rows.push(padded);
    rowNumbers.push(index + 1);
  }
  return { sheetName: options.sheetName ?? "Sheet1", headers, rows, rowNumbers, warnings };
}

function sniffDelimiter(content: string): string {
  const sample = content.slice(0, 8192);
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = sample.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

// ----------------------------------------------------------------- XLSX ---

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Reads a ZIP archive using the central directory; supports stored + deflate. */
export function readZip(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 66_000); index -= 1) {
    if (buffer.readUInt32LE(index) === eocdSignature) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Not a ZIP archive: end-of-central-directory record not found.");
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Corrupt ZIP central directory.");
    }
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (compression === 0) {
      entries.push({ name, data: Buffer.from(raw) });
    } else if (compression === 8) {
      entries.push({ name, data: inflateRawSync(raw) });
    }
  }
  return entries;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function columnIndexFromRef(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? "A";
  let value = 0;
  for (const char of letters) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value - 1;
}

/** Excel serial date (1900 system, with the leap-year bug) to ISO date. */
export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) {
    return null;
  }
  const days = Math.floor(serial);
  const fraction = serial - days;
  const epoch = Date.UTC(1899, 11, 30);
  const millis = epoch + days * 86_400_000 + Math.round(fraction * 86_400_000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

interface SharedStrings {
  values: string[];
  richText: boolean[];
}

function parseSharedStrings(xml: string | undefined): SharedStrings {
  const values: string[] = [];
  const richText: boolean[] = [];
  if (!xml) {
    return { values, richText };
  }
  const items = xml.split("<si>").slice(1);
  for (const item of items) {
    const chunk = item.split("</si>")[0] ?? "";
    const runs = chunk.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    const text = runs
      .map((run) => decodeXmlEntities(run.replace(/<[^>]+>/g, "")))
      .join("");
    values.push(text);
    richText.push(runs.length > 1);
  }
  return { values, richText };
}

function parseStyles(xml: string | undefined): Array<{ numFmtId: number }> {
  if (!xml) {
    return [];
  }
  const cellXfs = /<cellXfs[\s\S]*?<\/cellXfs>/.exec(xml)?.[0] ?? "";
  const entries = cellXfs.match(/<xf\b[^>]*>/g) ?? [];
  return entries.map((entry) => {
    const numFmt = /numFmtId="(\d+)"/.exec(entry)?.[1];
    return { numFmtId: numFmt ? Number.parseInt(numFmt, 10) : 0 };
  });
}

/** Custom number formats declared in the workbook (`<numFmt numFmtId="164" formatCode="..."/>`). */
function parseNumberFormats(xml: string | undefined): Map<number, string> {
  const map = new Map<number, string>();
  if (!xml) {
    return map;
  }
  for (const match of xml.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    const id = /numFmtId="(\d+)"/.exec(match[0])?.[1];
    const code = /formatCode="([^"]*)"/.exec(match[0])?.[1];
    if (id && code !== undefined) {
      map.set(Number.parseInt(id, 10), decodeXmlEntities(code));
    }
  }
  return map;
}

const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/**
 * True when a number format displays a date/time. Google Forms exports and SPSS
 * workbooks commonly declare custom formats (numFmtId >= 164), so the format
 * code is inspected rather than relying on the built-in id list alone.
 */
export function isDateFormat(numFmtId: number, customFormats: Map<number, string>): boolean {
  if (DATE_FORMAT_IDS.has(numFmtId)) {
    return true;
  }
  const code = customFormats.get(numFmtId);
  if (!code) {
    return false;
  }
  const stripped = code
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped) && !/^[#0.,%\s]+$/.test(stripped);
}

/**
 * Reads the first (or named) worksheet of an .xlsx workbook.
 * Only literal values are read; formula results are used when cached, otherwise
 * the cell is reported as missing rather than guessed.
 */
export function parseXlsx(buffer: Buffer, options: { sheetName?: string } = {}): ParsedTable {
  const entries = readZip(buffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
  const workbookXml = byName.get("xl/workbook.xml")?.toString("utf8");
  const relsXml = byName.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!workbookXml) {
    throw new Error("Workbook is missing xl/workbook.xml.");
  }
  const shared = parseSharedStrings(byName.get("xl/sharedStrings.xml")?.toString("utf8"));
  const stylesXml = byName.get("xl/styles.xml")?.toString("utf8");
  const styles = parseStyles(stylesXml);
  const customFormats = parseNumberFormats(stylesXml);

  const sheetMatches = [...workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)].map((match) => match[0]);
  const sheets = sheetMatches.map((tag) => ({
    name: decodeXmlEntities(/name="([^"]*)"/.exec(tag)?.[1] ?? "Sheet"),
    relId: /r:id="([^"]*)"/.exec(tag)?.[1] ?? "",
  }));
  const relMap = new Map<string, string>();
  for (const match of (relsXml ?? "").matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = match[0];
    const id = /Id="([^"]*)"/.exec(tag)?.[1];
    const target = /Target="([^"]*)"/.exec(tag)?.[1];
    if (id && target) {
      relMap.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
    }
  }

  const warnings: string[] = [];
  const requested = options.sheetName
    ? sheets.find((sheet) => sheet.name === options.sheetName)
    : sheets[0];
  if (!requested) {
    throw new Error(
      `Worksheet "${options.sheetName ?? "(first)"}" not found. Available: ${sheets.map((sheet) => sheet.name).join(", ")}`,
    );
  }
  const target = relMap.get(requested.relId) ?? `worksheets/sheet1.xml`;
  const sheetXml = byName.get(`xl/${target}`)?.toString("utf8") ?? byName.get(target)?.toString("utf8");
  if (!sheetXml) {
    throw new Error(`Worksheet data for "${requested.name}" not found in the workbook.`);
  }

  const grid: Array<Map<number, string | number | boolean | null>> = [];
  const rowMatches = [...sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
  let maxColumn = -1;
  const rowIndexes: number[] = [];
  for (const rowMatch of rowMatches) {
    const rowTag = rowMatch[0].slice(0, rowMatch[0].indexOf(">") + 1);
    const declaredRow = Number.parseInt(/r="(\d+)"/.exec(rowTag)?.[1] ?? "0", 10);
    const cells = new Map<number, string | number | boolean | null>();
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)) {
      const cellTag = cellMatch[0];
      const openTag = cellTag.slice(0, cellTag.indexOf(">") + 1);
      const reference = /r="([A-Z]+\d+)"/.exec(openTag)?.[1];
      if (!reference) {
        continue;
      }
      const column = columnIndexFromRef(reference);
      maxColumn = Math.max(maxColumn, column);
      const type = /t="([^"]+)"/.exec(openTag)?.[1] ?? "n";
      const styleIndex = Number.parseInt(/s="(\d+)"/.exec(openTag)?.[1] ?? "-1", 10);
      const isDateStyle = styleIndex >= 0 && isDateFormat(styles[styleIndex]?.numFmtId ?? 0, customFormats);
      const formula = /<f\b[^>]*>[\s\S]*?<\/f>/.test(cellTag);
      const valueTag = /<v>([\s\S]*?)<\/v>/.exec(cellTag)?.[1];
      const inlineTag = /<is>([\s\S]*?)<\/is>/.exec(cellTag)?.[1];

      if (type === "inlineStr" && inlineTag) {
        const text = decodeXmlEntities((inlineTag.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [inlineTag]).map((run) => run.replace(/<[^>]+>/g, "")).join(""));
        cells.set(column, text);
        continue;
      }
      if (valueTag === undefined) {
        if (formula) {
          warnings.push(`Cell ${reference} contains a formula without a cached value; recorded as missing.`);
          cells.set(column, null);
        }
        continue;
      }
      const raw = decodeXmlEntities(valueTag);
      if (type === "s") {
        const sharedIndex = Number.parseInt(raw, 10);
        const sharedValue = shared.values[sharedIndex];
        if (sharedValue === undefined) {
          warnings.push(`Cell ${reference} references missing shared string ${sharedIndex}.`);
          cells.set(column, null);
        } else {
          cells.set(column, sharedValue);
        }
        continue;
      }
      if (type === "str") {
        cells.set(column, raw);
        continue;
      }
      if (type === "b") {
        cells.set(column, raw === "1");
        continue;
      }
      if (type === "e") {
        warnings.push(`Cell ${reference} holds the Excel error value ${raw}; recorded as missing.`);
        cells.set(column, null);
        continue;
      }
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) {
        cells.set(column, raw);
        continue;
      }
      if (isDateStyle && numeric > 0 && numeric < 2_958_465) {
        cells.set(column, excelSerialToIsoDate(numeric) ?? numeric);
        continue;
      }
      cells.set(column, numeric);
    }
    grid.push(cells);
    rowIndexes.push(declaredRow > 0 ? declaredRow : grid.length);
  }

  const headerCells = grid[0] ?? new Map();
  const headers: string[] = [];
  for (let column = 0; column <= maxColumn; column += 1) {
    const value = headerCells.get(column);
    const text = value === null || value === undefined ? "" : String(value).trim();
    headers.push(text.length > 0 ? text : `column_${column + 1}`);
  }
  const rows: Array<Array<string | number | boolean | null>> = [];
  const rowNumbers: number[] = [];
  for (let index = 1; index < grid.length; index += 1) {
    const cells = grid[index] ?? new Map();
    const row: Array<string | number | boolean | null> = [];
    let hasValue = false;
    for (let column = 0; column <= maxColumn; column += 1) {
      const value = cells.get(column);
      const normalised = value === "" ? null : value ?? null;
      if (normalised !== null) {
        hasValue = true;
      }
      row.push(normalised);
    }
    if (!hasValue) {
      continue;
    }
    rows.push(row);
    rowNumbers.push(rowIndexes[index] ?? index + 1);
  }
  return { sheetName: requested.name, headers, rows, rowNumbers, warnings };
}

/** Dispatches on file name/extension and content signature. */
export function parseTabularFile(fileName: string, buffer: Buffer, options: { sheetName?: string } = {}): ParsedTable {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || buffer.subarray(0, 2).toString("latin1") === "PK") {
    return parseXlsx(buffer, options);
  }
  const text = buffer.toString("utf8");
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) {
    return parseDelimited(text, { delimiter: "\t", sheetName: fileName });
  }
  return parseDelimited(text, { sheetName: fileName });
}

export function listSheetNames(buffer: Buffer): string[] {
  try {
    const entries = readZip(buffer);
    const workbookXml = entries.find((entry) => entry.name === "xl/workbook.xml")?.data.toString("utf8");
    if (!workbookXml) {
      return [];
    }
    return [...workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)].map((match) =>
      decodeXmlEntities(/name="([^"]*)"/.exec(match[0])?.[1] ?? "Sheet"),
    );
  } catch {
    return [];
  }
}
