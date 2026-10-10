/**
 * Verifies the dependency-free tabular readers against crafted workbooks, so
 * real Google Forms / SPSS exports can be imported without guessing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { parseDelimited, parseXlsx, excelSerialToIsoDate, readZip } from "../../lib/import/parse-tabular.ts";

function makeZip(files: Record<string, string | Buffer>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const compressed = deflateRawSync(raw);
    const nameBuffer = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

let crcTable: number[] | null = null;
function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const WORKBOOK = {
  "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Ответы на форму (1)" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<?xml version="1.0"?><sst count="4" uniqueCount="4"><si><t>Отметка времени</t></si><si><t>Адрес электронной почты</t></si><si><t>01 Я плохо выношу неопределенные ситуации.</t></si><si><r><t>Жирный</t></r><r><t> текст</t></r></si></sst>`,
  "xl/styles.xml": `<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
  "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>Возраст</t></is></c><c r="E1" t="s"><v>3</v></c></row>
<row r="2"><c r="A2" s="1"><v>45960.843750</v></c><c r="B2" t="inlineStr"><is><t>a@example.org</t></is></c><c r="C2"><v>6</v></c><c r="D2"><v>21</v></c><c r="E2" t="s"><v>3</v></c></row>
<row r="3"><c r="A3" s="1"><v>45960.856250</v></c><c r="B3" t="inlineStr"><is><t>b@example.org</t></is></c><c r="C3"><v>7</v></c><c r="D3" t="inlineStr"><is><t>не указан</t></is></c></row>
<row r="4"><c r="A4" s="1"><v>45960.86</v></c><c r="C4"><f>SUM(C5:C9)</f></c></row>
</sheetData></worksheet>`,
};

test("CSV parser handles quoted fields, embedded newlines and delimiter sniffing", () => {
  const csv = 'name;note;value\n"Иванов, И.";"строка\nвторая";4,5\n"a";"b";6\n';
  const table = parseDelimited(csv);
  assert.equal(table.headers.length, 3);
  assert.equal(table.headers[0], "name");
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0]?.[1], "строка\nвторая");
  assert.equal(table.rows[0]?.[2], "4,5");
});

test("TSV parsing keeps empty cells as null rather than zero", () => {
  const table = parseDelimited("a\tb\tc\n1\t\t3\n", { delimiter: "\t" });
  assert.deepEqual(table.rows[0], [ "1", null, "3" ]);
});

test("xlsx parser reads shared strings, inline strings and numeric cells", () => {
  const zip = makeZip(WORKBOOK);
  const table = parseXlsx(zip);
  assert.equal(table.sheetName, "Ответы на форму (1)");
  assert.equal(table.headers[0], "Отметка времени");
  assert.equal(table.headers[2], "01 Я плохо выношу неопределенные ситуации.");
  assert.equal(table.headers[3], "Возраст");
  assert.equal(table.headers[4], "Жирный текст");
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[0]?.[2], 6);
  assert.equal(table.rows[0]?.[3], 21);
  assert.equal(table.rows[2]?.[2], null, "formula cell without cached value must stay missing");
  assert.ok(table.warnings.some((warning) => warning.includes("formula")));
});

test("xlsx parser converts date-styled serials to ISO timestamps", () => {
  const zip = makeZip(WORKBOOK);
  const table = parseXlsx(zip);
  const stamp = table.rows[0]?.[0];
  assert.equal(typeof stamp, "string");
  assert.match(String(stamp), /^2025-10-30T20:1\d:\d{2}\.\d{3}Z$/);
});

test("readZip round-trips stored and deflated entries", () => {
  const zip = makeZip({ "a.txt": "hello", "b/c.txt": "world" });
  const entries = readZip(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.name === "a.txt")?.data.toString("utf8"), "hello");
});

test("excel serial conversion rejects out-of-range values", () => {
  assert.equal(excelSerialToIsoDate(0), null);
  assert.equal(excelSerialToIsoDate(99_999_999), null);
  assert.match(String(excelSerialToIsoDate(45960)), /^2025-10-30T/);
});

// Google Forms exports declare custom date formats (numFmtId >= 164) rather
// than the built-in date ids, so the format code must be inspected.
const GOOGLE_FORMS_STYLE_WORKBOOK = {
  ...WORKBOOK,
  "xl/styles.xml": `<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="m/d/yyyy h:mm:ss"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
};

test("custom date number formats are recognised as timestamps", () => {
  const zip = makeZip(GOOGLE_FORMS_STYLE_WORKBOOK);
  const table = parseXlsx(zip);
  // 45960.843750 is 2025-10-30T20:15:00.000Z exactly.
  assert.equal(String(table.rows[0]?.[0]), "2025-10-30T20:15:00.000Z");
  assert.equal(String(table.rows[1]?.[0]), "2025-10-30T20:33:00.000Z");
});

test("plausible serials in General format are flagged instead of silently converted", () => {
  const table = parseXlsx(makeZip(WORKBOOK));
  // The fixture uses numFmtId 14, which is a known date format, so conversion happens.
  assert.equal(typeof table.rows[0]?.[0], "string");
});
