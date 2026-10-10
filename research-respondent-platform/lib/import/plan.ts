/**
 * Import planner.
 *
 * Turns a parsed spreadsheet/CSV export into a reviewable plan: which column
 * feeds which instrument item, which cells are missing, which values are out of
 * range, and which rows are unusable. Nothing is written to the research
 * database until a plan containing zero blockers is committed.
 */
import type {
  ImportColumn,
  ImportFieldRole,
  ImportOptions,
  ImportPlan,
  ImportPlanRow,
  ImportSourceDescriptor,
  RuleIssue,
} from "../domain/types.ts";
import { DomainError } from "../domain/types.ts";
import { parseDelimited, parseTabularFile, type ParsedTable } from "./parse-tabular.ts";

export interface ItemSpec {
  itemCode: string;
  questionText: string;
  responseType: string;
  options: string[];
  minValue: number | null;
  maxValue: number | null;
  required: boolean;
  reverseScored: boolean;
  itemDefinitionId: string;
  orderIndex: number;
}

export interface PlanInput {
  fileName: string;
  buffer: Buffer;
  sheetName?: string;
  descriptor: ImportSourceDescriptor;
  options: ImportOptions;
  items: ItemSpec[];
  participantAttributes?: Array<{ attribute: string; sourceHeader: string }>;
  /** Column header overrides chosen by the operator. */
  columnOverrides?: Record<number, Partial<ImportColumn>>;
  /** Session-level quality flags recorded by the operator. */
  qualityFlags?: string[];
}

const HEADER_ITEM_PATTERN = /^\s*(?:var\d+\s*)?(\d{1,3})\b[\s.:)\-]*(.*)$/i;

/**
 * Suggests a role for each column. Suggestions are deterministic; the operator
 * reviews and can override every one of them before commit.
 */
