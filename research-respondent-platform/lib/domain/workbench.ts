/** Browser-portable preparation from literal source values. No transport or inference. */
export type Cell = string | number | boolean | null;
export interface Dataset { name: string; headers: string[]; rows: Array<{ line: number; values: Cell[] }> }
export interface Rule { column: number; op: "eq" | "ne" | "contains" | "gte" | "lte" | "present" | "missing"; value: string; label: string }
export interface FieldMapping { question: string; column: number | null; required: boolean }
export interface Workspace {
  version: 1; dataset: Dataset | null; checksum: string; reference: string; purpose: string;
  rules: Rule[]; match: "all" | "any"; formUrl: string; fields: FieldMapping[]; idColumn: number | null;
  sourceRows?: number[];
}
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_CELLS = 250000;
export function emptyWorkspace(): Workspace {
  return { version: 1, dataset: null, checksum: "", reference: "", purpose: "", rules: [], match: "all", formUrl: "", fields: [], idColumn: null };
}
const missing = (cell: Cell | undefined) => cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "");
const isCell = (value: unknown): value is Cell => value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

function validateDataset(dataset: Dataset): Dataset {
  if (!dataset.headers.length || dataset.headers.some((x) => !x) || new Set(dataset.headers).size !== dataset.headers.length) throw new Error("Заголовки должны быть заполнены и уникальны. Различите повторяющиеся вопросы.");
  if (!dataset.rows.length) throw new Error("В файле нет записей.");
  if (dataset.rows.length > MAX_ROWS || dataset.rows.length * dataset.headers.length > MAX_CELLS) throw new Error("Для первой версии: до 5000 записей и 250 000 ячеек. Разделите файл.");
  if (dataset.rows.some((row) => row.values.length !== dataset.headers.length || !row.values.every(isCell))) throw new Error("Строки должны совпадать с заголовками и содержать только значения ячеек.");
  const originColumn = dataset.headers.indexOf("data_origin");
  if (originColumn >= 0 && dataset.rows.some((row) => row.values[originColumn] === "modeled")) throw new Error("Модельные профили нельзя переносить как фактические ответы.");
  return dataset;
}

export function parseSource(name: string, text: string): Dataset {
  if (/\.json$/i.test(name)) {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw) && raw && typeof raw === "object" && "data_origin" in raw && raw.data_origin === "modeled") throw new Error("Файл содержит модельные профили, а не таблицу фактических ответов. Используйте их отдельный формат из PR #6.");
    const records = Array.isArray(raw) ? raw : raw && typeof raw === "object" && "records" in raw ? raw.records : null;
    if (!Array.isArray(records) || !records.length || records.some((x) => !x || typeof x !== "object" || Array.isArray(x))) throw new Error("JSON: нужен массив записей или объект с массивом records.");
    if (records.some((x) => x.data_origin === "modeled")) throw new Error("Модельные профили нельзя переносить как фактические ответы.");
    const headers = [...new Set(records.flatMap((x) => Object.keys(x)))];
    return validateDataset({ name, headers, rows: records.map((row, i) => ({ line: i + 1, values: headers.map((key) => Object.hasOwn(row, key) ? row[key] : null) })) });
  }
  if (!/\.(csv|tsv|txt)$/i.test(name)) throw new Error("Загрузите CSV, TSV или JSON. XLSX сначала сохраните как CSV UTF-8.");
  const content = text.replace(/^\uFEFF/, "");
  let quote = false;
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  for (const c of content) { if (c === '"') quote = !quote; if (!quote && c === "\n") break; if (!quote && counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1); }
  const delimiter = /\.tsv$/i.test(name) ? "\t" : [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const records: Array<{ line: number; values: string[] }> = [];
  let field = "", values: string[] = [], inQuotes = false, closed = false, line = 1, startLine = 1;
  const finish = () => { values.push(field); if (values.some((x) => x !== "")) records.push({ line: startLine, values }); field = ""; values = []; closed = false; };
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!;
    if (inQuotes) {
      if (c === '"') { if (content[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; closed = true; } }
      else { field += c; if (c === "\n") line++; }
    } else if (c === '"') { if (field || closed) throw new Error(`Строка ${line}: некорректные кавычки.`); inQuotes = true; }
    else if (c === delimiter) { values.push(field); field = ""; closed = false; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && content[i + 1] === "\n") i++; finish(); line++; startLine = line; }
    else { if (closed) throw new Error(`Строка ${line}: символ после закрывающей кавычки.`); field += c; }
  }
  if (inQuotes) throw new Error("В CSV не закрыты кавычки. Исправьте файл перед импортом.");
  if (field || values.length || closed) finish();
  const header = records.shift();
  return validateDataset({ name, headers: header?.values.map((x) => x.trim()) ?? [], rows: records.map((row) => ({ line: row.line, values: row.values.map((x) => x === "" ? null : x) })) });
}

