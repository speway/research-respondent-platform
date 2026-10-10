/**
 * Dependency-free runtime guards for untrusted input: HTTP bodies, form data and
 * spreadsheet/export cells.
 *
 * Conventions:
 * - Guards are pure and deterministic. They never read the clock or the locale.
 * - "Strict" guards (nonEmptyString, finiteNumber, integer, booleanValue,
 *   stringEnum) throw `DomainError` with code `guard.invalid` and a
 *   `detail.field` pointer identifying the offending input.
 * - Date guards never throw: unparseable input yields `null`, which callers must
 *   treat as missing data rather than as a default value.
 * - A value that cannot be interpreted is rejected, never silently coerced into
 *   a plausible-looking number or date.
 */
import { DomainError } from "./types.ts";

export const GUARD_INVALID = "guard.invalid";

/** Plain-object test: arrays, null and dates are not records. */
export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) && !(input instanceof Date);
}

function describeInput(input: unknown): string {
  if (input === null) return "null";
  if (input === undefined) return "undefined";
  if (typeof input === "string") {
    return JSON.stringify(input.length > 120 ? `${input.slice(0, 117)}...` : input);
  }
  if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
    return String(input);
  }
  if (Array.isArray(input)) return `array(${input.length})`;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? "invalid Date" : `Date(${input.toISOString()})`;
  return typeof input === "object" ? "object" : typeof input;
}

function reject(field: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new DomainError(GUARD_INVALID, message, { field, ...detail });
}

/** Trim, drop a leading BOM and turn non-breaking spaces into plain spaces. */
function clean(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[\u00A0\u2007\u2009\u202F]/g, " ")
    .trim();
}

// ------------------------------------------------------------------- text ----

/**
 * Text guard. `undefined`, `null` and blank strings become `null`; numbers and
 * booleans are rendered losslessly; anything else is rejected.
 */
export function optionalString(input: unknown, field = "value"): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") {
    const text = clean(input);
    return text === "" ? null : text;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      reject(field, `Expected text but received the non-finite number ${String(input)}.`, { received: String(input) });
    }
    return String(input);
  }
  if (typeof input === "boolean") return input ? "true" : "false";
  reject(field, `Expected text but received ${describeInput(input)}.`, { received: describeInput(input) });
}

/** Text guard that rejects missing values instead of returning `null`. */
export function nonEmptyString(input: unknown, field = "value"): string {
  const text = optionalString(input, field);
  if (text === null) {
    reject(field, `A non-empty string is required but ${describeInput(input)} was received.`, {
      received: describeInput(input),
    });
  }
  return text;
}

// ----------------------------------------------------------------- number ----

/**
 * Number guard. Accepts finite numbers and numeric text, including the Russian
 * decimal comma ("4,5") and space/apostrophe thousands separators ("1 234,5").
 *
 * Separator rule: when both "," and "." occur, the right-most one is the decimal
 * separator. A single "," is read as a decimal separator, so "1,234" is 1.234 —
 * survey values are small and the decimal comma is the convention this platform
 * ingests. Repeated separators are accepted only as digit grouping
 * ("1,234,567" / "1.234.567"); anything else ("4,5,6") is rejected rather than
 * silently reinterpreted.
 *
 * Booleans are rejected rather than coerced to 0/1, so `true` can never enter a
 * numeric field unnoticed.
 */
export function finiteNumber(input: unknown, field = "value"): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      reject(field, `Expected a finite number but received ${String(input)}.`, { received: String(input) });
    }
    return input;
  }
  if (typeof input === "string") {
    const text = clean(input);
    if (text === "") reject(field, "Expected a number but the value is empty.", { received: "" });
    const normalized = normalizeNumericText(text);
    const parsed = normalized === null ? Number.NaN : Number(normalized);
    if (!Number.isFinite(parsed)) {
      reject(field, `Expected a number but received ${JSON.stringify(text)}.`, { received: text });
    }
    return parsed;
  }
  if (typeof input === "boolean") {
    reject(field, `Booleans are not converted to numbers; received ${String(input)}.`, { received: input });
  }
  reject(field, `Expected a number but received ${describeInput(input)}.`, { received: describeInput(input) });
}

const GROUPED_DIGITS = /^[+-]?\d{1,3}(?:[,.]\d{3})+$/;

function normalizeNumericText(input: string): string | null {
  const text = input.replace(/[\s']/g, "");
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    return lastComma > lastDot ? text.replace(/\./g, "").replace(/,/g, ".") : text.replace(/,/g, "");
  }
  if (lastComma >= 0) {
    if (text.split(",").length === 2) return text.replace(",", ".");
    return GROUPED_DIGITS.test(text) ? text.replace(/,/g, "") : null;
  }
  if (lastDot >= 0) {
    if (text.split(".").length === 2) return text;
    return GROUPED_DIGITS.test(text) ? text.replace(/\./g, "") : null;
  }
  return text;
}

/** Whole-number guard; "42" and "42.0" are accepted, 4.5 is not. */
export function integer(input: unknown, field = "value"): number {
  const value = finiteNumber(input, field);
  if (!Number.isInteger(value)) {
    reject(field, `Expected a whole number but received ${String(value)}.`, { received: value });
  }
  return value;
}

// ---------------------------------------------------------------- boolean ----

const TRUE_TOKENS = ["true", "1", "yes", "y", "да", "истина"];
const FALSE_TOKENS = ["false", "0", "no", "n", "нет", "ложь"];

/** Yes/no guard for checkbox and radio values; never guesses on ambiguous text. */
export function booleanValue(input: unknown, field = "value"): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (input === 1) return true;
    if (input === 0) return false;
    reject(field, `Expected a yes/no value but received the number ${String(input)}.`, { received: input });
  }
  if (typeof input === "string") {
    const token = clean(input).toLowerCase();
    if (TRUE_TOKENS.includes(token)) return true;
    if (FALSE_TOKENS.includes(token)) return false;
    reject(field, `Expected a yes/no value but received ${JSON.stringify(input)}.`, {
      received: input,
      acceptedTrue: TRUE_TOKENS,
      acceptedFalse: FALSE_TOKENS,
    });
  }
  reject(field, `Expected a yes/no value but received ${describeInput(input)}.`, { received: describeInput(input) });
}