export function inferColumns(headers: string[], items: ItemSpec[], attributes: Array<{ attribute: string; sourceHeader: string }> = []): ImportColumn[] {
  const byCode = new Map(items.map((item) => [item.itemCode.trim().toLowerCase(), item]));
  const normalise = (value: string) =>
    value
      .replace(/\u00a0/g, " ")
      .replace(/[«»"'`]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("ru-RU");

  return headers.map((header, index) => {
    const cleaned = header.trim();
    const lower = normalise(cleaned);

    if (/^(отметка времени|timestamp|дата и время|время отправки|submitted at|дата заполнения)/.test(lower)) {
      return { index, header: cleaned, role: "collected_at" as ImportFieldRole };
    }
    if (/^(адрес электронной почты|email|e-mail|почта|correo)/.test(lower) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned)) {
      return {
        index,
        header: cleaned,
        role: "identity_email" as ImportFieldRole,
        identityField: "contact_email" as const,
      };
    }
    if (/^(имя и фамилия|фио|имя|полное имя|name|full name)/.test(lower)) {
      return { index, header: cleaned, role: "identity_name" as ImportFieldRole, identityField: "full_name" as const };
    }
    if (/^(телефон|номер телефона|phone)/.test(lower)) {
      return {
        index,
        header: cleaned,
        role: "identity_name" as ImportFieldRole,
        identityField: "contact_phone" as const,
      };
    }
    if (/^(id|№|номер|код участника|participant|respondent|респондент)/.test(lower) && !HEADER_ITEM_PATTERN.test(cleaned)) {
      return { index, header: cleaned, role: "participant_key" as ImportFieldRole };
    }
    for (const attribute of attributes) {
      if (normalise(attribute.sourceHeader) === lower) {
        return { index, header: cleaned, role: "participant_attribute" as ImportFieldRole, attribute: attribute.attribute };
      }
    }
    // Instrument items: either an explicit item code prefix or an exact text match.
    const codeMatch = HEADER_ITEM_PATTERN.exec(cleaned);
    if (codeMatch?.[1]) {
      const code = codeMatch[1].padStart(2, "0");
      const direct = byCode.get(code.toLowerCase()) ?? byCode.get(codeMatch[1].toLowerCase());
      const textMatch = items.find((item) => normalise(item.questionText) === normalise(codeMatch[2] ?? ""));
      const resolved = direct ?? textMatch;
      if (resolved) {
        return {
          index,
          header: cleaned,
          role: "instrument_item" as ImportFieldRole,
          itemCode: resolved.itemCode,
          options: resolved.options,
          minValue: resolved.minValue,
          maxValue: resolved.maxValue,
        };
      }
    }
    const textOnly = items.find((item) => normalise(item.questionText) === lower);
    if (textOnly) {
      return {
        index,
        header: cleaned,
        role: "instrument_item" as ImportFieldRole,
        itemCode: textOnly.itemCode,
        options: textOnly.options,
        minValue: textOnly.minValue,
        maxValue: textOnly.maxValue,
      };
    }
    return { index, header: cleaned, role: "ignore" as ImportFieldRole };
  });
}

export function parseSourceTable(input: { fileName: string; buffer: Buffer; sheetName?: string }): ParsedTable {
  try {
    return parseTabularFile(input.fileName, input.buffer, { sheetName: input.sheetName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DomainError("import.unreadable_source", `Could not read ${input.fileName}: ${message}`);
  }
}

export function parseDelimitedSource(text: string, fileName: string): ParsedTable {
  return parseDelimited(text, { sheetName: fileName });
}

/** Normalises a documented cell to a numeric value, preserving the raw text. */
export function coerceNumeric(raw: string | number | boolean | null): { numeric: number | null; issue: string | null } {
  if (raw === null || raw === undefined) {
    return { numeric: null, issue: null };
  }
  if (typeof raw === "number") {
    return { numeric: Number.isFinite(raw) ? raw : null, issue: null };
  }
  if (typeof raw === "boolean") {
    return { numeric: raw ? 1 : 0, issue: null };
  }
  const text = raw.toString().trim().replace(/\u00a0/g, " ");
  if (text.length === 0) {
    return { numeric: null, issue: null };
  }
  const normalised = text.replace(/\s/g, "").replace(",", ".");
  if (/^-?\d+(\.\d+)?$/.test(normalised)) {
    return { numeric: Number(normalised), issue: null };
  }
  return { numeric: null, issue: `"${text}" is not a number` };
}

const NON_ANSWER_MARKERS = new Set([
  "нет ответа",
  "не ответил",
  "не ответила",
  "не применимо",
  "н/д",
  "н.д.",
  "no answer",
  "not answered",
  "n/a",
  "na",
  "-",
  "—",
  ".",
  "пропуск",
  "затрудняюсь ответить",
]);

export interface RowEvaluation {
  row: ImportPlanRow;
  missing: number;
  outOfRange: number;
  invalid: number;
  ignored: number;
}

export function evaluateRow(
  rowNumber: number,
  cells: Array<string | number | boolean | null>,
  columns: ImportColumn[],
  items: ItemSpec[],
  options: ImportOptions,
  pseudoIndex: number,
): RowEvaluation {
  const issues: RuleIssue[] = [];
  const itemByCode = new Map(items.map((item) => [item.itemCode, item]));
  const plannedItems: ImportPlanRow["items"] = [];
  const attributes: Record<string, string | number | boolean | null> = {};
  let participantKey: string | null = null;
  let collectedAt: string | null = null;
  let identity: ImportPlanRow["identity"] = null;
  let missing = 0;
  let outOfRange = 0;
  let invalid = 0;
  let ignored = 0;

  for (const column of columns) {
    const raw = cells[column.index] ?? null;
    if (column.role === "ignore") {
      if (raw !== null && raw !== "") {
        ignored += 1;
      }
      continue;
    }
    if (column.role === "participant_key") {
      participantKey = raw === null || raw === "" ? null : String(raw).trim();
      continue;
    }
    if (column.role === "collected_at") {
      collectedAt = normaliseTimestamp(raw);
      if (raw !== null && raw !== "" && collectedAt === null) {
        issues.push({
          code: "import.unparsable_timestamp",
          severity: "warn",
          message: `Column "${column.header}" row ${rowNumber}: "${String(raw)}" is not a recognisable timestamp; recorded as missing.`,
          detail: { columnIndex: column.index, rowNumber },
        });
      }
      continue;
    }
    if (column.role === "identity_email" || column.role === "identity_name") {
      if (raw === null || raw === "") {
        continue;
      }
      identity = identity ?? {};
      const field = column.identityField ?? (column.role === "identity_email" ? "contact_email" : "full_name");
      const text = String(raw).trim();
      if (field === "contact_email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) {
        issues.push({
          code: "import.invalid_email",
          severity: "warn",
          message: `Row ${rowNumber}: "${text}" is not a valid e-mail address; it was not stored as an identity record.`,
          detail: { rowNumber, columnIndex: column.index },
        });
        continue;
      }
      identity[field] = text;
      continue;
    }
    if (column.role === "participant_attribute") {
      if (column.attribute) {
        attributes[column.attribute] = raw === null || raw === "" ? null : (raw as string | number | boolean);
      }
      continue;
    }

    // Instrument item.
    const itemCode = column.itemCode as string;
    const spec = itemByCode.get(itemCode);
    if (!spec) {
      issues.push({
        code: "import.unknown_item",
        severity: "fail",
        message: `Column "${column.header}" targets item ${itemCode}, which is not part of the selected instrument version.`,
        detail: { rowNumber, columnIndex: column.index, itemCode },
      });
      continue;
    }
    const rawText = raw === null || raw === undefined ? "" : String(raw);
    const trimmed = rawText.trim();
    const issueCodes: string[] = [];

    if (trimmed.length === 0) {
      missing += 1;
      plannedItems.push({
        itemCode,
        rawValueText: "",
        valueNumeric: null,
        valueCoded: null,
        isMissing: true,
        missingReason: "not_answered",
        columnIndex: column.index,
        issueCodes,
      });
      continue;
    }
    if (NON_ANSWER_MARKERS.has(trimmed.toLocaleLowerCase("ru-RU"))) {
      missing += 1;
      issueCodes.push("import.documented_non_answer");
      plannedItems.push({
        itemCode,
        rawValueText: trimmed,
        valueNumeric: null,
        valueCoded: null,
        isMissing: true,
        missingReason: "refused",
        columnIndex: column.index,
        issueCodes,
      });
      continue;
    }

    if (spec.options.length > 0) {
      const optionIndex = spec.options.findIndex(
        (option) => option.trim().toLocaleLowerCase("ru-RU") === trimmed.toLocaleLowerCase("ru-RU"),
      );
      if (optionIndex >= 0) {
        plannedItems.push({
          itemCode,
          rawValueText: trimmed,
          valueNumeric: optionIndex + 1,
          valueCoded: spec.options[optionIndex] as string,
          isMissing: false,
          missingReason: null,
          columnIndex: column.index,
          issueCodes,
        });
        continue;
      }
    }

    const { numeric } = coerceNumeric(raw);
    if (numeric === null) {
      invalid += 1;
      issueCodes.push("import.non_numeric_value");
      issues.push({
        code: "import.non_numeric_value",
        severity: "warn",
        message: `Item ${itemCode} row ${rowNumber}: "${trimmed}" is not numeric and does not match a documented response option; stored as missing.`,
        detail: { rowNumber, columnIndex: column.index, itemCode },
      });
      plannedItems.push({
        itemCode,
        rawValueText: trimmed,
        valueNumeric: null,
        valueCoded: null,
        isMissing: true,
        missingReason: "illegible",
        columnIndex: column.index,
        issueCodes,
      });
      continue;
    }
    if (spec.minValue !== null && numeric < spec.minValue) {
      outOfRange += 1;
      issueCodes.push("import.below_minimum");
    }
    if (spec.maxValue !== null && numeric > spec.maxValue) {
      outOfRange += 1;
      issueCodes.push("import.above_maximum");
    }
    plannedItems.push({
      itemCode,
      rawValueText: trimmed,
      valueNumeric: numeric,
      valueCoded: null,
      isMissing: false,
      missingReason: null,
      columnIndex: column.index,
      issueCodes,
    });
  }

  const usableItems = plannedItems.filter((item) => !item.isMissing).length;
  const skippable = usableItems === 0;
  if (skippable) {
    issues.push({
      code: "import.row_without_answers",
      severity: "warn",
      message: `Row ${rowNumber} contains no recorded answers and was skipped.`,
      detail: { rowNumber },
    });
  }
  if (outOfRange > 0) {
    issues.push({
      code: "import.value_out_of_documented_range",
      severity: "warn",
      message: `Row ${rowNumber}: ${outOfRange} value(s) fall outside the documented response range for this instrument version. They are imported verbatim and flagged.`,
      detail: { rowNumber, outOfRange },
    });
  }

  const pseudonymPrefix = options.pseudonymPrefix ?? "P";
  const planRow: ImportPlanRow = {
    rowNumber,
    participantKey,
    pseudonym: `${pseudonymPrefix}-${String(pseudoIndex).padStart(3, "0")}`,
    collectedAt,
    items: plannedItems,
    attributes,
    identity: options.storeIdentity ? identity : null,
    issues,
    skippable,
  };
  return { row: planRow, missing, outOfRange, invalid, ignored };
}

/** Accepts ISO strings, `YYYY-MM-DD HH:MM:SS`, `DD.MM.YYYY HH:MM` and date-only values. */
export function normaliseTimestamp(raw: string | number | boolean | null): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? new Date(raw).toISOString() : null;
  }
  if (typeof raw === "boolean") {
    return null;
  }
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }
  const isoCandidate = text.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(isoCandidate)) {
    const parsed = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(isoCandidate) ? isoCandidate : `${isoCandidate}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const european = /^(\d{2})[.\/](\d{2})[.\/](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (european) {
    const [, day, month, year, hour = "00", minute = "00", second = "00"] = european;
    const parsed = new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ),
    );
    if (
      parsed.getUTCFullYear() !== Number(year) ||
      parsed.getUTCMonth() !== Number(month) - 1 ||
      parsed.getUTCDate() !== Number(day)
    ) {
      return null;
    }
    return parsed.toISOString();
  }
  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

export function buildImportPlan(input: PlanInput): ImportPlan {
  const table = parseSourceTable(input);
  if (table.headers.length === 0) {
    throw new DomainError("import.empty_source", "The selected source contains no header row.");
  }
  const inferred = inferColumns(table.headers, input.items, input.participantAttributes ?? []);
  const columns = inferred.map((column) => {
    const override = input.columnOverrides?.[column.index];
    return override ? { ...column, ...override } : column;
  });

  const blockers: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const issues: RuleIssue[] = [...table.warnings.map((message) => ({
    code: "import.parser_warning",
    severity: "warn" as const,
    message,
  }))];

  const itemColumns = columns.filter((column) => column.role === "instrument_item");
  const mappedCodes = new Set(itemColumns.map((column) => column.itemCode));
  const missingRequiredItems = input.items.filter((item) => item.required && !mappedCodes.has(item.itemCode));
  if (itemColumns.length === 0) {
    blockers.push({
      code: "import.no_item_columns",
      severity: "fail",
      message: "No column could be matched to an instrument item. Choose the instrument version and map the columns explicitly.",
    });
  }
  if (missingRequiredItems.length > 0) {
    warnings.push({
      code: "import.unmapped_item",
      severity: "warn",
      message: `${missingRequiredItems.length} instrument item(s) have no source column and will be recorded as missing: ${missingRequiredItems
        .map((item) => item.itemCode)
        .join(", ")}.`,
      detail: { itemCodes: missingRequiredItems.map((item) => item.itemCode) },
    });
  }
  const duplicateColumns = itemColumns.filter(
    (column, index) => itemColumns.findIndex((other) => other.itemCode === column.itemCode) !== index,
  );
  if (duplicateColumns.length > 0) {
    blockers.push({
      code: "import.duplicate_item_column",
      severity: "fail",
      message: `More than one column maps to item(s) ${[...new Set(duplicateColumns.map((column) => column.itemCode))].join(", ")}. Correct the mapping before importing.`,
    });
  }
  const collectedAtColumns = columns.filter((column) => column.role === "collected_at");
  if (collectedAtColumns.length === 0) {
    warnings.push({
      code: "import.no_timestamp_column",
      severity: "warn",
      message:
        "No collection timestamp column was mapped. Answer timestamps will be recorded as missing; the documented source still records when the file was received.",
    });
  }
  if (!input.options.consent.declared) {
    blockers.push({
      code: "import.consent_not_declared",
      severity: "fail",
      message:
        "The operator must confirm that participant consent for storing these responses is documented. No data is written without that declaration.",
    });
  }
  if (input.options.consent.evidenceNote.trim().length < 8) {
    blockers.push({
      code: "import.consent_evidence_missing",
      severity: "fail",
      message: "Describe the consent evidence (form, date, archive reference) in at least a few words.",
    });
  }
  if (!input.options.timepointLabel.trim()) {
    blockers.push({
      code: "import.missing_timepoint",
      severity: "fail",
      message: "A timepoint label is required so repeated measurements stay distinguishable.",
    });
  }

  const rows: ImportPlanRow[] = [];
  let missingCells = 0;
  let outOfRangeCells = 0;
  let invalidDateCells = 0;
  let unmappedCells = 0;
  const perItemMissing = new Map<string, { missing: number; present: number }>();
  for (const column of itemColumns) {
    if (column.itemCode && !perItemMissing.has(column.itemCode)) {
      perItemMissing.set(column.itemCode, { missing: 0, present: 0 });
    }
  }

  const seenKeys = new Map<string, number>();
  let duplicates = 0;
  for (let index = 0; index < table.rows.length; index += 1) {
    const cells = table.rows[index] ?? [];
    const rowNumber = table.rowNumbers[index] ?? index + 2;
    const evaluation = evaluateRow(rowNumber, cells, columns, input.items, input.options, index + 1);
    rows.push(evaluation.row);
    missingCells += evaluation.missing;
    outOfRangeCells += evaluation.outOfRange;
    unmappedCells += evaluation.ignored;
    invalidDateCells += evaluation.row.issues.filter((issue) => issue.code === "import.unparsable_timestamp").length;
    for (const item of evaluation.row.items) {
      const entry = perItemMissing.get(item.itemCode);
      if (!entry) {
        continue;
      }
      if (item.isMissing) {
        entry.missing += 1;
      } else {
        entry.present += 1;
      }
    }
    if (evaluation.row.participantKey) {
      const key = evaluation.row.participantKey.toLocaleLowerCase("ru-RU");
      const previous = seenKeys.get(key);
      if (previous !== undefined) {
        duplicates += 1;
        rows[index] = {
          ...evaluation.row,
          issues: [
            ...evaluation.row.issues,
            {
              code: "import.duplicate_participant_key",
              severity: "warn",
              message: `Participant key "${evaluation.row.participantKey}" also appears in row ${previous}; this row would be recorded as a second assessment event.`,
              detail: { rowNumber, firstRow: previous },
            },
          ],
        };
      } else {
        seenKeys.set(key, rowNumber);
      }
    }
    if (evaluation.row.skippable) {
      continue;
    }
  }

  const usableRows = rows.filter((row) => !row.skippable).length;
  const totalCells = table.rows.length * columns.length;
  issues.push(...warnings);

  return {
    descriptor: input.descriptor,
    options: input.options,
    columns,
    rows,
    summary: {
      totalRows: table.rows.length,
      usableRows,
      skippedRows: table.rows.length - usableRows,
      duplicateParticipantKeys: duplicates,
      totalCells,
      missingCells,
      outOfRangeCells,
      invalidDateCells,
      unmappedCells,
      identityCells: rows.reduce((total, row) => total + (row.identity ? Object.keys(row.identity).length : 0), 0),
      perItemMissing: [...perItemMissing.entries()]
        .map(([itemCode, counts]) => ({ itemCode, ...counts }))
        .sort((a, b) => a.itemCode.localeCompare(b.itemCode)),
    },
    issues,
    blockers,
    warnings,
  };
}

export function requireCommittingPlan(plan: ImportPlan): void {
  if (plan.blockers.length > 0) {
    throw new DomainError("import.blocked", "The import plan has blocking issues and cannot be committed.", {
      blockers: plan.blockers.map((blocker) => blocker.code),
    });
  }
  if (plan.summary.usableRows === 0) {
    throw new DomainError("import.no_usable_rows", "No usable rows were found in the source document.");
  }
}