export function matchesRule(values: Cell[], rule: Rule): boolean {
  const cell = values[rule.column];
  if (rule.op === "missing") return missing(cell);
  if (rule.op === "present") return !missing(cell);
  if (missing(cell) || rule.value.trim() === "") return false;
  const text = String(cell);
  if (rule.op === "eq") return text === rule.value;
  if (rule.op === "ne") return text !== rule.value;
  if (rule.op === "contains") return text.toLocaleLowerCase("ru").includes(rule.value.toLocaleLowerCase("ru"));
  const number = Number(text.replace(",", "."));
  const expected = Number(rule.value.replace(",", "."));
  return Number.isFinite(number) && Number.isFinite(expected) && (rule.op === "gte" ? number >= expected : number <= expected);
}
export function selectedRows(workspace: Workspace) {
  const scope = workspace.sourceRows ? new Set(workspace.sourceRows) : null;
  return workspace.dataset?.rows.filter((row) => (!scope || scope.has(row.line)) && (!workspace.rules.length || (workspace.match === "all" ? workspace.rules.every((r) => matchesRule(row.values, r)) : workspace.rules.some((r) => matchesRule(row.values, r))))) ?? [];
}
export function validFormUrl(raw: string): boolean {
  try { const url = new URL(raw); return url.protocol === "https:" && !url.username && !url.password && (url.hostname === "forms.gle" || (url.hostname === "docs.google.com" && url.pathname.startsWith("/forms/"))); } catch { return false; }
}
export function preparationProblems(workspace: Workspace): string[] {
  const problems: string[] = [];
  if (!workspace.dataset) return ["Загрузите базу ответов."];
  const validColumn = (column: number | null) => column !== null && Number.isInteger(column) && column >= 0 && column < workspace.dataset!.headers.length;
  if (workspace.rules.some((rule) => !validColumn(rule.column))) problems.push("Критерий ссылается на отсутствующий столбец.");
  if (!/^[a-f0-9]{64}$/.test(workspace.checksum) || !workspace.reference.trim()) problems.push("Укажите источник и контрольную сумму файла.");
  if (!workspace.purpose.trim()) problems.push("Опишите задачу.");
  if (!validFormUrl(workspace.formUrl)) problems.push("Укажите HTTPS-ссылку Google Forms.");
  if (!workspace.fields.length) problems.push("Добавьте вопросы и сопоставьте столбцы.");
  const names = workspace.fields.map((f) => f.question.trim());
  if (names.some((x) => !x) || new Set(names).size !== names.length) problems.push("Вопросы должны иметь уникальные заполненные названия (добавьте раздел при повторении).");
  const rows = selectedRows(workspace);
  if (!rows.length) problems.push("Под критерии не подходит ни одна запись.");
  if (!validColumn(workspace.idColumn)) problems.push("Выберите столбец ID участника.");
  else {
    const ids = rows.map((r) => r.values[workspace.idColumn!]);
    if (ids.some(missing) || new Set(ids.map(String)).size !== ids.length) problems.push("В отобранных записях есть пустые или повторяющиеся ID. Уточните идентификаторы.");
  }
  for (const field of workspace.fields) {
    if (!validColumn(field.column)) { problems.push(`Не сопоставлен вопрос: ${field.question || "без названия"}.`); continue; }
    if (field.required) {
      const count = rows.filter((r) => missing(r.values[field.column!])).length;
      if (count) problems.push(`${field.question}: отсутствуют ${count} обязательных ответов. Их нужно получить от участников.`);
    }
  }
  return problems;
}
export function buildPacket(workspace: Workspace) {
  const problems = preparationProblems(workspace);
  if (problems.length) throw new Error(problems.join("\n"));
  const dataset = workspace.dataset!;
  return {
    schema: "rrp.form-preparation.v1", status: "prepared", data_origin: "user-provided", purpose: workspace.purpose,
    source: { name: dataset.name, reference: workspace.reference, sha256: workspace.checksum },
    selection: { match: workspace.match, rules: workspace.rules }, form: { url: workspace.formUrl, fields: workspace.fields },
    execution: { skill: "fill-google-forms", external_submission: false, recipient_authorization_required: true, missing_answers: "ask_participant", preserve_literal_answers: true, confirmation_required: "visible_response_recorded" },
    respondents: selectedRows(workspace).map((row) => ({ participant_ref: String(row.values[workspace.idColumn!]), source_row: row.line,
      classifications: workspace.rules.filter((r) => matchesRule(row.values, r)).map((r) => r.label).filter(Boolean),
      answers: workspace.fields.map((f) => ({ question: f.question, required: f.required, value: row.values[f.column!] ?? null, source: { column: dataset.headers[f.column!], row: row.line, sha256: workspace.checksum } })),
    })),
  };
}