// ------------------------------------------------------------------- enum ----

function enumKey(value: string): string {
  return clean(value).toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Builds a case/whitespace-insensitive guard for a closed set of string values.
 * The canonical member of `values` is returned, so downstream code compares
 * against one exact spelling.
 */
export function stringEnum<T extends string>(values: readonly T[]): (input: unknown, field?: string) => T {
  const canonical = new Map<string, T>();
  for (const value of values) canonical.set(enumKey(value), value);
  const allowed = values.join(", ");
  return (input: unknown, field = "value"): T => {
    if (typeof input !== "string") {
      reject(field, `Expected one of: ${allowed}. Received ${describeInput(input)}.`, {
        received: describeInput(input),
        allowed: values,
      });
    }
    const match = canonical.get(enumKey(input));
    if (match === undefined) {
      reject(field, `Expected one of: ${allowed}. Received ${JSON.stringify(input)}.`, {
        received: input,
        allowed: values,
      });
    }
    return match;
  };
}

// ------------------------------------------------------------------ dates ----

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  /** Minutes east of UTC, or null when the input carried no zone. */
  offsetMinutes: number | null;
}

const YEAR_FIRST =
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;
const DAY_FIRST =
  /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] ?? 0);
}

function readDateParts(input: unknown): DateParts | null {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return {
      year: input.getUTCFullYear(),
      month: input.getUTCMonth() + 1,
      day: input.getUTCDate(),
      hour: input.getUTCHours(),
      minute: input.getUTCMinutes(),
      second: input.getUTCSeconds(),
      ms: input.getUTCMilliseconds(),
      offsetMinutes: 0,
    };
  }
  if (typeof input !== "string") return null;
  const text = clean(input);
  if (text === "") return null;

  const yearFirst = YEAR_FIRST.exec(text);
  const dayFirst = yearFirst ? null : DAY_FIRST.exec(text);
  const match = yearFirst ?? dayFirst;
  if (!match) return null;

  const year = Number(yearFirst ? match[1] : match[3]);
  const month = Number(match[2]);
  const day = Number(yearFirst ? match[3] : match[1]);
  if (!isRealDate(year, month, day)) return null;

  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;

  const fraction = match[7] ?? "";
  const ms = fraction === "" ? 0 : Number(`${fraction}000`.slice(0, 3));
  const zone = match[8];
  let offsetMinutes: number | null = null;
  if (zone !== undefined) {
    if (zone === "Z" || zone === "z") offsetMinutes = 0;
    else {
      const sign = zone.startsWith("-") ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      const zoneHours = Number(digits.slice(0, 2));
      const zoneMinutes = Number(digits.slice(2, 4));
      if (!Number.isFinite(zoneHours) || !Number.isFinite(zoneMinutes) || zoneHours > 23 || zoneMinutes > 59) return null;
      offsetMinutes = sign * (zoneHours * 60 + zoneMinutes);
    }
  }
  return { year, month, day, hour, minute, second, ms, offsetMinutes };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * `YYYY-MM-DD` or `null`.
 *
 * Accepts ISO text ("2025-10-30", "2025-10-30T20:15:19.457Z"), Google-Forms style
 * timestamps ("2025-10-30 20:15:19.457"), year-first slashed dates
 * ("2025/10/30") and day-first European dates ("30.10.2025", "30/10/2025 20:15").
 * Impossible calendar dates such as "2025-13-45" or "2025-02-30" return `null`.
 */
export function isoDate(input: unknown): string | null {
  const parts = readDateParts(input);
  if (parts === null) return null;
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

/**
 * Canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ` or `null`.
 *
 * Timestamps without a zone designator are read as UTC; that keeps results
 * identical on every machine instead of depending on the server's time zone.
 * Numbers are rejected: an epoch or spreadsheet serial would otherwise be read
 * as a plausible-but-wrong date.
 */
export function isoDateTime(input: unknown): string | null {
  const parts = readDateParts(input);
  if (parts === null) return null;
  const date = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
  const time = `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}.${pad(parts.ms, 3)}`;
  const zone =
    parts.offsetMinutes === null
      ? "Z"
      : parts.offsetMinutes === 0
        ? "Z"
        : `${parts.offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(parts.offsetMinutes) / 60), 2)}:${pad(Math.abs(parts.offsetMinutes) % 60, 2)}`;
  const epoch = Date.parse(`${date}T${time}${zone}`);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
}
