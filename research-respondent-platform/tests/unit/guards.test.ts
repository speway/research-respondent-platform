/**
 * Guard tests.
 *
 * Guards sit on the boundary between messy real-world exports and the research
 * database, so the cases below are the ones that actually occur in Google Forms
 * exports and Russian-language spreadsheets: blank cells, padded text, day-first
 * dates, decimal commas and yes/no columns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  booleanValue,
  finiteNumber,
  integer,
  isRecord,
  isoDate,
  isoDateTime,
  nonEmptyString,
  optionalString,
  stringEnum,
} from "../../lib/domain/guards.ts";
import { DomainError } from "../../lib/domain/types.ts";

function isGuardError(error: unknown, field: string): boolean {
  return error instanceof DomainError && error.code === "guard.invalid" && error.detail.field === field;
}

// -------------------------------------------------------------------- dates --

test("isoDate accepts ISO, Google-Forms and European formats", () => {
  assert.equal(isoDate("2025-10-30"), "2025-10-30");
  assert.equal(isoDate(" 2025-10-30 "), "2025-10-30");
  assert.equal(isoDate("2025-2-3"), "2025-02-03");
  assert.equal(isoDate("2025-10-30T20:15:19.457Z"), "2025-10-30");
  assert.equal(isoDate("2025-10-30 20:15:19.457"), "2025-10-30");
  assert.equal(isoDate("2025/10/30"), "2025-10-30");
  assert.equal(isoDate("30.10.2025"), "2025-10-30");
  assert.equal(isoDate("30/10/2025 20:15"), "2025-10-30");
  assert.equal(isoDate(new Date("2025-10-30T23:30:00.000Z")), "2025-10-30");
});

test("isoDate rejects impossible and unusable values instead of guessing", () => {
  for (const input of ["2025-13-45", "2025-02-30", "2025-04-31", "2025-00-10", "30.02.2025", "2025-10-32", "", "   ", "not a date", "2025-10-30Z", "30/10/25"]) {
    assert.equal(isoDate(input), null, `expected ${JSON.stringify(input)} to be rejected`);
  }
  assert.equal(isoDate(null), null);
  assert.equal(isoDate(undefined), null);
  assert.equal(isoDate(1746288000000), null, "numbers are never read as dates");
  assert.equal(isoDate({}), null);
  assert.equal(isoDate(new Date("invalid")), null);
});

test("isoDateTime produces one canonical UTC instant, independent of the server time zone", () => {
  assert.equal(isoDateTime("2025-10-30 20:15:19.457"), "2025-10-30T20:15:19.457Z");
  assert.equal(isoDateTime("2025-10-30T20:15:19.457Z"), "2025-10-30T20:15:19.457Z");
  assert.equal(isoDateTime("2025-10-30T20:15:19.457+05:00"), "2025-10-30T15:15:19.457Z");
  assert.equal(isoDateTime("2025-10-30T20:15:19.4+05:00"), "2025-10-30T15:15:19.400Z");
  assert.equal(isoDateTime("30.10.2025 20:15"), "2025-10-30T20:15:00.000Z");
  assert.equal(isoDateTime("2025-10-30"), "2025-10-30T00:00:00.000Z");
  assert.equal(isoDateTime("2025-10-30T20:15:19.457123Z"), "2025-10-30T20:15:19.457Z");
  assert.equal(isoDateTime(new Date("2025-10-30T20:15:19.457Z")), "2025-10-30T20:15:19.457Z");
});

test("isoDateTime returns null for values it cannot justify", () => {
  for (const input of ["2025-13-45 20:15", "2025-02-30", "31.04.2025", "2025-10-30 25:00", "2025-10-30 20:61", "", "tomorrow"]) {
    assert.equal(isoDateTime(input), null, `expected ${JSON.stringify(input)} to be rejected`);
  }
  assert.equal(isoDateTime(1746288000000), null);
  assert.equal(isoDateTime(true), null);
  assert.equal(isoDateTime(null), null);
});

// --------------------------------------------------------------------- text --

test("nonEmptyString trims padding and refuses empty input", () => {
  assert.equal(nonEmptyString("  P-001  "), "P-001");
  assert.equal(nonEmptyString("\uFEFFP-001"), "P-001");
  assert.equal(nonEmptyString("a\u00A0b"), "a b");
  assert.equal(nonEmptyString(42), "42");
  assert.equal(nonEmptyString(false), "false");

  assert.throws(() => nonEmptyString("", "pseudonym"), (error: unknown) => isGuardError(error, "pseudonym"));
  assert.throws(() => nonEmptyString("   ", "pseudonym"), (error: unknown) => isGuardError(error, "pseudonym"));
  assert.throws(() => nonEmptyString(null, "pseudonym"), (error: unknown) => isGuardError(error, "pseudonym"));
  assert.throws(() => nonEmptyString({}, "pseudonym"), (error: unknown) => isGuardError(error, "pseudonym"));
  assert.throws(() => nonEmptyString(Number.NaN, "pseudonym"), (error: unknown) => isGuardError(error, "pseudonym"));
});

test("optionalString maps blanks to null and never invents a value", () => {
  assert.equal(optionalString(undefined), null);
  assert.equal(optionalString(null), null);
  assert.equal(optionalString(""), null);
  assert.equal(optionalString("   "), null);
  assert.equal(optionalString("  text  "), "text");
  assert.equal(optionalString(0), "0");
  assert.equal(optionalString(false), "false");
  assert.throws(() => optionalString([], "note"), (error: unknown) => isGuardError(error, "note"));
});

test("isRecord distinguishes plain objects from arrays, dates and null", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(new Date()), false);
  assert.equal(isRecord("text"), false);
});

// ------------------------------------------------------------------- number --

test("finiteNumber reads Russian decimal commas and export-style thousands separators", () => {
  assert.equal(finiteNumber(4.5), 4.5);
  assert.equal(finiteNumber("4,5"), 4.5);
  assert.equal(finiteNumber(" 42 "), 42);
  assert.equal(finiteNumber("-3.5"), -3.5);
  assert.equal(finiteNumber("+7"), 7);
  assert.equal(finiteNumber("1 234,5"), 1234.5);
  assert.equal(finiteNumber("1\u00A0234,5"), 1234.5);
  assert.equal(finiteNumber("1,234.5"), 1234.5);
  assert.equal(finiteNumber("1.234,56"), 1234.56);
  assert.equal(finiteNumber("1'000,25"), 1000.25);
  assert.equal(finiteNumber("0"), 0);
});

test("finiteNumber rejects blanks, text, non-finite numbers and booleans", () => {
  for (const input of ["", "   ", "abc", "4,5,6", Number.NaN, Number.POSITIVE_INFINITY, true, false, null, undefined, {}, []]) {
    assert.throws(
      () => finiteNumber(input, "score"),
      (error: unknown) => isGuardError(error, "score"),
      `expected ${JSON.stringify(input)} to be rejected`,
    );
  }
});

test("integer accepts whole numbers and their numeric text, nothing else", () => {
  assert.equal(integer(42), 42);
  assert.equal(integer(-7), -7);
  assert.equal(integer("42"), 42);
  assert.equal(integer("42.0"), 42);
  assert.equal(integer("7,0"), 7);
  assert.throws(() => integer(4.5, "items"), (error: unknown) => isGuardError(error, "items"));
  assert.throws(() => integer("4,5", "items"), (error: unknown) => isGuardError(error, "items"));
  assert.throws(() => integer(true, "items"), (error: unknown) => isGuardError(error, "items"));
});

// ------------------------------------------------------------------ boolean --

test("booleanValue maps the yes/no spellings found in forms and rejects ambiguity", () => {
  for (const input of [true, "true", "TRUE", " yes ", "y", "1", 1, "да"]) {
    assert.equal(booleanValue(input), true, `expected ${JSON.stringify(input)} to be true`);
  }
  for (const input of [false, "false", "No", "n", "0", 0, "нет"]) {
    assert.equal(booleanValue(input), false, `expected ${JSON.stringify(input)} to be false`);
  }
  for (const input of ["maybe", "2", -1, "", Number.NaN, null, {}, []]) {
    assert.throws(
      () => booleanValue(input, "consent_flag"),
      (error: unknown) => isGuardError(error, "consent_flag"),
      `expected ${JSON.stringify(input)} to be rejected`,
    );
  }
});

// --------------------------------------------------------------------- enum --

test("stringEnum normalises case, padding and hyphens to the canonical value", () => {
  const parseConsent = stringEnum(["granted", "declined", "withdrawn", "expired", "none"] as const);
  assert.equal(parseConsent(" Granted "), "granted");
  assert.equal(parseConsent("WITHDRAWN"), "withdrawn");
  const parseOperator = stringEnum(["not_in", "is_missing"] as const);
  assert.equal(parseOperator("Not In"), "not_in");
  assert.equal(parseOperator("is-missing"), "is_missing");

  assert.throws(() => parseConsent("pending", "status"), (error: unknown) => isGuardError(error, "status"));
  assert.throws(() => parseConsent(3, "status"), (error: unknown) => isGuardError(error, "status"));
  assert.throws(
    () => parseConsent("pending", "status"),
    (error: unknown) =>
      error instanceof DomainError && Array.isArray(error.detail.allowed) && error.detail.allowed.includes("granted"),
  );
});
