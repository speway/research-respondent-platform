/**
 * Identifier, hashing and JSON helpers shared by every layer.
 * Pure utilities: no database, no framework imports.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Time-ordered, human-scannable identifier: 10 chars of time + 12 chars random. */
export function newId(prefix: string): string {
  const now = BigInt(Date.now());
  let time = "";
  let value = now;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD[Number(value & 31n)] + time;
    value >>= 5n;
  }
  const bytes = randomBytes(12);
  let random = "";
  for (let index = 0; index < 12; index += 1) {
    random += CROCKFORD[(bytes[index] ?? 0) & 31];
  }
  return `${prefix}_${time}${random}`.toLowerCase();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively so hashes are stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, "en"));
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    result[key] = sortValue(item);
  }
  return result;
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Order-preserving value normaliser used when comparing documented answers with
 * external form options. Only trims and collapses whitespace; it never rewrites
 * stored wording.
 */
export function normaliseComparable(input: string): string {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

export function truncate(input: string, max = 160): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) {
      return "";
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}