/** Validate project files before restoring browser state; never execute file content. */
export function restoreWorkspace(text: string): Workspace {
  const raw = JSON.parse(text) as Workspace;
  if (!raw || raw.version !== 1 || typeof raw.checksum !== "string" || typeof raw.reference !== "string" || typeof raw.purpose !== "string" || typeof raw.formUrl !== "string" || !["all", "any"].includes(raw.match) || !Array.isArray(raw.fields) || !Array.isArray(raw.rules)) throw new Error("Некорректный формат проекта версии 1.");
  if (raw.dataset) {
    if (typeof raw.dataset.name !== "string" || !Array.isArray(raw.dataset.headers) || !raw.dataset.headers.every((x) => typeof x === "string") || !Array.isArray(raw.dataset.rows) || raw.dataset.rows.some((r) => !r || !Number.isSafeInteger(r.line) || r.line < 1 || !Array.isArray(r.values))) throw new Error("Некорректная база в проекте.");
    validateDataset(raw.dataset);
  }
  const columns = raw.dataset?.headers.length ?? 0;
  if (raw.sourceRows !== undefined && (!raw.dataset || !Array.isArray(raw.sourceRows) || !raw.sourceRows.length || raw.sourceRows.length > MAX_ROWS
    || new Set(raw.sourceRows).size !== raw.sourceRows.length || raw.sourceRows.some((line) => !Number.isSafeInteger(line) || !raw.dataset!.rows.some((r) => r.line === line)))) throw new Error("Некорректный список исходных строк.");
  const columnValid = (c: unknown) => Number.isInteger(c) && Number(c) >= 0 && Number(c) < columns;
  if (raw.idColumn !== null && !columnValid(raw.idColumn)) throw new Error("Некорректный столбец ID.");
  if (raw.fields.some((f) => !f || typeof f.question !== "string" || typeof f.required !== "boolean" || (f.column !== null && !columnValid(f.column)))) throw new Error("Некорректная карта вопросов.");
  if (raw.rules.some((r) => !r || !columnValid(r.column) || !["eq", "ne", "contains", "gte", "lte", "present", "missing"].includes(r.op) || typeof r.value !== "string" || typeof r.label !== "string")) throw new Error("Некорректные критерии.");
  return { ...emptyWorkspace(), ...raw };
}
