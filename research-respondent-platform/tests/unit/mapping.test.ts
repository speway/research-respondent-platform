/**
 * Mapping validation and preflight tests.
 *
 * The suite documents the research-integrity contract: documented missing
 * answers never become payload values, only pass/warn entries with a resolved
 * documented value reach the dry-run payload, and the platform never claims a
 * submission path it does not have.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPreflight,
  detectVersionDrift,
  normaliseTitle,
  suggestMappings,
  validateMapping,
  MISSING_SOURCE_MESSAGE,
  PLATFORM_SUBMISSION_PATH_VERIFIED,
  SUGGESTION_ACCEPTANCE_NOTE,
} from "../../lib/domain/mapping.ts";
import type { MappingSuggestion, PreflightInput } from "../../lib/domain/mapping.ts";
import { DomainError } from "../../lib/domain/types.ts";
import type {
  ExternalFormFieldInput,
  FieldMappingValidation,
  MappingCandidate,
  MappingSourceContext,
  PreflightReport,
  RuleIssue,
} from "../../lib/domain/types.ts";

type DocumentedAnswer = MappingSourceContext["answers"][number];
type DocumentedScore = MappingSourceContext["scores"][number];

function field(overrides: Partial<ExternalFormFieldInput> & { fieldId: string }): ExternalFormFieldInput {
  const { fieldId, ...rest } = overrides;
  return {
    fieldId,
    orderIndex: 0,
    title: fieldId,
    fieldType: "short_text",
    isRequired: false,
    options: [],
    section: null,
    ...rest,
  };
}

function mapping(fieldId: string, overrides: Partial<MappingCandidate> = {}): MappingCandidate {
  const { sourceRef, ...rest } = overrides;
  return {
    mappingId: `map_${fieldId}`,
    mappingKind: "observed_answer",
    valueTransform: "verbatim",
    sourceRef: { fieldId, ...sourceRef },
    status: "validated",
    rationale: null,
    ...rest,
  };
}

function answer(itemCode: string, overrides: Partial<DocumentedAnswer> = {}): DocumentedAnswer {
  return {
    itemDefinitionId: `item_${itemCode}`,
    itemCode,
    questionText: `Question ${itemCode}`,
    responseType: "short_text",
    options: [],
    minValue: null,
    maxValue: null,
    valueNumeric: null,
    valueCoded: null,
    rawValueText: "",
    isMissing: false,
    missingReason: null,
    collectedAt: "2026-01-05T09:00:00.000Z",
    sessionId: "sess_1",
    documentedSourceId: "ds_1",
    sourceLocator: `sheet1!${itemCode}`,
    ...overrides,
  };
}

function score(scaleCode: string, overrides: Partial<DocumentedScore> = {}): DocumentedScore {
  return {
    scaleCode,
    scaleTitle: `Scale ${scaleCode}`,
    rawScore: 12,
    transformedScore: 50,
    computability: "computed",
    algorithmVersion: "1.0.0",
    sessionId: "sess_1",
    ...overrides,
  };
}

function context(overrides: Partial<MappingSourceContext> = {}): MappingSourceContext {
  return { participantId: "pat_1", pseudonym: "P001", answers: [], scores: [], attributes: {}, ...overrides };
}

const CONSENT_GRANTED = { status: "granted", version: "v2", withdrawnAt: null };

function preflight(overrides: Partial<PreflightInput> = {}): PreflightReport {
  return buildPreflight({
    studyId: "std_1",
    participantId: "pat_1",
    externalFormVersionId: "efv_1",
    fields: [],
    mappings: [],
    context: context(),
    consent: CONSENT_GRANTED,
    platformSubmissionAuthorized: false,
    generatedAt: "2026-02-01T10:00:00.000Z",
    ...overrides,
  });
}

function entry(report: PreflightReport, fieldId: string): FieldMappingValidation {
  const found = report.fields.find((validation) => validation.fieldId === fieldId);
  assert.ok(found, `expected a validation entry for field ${fieldId}`);
  return found;
}

function failIssue(validation: FieldMappingValidation): RuleIssue | undefined {
  return validation.issues.find((item) => item.severity === "fail");
}

function codes(validation: FieldMappingValidation): string[] {
  return validation.issues.map((item) => item.code);
}

// ------------------------------------------------------------------ title text --

test("normaliseTitle casefolds, trims, strips leading numbering and punctuation", () => {
  assert.equal(normaliseTitle("  01 How old are you?  "), "how old are you");
  assert.equal(normaliseTitle("Q3)   Sleeping  problems"), "sleeping problems");
  assert.equal(normaliseTitle("№ 4. Оценка боли (за неделю)"), "оценка боли за неделю");
  assert.equal(normaliseTitle("Section 1"), "section 1");
  assert.equal(normaliseTitle("Age at enrolment?"), normaliseTitle("age  AT   enrolment"));
});

// ------------------------------------------------------------------- unmapped --

test("a required field with no mapping fails and never enters the payload", () => {
  const report = preflight({ fields: [field({ fieldId: "f_age", title: "Age", isRequired: true })] });
  const validation = entry(report, "f_age");
  assert.equal(validation.outcome, "fail");
  assert.ok(codes(validation).includes("required_field_unmapped"));
  assert.equal(validation.mappingId, "implicit:f_age");
  assert.equal(validation.resolvedValue, null);
  assert.equal(validation.valueKind, "none");
  assert.equal(report.payload.f_age, undefined);
  assert.equal(report.counts.unmappedRequired, 1);
  assert.equal(report.counts.fail, 1);
  assert.equal(report.outcome, "fail");
});

test("an optional unmapped field warns instead of failing and its key is omitted", () => {
  const report = preflight({ fields: [field({ fieldId: "f_note", title: "Note" })] });
  const validation = entry(report, "f_note");
  assert.equal(validation.outcome, "warn");
  assert.ok(codes(validation).includes("optional_field_unmapped"));
  assert.equal(validation.issues.some((item) => item.severity === "fail"), false);
  assert.equal(report.payload.f_note, undefined);
  assert.equal(report.counts.unmappedRequired, 0);
  assert.equal(report.counts.warn, 1);
  assert.equal(report.counts.fail, 0);
  assert.equal(report.outcome, "warn");
});

test("an unmapped section header never blocks", () => {
  const report = preflight({
    fields: [field({ fieldId: "f_head", title: "Part 1", fieldType: "section_header", isRequired: true })],
  });
  const validation = entry(report, "f_head");
  assert.equal(validation.outcome, "pass");
  assert.ok(codes(validation).includes("section_header_not_mapped"));
  assert.equal(report.counts.fail, 0);
  assert.equal(report.counts.unmappedRequired, 0);
  assert.equal(report.blockingReasons.some((reason) => reason.includes("f_head")), false);
});

test("field types that cannot hold one documented value are refused", () => {
  const grid = validateMapping(
    field({ fieldId: "f_grid", title: "Matrix", fieldType: "grid", isRequired: true }),
    mapping("f_grid", { sourceRef: { fieldId: "f_grid", itemCode: "Q1" } }),
    context({ answers: [answer("Q1", { rawValueText: "documented" })] }),
  );
  assert.equal(grid.outcome, "fail");
  assert.equal(failIssue(grid)?.code, "field_type_not_mappable");
  assert.equal(grid.resolvedValue, null);
});

// -------------------------------------------------------- documented values --

test("a documented value outside the field's linear scale range fails instead of being clamped", () => {
  const target = field({
    fieldId: "f_pain",
    title: "Pain",
    fieldType: "linear_scale",
    options: ["1", "2", "3", "4", "5"],
    isRequired: true,
  });
  const link = mapping("f_pain", { sourceRef: { fieldId: "f_pain", itemCode: "Q7" } });
  const outOfRange = validateMapping(
    target,
    link,
    context({ answers: [answer("Q7", { responseType: "likert", rawValueText: "9", valueNumeric: 9, minValue: 1, maxValue: 5 })] }),
  );
  assert.equal(outOfRange.outcome, "fail");
  const failure = failIssue(outOfRange);
  assert.equal(failure?.code, "value_out_of_scale_range");
  assert.match(failure?.message ?? "", /1–5/);
  assert.deepEqual(failure?.detail?.allowedRange, [1, 5]);
  assert.equal(outOfRange.resolvedValue, null);

  const report = preflight({
    fields: [target],
    mappings: [link],
    context: context({ answers: [answer("Q7", { responseType: "likert", rawValueText: "9", valueNumeric: 9 })] }),
  });
  assert.equal(report.payload.f_pain, undefined);
  assert.deepEqual(Object.keys(report.payload), []);

  const inRange = validateMapping(
    target,
    link,
    context({ answers: [answer("Q7", { responseType: "likert", rawValueText: "4", valueNumeric: 4 })] }),
  );
  assert.equal(inRange.outcome, "pass");
  assert.equal(inRange.resolvedValue, "4");
  assert.equal(inRange.valueKind, "numeric");
});

test("a choice value outside the field's options fails and shows the allowed options", () => {
  const target = field({
    fieldId: "f_sex",
    title: "Sex",
    fieldType: "multiple_choice",
    options: ["Male", "Female", "Other"],
    isRequired: true,
  });
  const link = mapping("f_sex", { sourceRef: { fieldId: "f_sex", itemCode: "Q2" } });
  const mismatch = validateMapping(
    target,
    link,
    context({ answers: [answer("Q2", { responseType: "multiple_choice", valueCoded: "F", rawValueText: "F" })] }),
  );
  assert.equal(mismatch.outcome, "fail");
  const failure = failIssue(mismatch);
  assert.equal(failure?.code, "value_not_an_option");
  assert.match(failure?.message ?? "", /\["Male","Female","Other"\]/);
  assert.deepEqual(failure?.detail?.allowedOptions, ["Male", "Female", "Other"]);
  assert.equal(mismatch.resolvedValue, null);

  const accepted = validateMapping(
    target,
    link,
    context({ answers: [answer("Q2", { responseType: "multiple_choice", valueCoded: "female", rawValueText: "female" })] }),
  );
  assert.equal(accepted.outcome, "pass");
  assert.equal(accepted.resolvedValue, "Female");
  assert.equal(accepted.valueKind, "option");
});

test("a single-choice field refuses a multi-value documented answer", () => {
  const validation = validateMapping(
    field({ fieldId: "f_sex", title: "Sex", fieldType: "dropdown", options: ["Male", "Female"] }),
    mapping("f_sex", { sourceRef: { fieldId: "f_sex", itemCode: "Q2" } }),
    context({ answers: [answer("Q2", { responseType: "multiple_choice", rawValueText: "Male, Female" })] }),
  );
  assert.equal(validation.outcome, "fail");
  assert.equal(failIssue(validation)?.code, "value_not_an_option");
});

test("checkbox multi-select values are serialised in documented order", () => {
  const target = field({
    fieldId: "f_act",
    title: "Activities",
    fieldType: "checkbox",
    options: ["Reading", "Sport", "Music"],
  });
  const link = mapping("f_act", { sourceRef: { fieldId: "f_act", itemCode: "Q9" } });
  const report = preflight({
    fields: [target],
    mappings: [link],
    context: context({
      answers: [answer("Q9", { responseType: "checkbox", valueCoded: "Sport; Reading", rawValueText: "Sport; Reading" })],
    }),
  });
  const validation = entry(report, "f_act");
  assert.equal(validation.outcome, "pass");
  assert.equal(validation.valueKind, "option");
  assert.equal(validation.resolvedValue, '["Sport","Reading"]');
  assert.equal(validation.resolvedDisplay, "Sport; Reading");
  assert.equal(report.payload.f_act, '["Sport","Reading"]');

  const commaSeparated = validateMapping(
    target,
    link,
    context({ answers: [answer("Q9", { responseType: "checkbox", rawValueText: "Reading, Music" })] }),
  );
  assert.equal(commaSeparated.outcome, "pass");
  assert.deepEqual(JSON.parse(commaSeparated.resolvedValue ?? "null"), ["Reading", "Music"]);

  const partlyUnknown = validateMapping(
    target,
    link,
    context({ answers: [answer("Q9", { responseType: "checkbox", rawValueText: "Reading, Skiing" })] }),
  );
  assert.equal(partlyUnknown.outcome, "fail");
  assert.equal(failIssue(partlyUnknown)?.code, "value_not_an_option");
});

test("a date field fed by a non-date documented source fails", () => {
  const target = field({ fieldId: "f_dob", title: "Date recorded", fieldType: "date", isRequired: true });
  const link = mapping("f_dob", { sourceRef: { fieldId: "f_dob", itemCode: "Q1" } });
  const mismatch = validateMapping(
    target,
    link,
    context({ answers: [answer("Q1", { responseType: "open_text", rawValueText: "2026-03-04" })] }),
  );
  assert.equal(mismatch.outcome, "fail");
  assert.equal(failIssue(mismatch)?.code, "field_type_source_type_mismatch");
  assert.equal(mismatch.resolvedValue, null);

  const accepted = validateMapping(
    target,
    link,
    context({ answers: [answer("Q1", { responseType: "date", rawValueText: "2026-03-04T00:00:00.000Z" })] }),
  );
  assert.equal(accepted.outcome, "pass");
  assert.equal(accepted.resolvedValue, "2026-03-04");
  assert.equal(accepted.valueKind, "date");

  const unparsable = validateMapping(
    target,
    link,
    context({ answers: [answer("Q1", { responseType: "date", rawValueText: "04/03/2026" })] }),
  );
  assert.equal(unparsable.outcome, "fail");
  assert.equal(failIssue(unparsable)?.code, "value_not_iso_date");
});

// ------------------------------------------------------- documented missingness --

test("a required field whose source is documented as missing fails and never receives a value", () => {
  const report = preflight({
    fields: [
      field({ fieldId: "f_phq", title: "Item 9", fieldType: "linear_scale", options: ["0", "1", "2", "3"], isRequired: true }),
    ],
    mappings: [mapping("f_phq", { sourceRef: { fieldId: "f_phq", itemCode: "PHQ9" } })],
    context: context({
      answers: [answer("PHQ9", { responseType: "likert", isMissing: true, missingReason: "participant skipped item" })],
    }),
  });
  const validation = entry(report, "f_phq");
  assert.equal(validation.outcome, "fail");
  const failure = validation.issues.find((item) => item.code === "source_answer_missing");
  assert.ok(failure?.message.includes(MISSING_SOURCE_MESSAGE));
  assert.match(failure?.message ?? "", /participant skipped item/);
  assert.equal(validation.resolvedValue, null);
  assert.equal(validation.valueKind, "none");
  assert.equal(report.payload.f_phq, undefined);
  assert.deepEqual(Object.keys(report.payload), []);
  assert.equal(report.counts.missingSource, 1);
  assert.equal(report.outcome, "fail");
  assert.ok(report.auditNotes.some((note) => note.includes("no value, dash, empty string or placeholder")));
});

test("an optional field whose source is missing warns, omits the key and substitutes nothing", () => {
  const report = preflight({
    fields: [field({ fieldId: "f_opt", title: "Optional item" })],
    mappings: [mapping("f_opt", { sourceRef: { fieldId: "f_opt", itemCode: "Q5" } })],
    context: context({ answers: [answer("Q5", { isMissing: true, missingReason: "not administered" })] }),
  });
  const validation = entry(report, "f_opt");
  assert.equal(validation.outcome, "warn");
  assert.equal(validation.resolvedValue, null);
  assert.equal(validation.resolvedDisplay, null);
  assert.equal(validation.valueKind, "none");
  assert.equal("f_opt" in report.payload, false);
  assert.equal(report.counts.missingSource, 1);
  assert.equal(report.counts.warn, 1);
  assert.equal(report.counts.fail, 0);
  assert.equal(report.outcome, "warn");
});

test("an answer documented without recorded text is treated as missing, not as an empty string", () => {
  const validation = validateMapping(
    field({ fieldId: "f_q", title: "Q", isRequired: true }),
    mapping("f_q", { sourceRef: { fieldId: "f_q", itemCode: "Q1" } }),
    context({ answers: [answer("Q1", { rawValueText: "   ", valueCoded: null, valueNumeric: null })] }),
  );
  assert.equal(validation.outcome, "fail");
  assert.equal(failIssue(validation)?.code, "source_answer_empty_text");
  assert.equal(validation.resolvedValue, null);
  assert.equal(JSON.stringify(validation).includes('"resolvedValue":""'), false);
});

// ------------------------------------------------------------------ consent --

test("withdrawn consent fails the preflight, blocks submission and assembles no payload", () => {
  const report = preflight({
    fields: [field({ fieldId: "f_a", title: "A" })],
    mappings: [mapping("f_a", { sourceRef: { fieldId: "f_a", itemCode: "Q1" } })],
    context: context({ answers: [answer("Q1", { rawValueText: "documented" })] }),
    consent: { status: "withdrawn", version: "v2", withdrawnAt: "2026-01-30T08:00:00.000Z" },
  });
  assert.equal(report.outcome, "fail");
  assert.equal(report.authorization.participantConsentOnFile, false);
  assert.equal(report.authorization.submissionAllowedByPlatform, false);
  assert.notEqual(report.authorization.submissionBlockedReason, null);
  assert.match(report.authorization.submissionBlockedReason ?? "", /consent/);
  assert.deepEqual(report.payload, {});
  assert.ok(report.blockingReasons.some((reason) => reason.includes("consent is withdrawn")));
  assert.ok(report.blockingReasons.some((reason) => reason.includes("2026-01-30T08:00:00.000Z")));
  assert.equal(entry(report, "f_a").outcome, "pass");
});

test("without a verifiable platform submission path the payload stays a dry run for review", () => {
  const report = preflight({
    fields: [field({ fieldId: "f_q1", title: "Q1" })],
    mappings: [mapping("f_q1", { sourceRef: { fieldId: "f_q1", itemCode: "Q1" } })],
    context: context({ answers: [answer("Q1", { rawValueText: "documented answer" })] }),
  });
  assert.equal(PLATFORM_SUBMISSION_PATH_VERIFIED, false);
  assert.equal(report.dryRun, true);
  assert.equal(report.authorization.submissionAllowedByPlatform, false);
  assert.equal(report.authorization.participantConsentOnFile, true);
  assert.ok(report.authorization.submissionBlockedReason?.includes("no verified Google Forms response-submission API path"));
  assert.ok(report.blockingReasons.some((reason) => reason.includes("external submission blocked")));
  assert.deepEqual(report.payload, { f_q1: "documented answer" });
  assert.ok(report.auditNotes.some((note) => note.includes("dry run for researcher review")));
  assert.equal(report.counts.pass, 1);
});

test("an asserted platform authorization is recorded but still cannot submit", () => {
  const report = preflight({
    fields: [field({ fieldId: "f_q1", title: "Q1" })],
    mappings: [mapping("f_q1", { sourceRef: { fieldId: "f_q1", itemCode: "Q1" } })],
    context: context({ answers: [answer("Q1", { rawValueText: "documented answer" })] }),
    platformSubmissionAuthorized: true,
  });
  assert.equal(report.authorization.submissionAllowedByPlatform, false);
  assert.ok(report.auditNotes.some((note) => note.includes("platformSubmissionAuthorized=true was asserted")));
  assert.deepEqual(report.payload, { f_q1: "documented answer" });
});

// -------------------------------------------------------------------- counts --

test("counts report pass, warn, fail, unmappedRequired and missingSource accurately", () => {
  const report = preflight({
    fields: [
      field({ fieldId: "f_pass", title: "Pass", orderIndex: 0 }),
      field({ fieldId: "f_warn", title: "Warn", orderIndex: 1 }),
      field({ fieldId: "f_fail", title: "Fail", orderIndex: 2, isRequired: true }),
      field({ fieldId: "f_unmapped", title: "Unmapped", orderIndex: 3, isRequired: true }),
      field({ fieldId: "f_missing", title: "Missing", orderIndex: 4 }),
      field({ fieldId: "f_head", title: "Section", orderIndex: 5, fieldType: "section_header" }),
    ],
    mappings: [
      mapping("f_pass", { sourceRef: { fieldId: "f_pass", itemCode: "Q1" } }),
      mapping("f_warn", { sourceRef: { fieldId: "f_warn", itemCode: "Q2" }, status: "draft" }),
      mapping("f_fail", { sourceRef: { fieldId: "f_fail", itemCode: "Q3" } }),
      mapping("f_missing", { sourceRef: { fieldId: "f_missing", itemCode: "Q4" } }),
    ],
    context: context({
      answers: [
        answer("Q1", { rawValueText: "1" }),
        answer("Q2", { rawValueText: "2" }),
        answer("Q3", { isMissing: true, missingReason: "skipped" }),
        answer("Q4", { isMissing: true, missingReason: "skipped" }),
      ],
    }),
  });
  assert.deepEqual(report.counts, { pass: 2, warn: 2, fail: 2, unmappedRequired: 1, missingSource: 2 });
  assert.equal(report.fields.length, 6);
  assert.equal(report.outcome, "fail");
  assert.equal(entry(report, "f_pass").outcome, "pass");
  assert.equal(entry(report, "f_warn").outcome, "warn");
  assert.equal(entry(report, "f_fail").outcome, "fail");
  assert.equal(entry(report, "f_unmapped").outcome, "fail");
  assert.equal(entry(report, "f_missing").outcome, "warn");
  assert.equal(entry(report, "f_head").outcome, "pass");
  assert.deepEqual(report.payload, { f_pass: "1", f_warn: "2" });
});

// ------------------------------------------------------------------- mapping status --

test("mapping status gates values: rejected and stale block, draft warns but still previews", () => {
  const target = field({ fieldId: "f_q", title: "Q" });
  const sourceRef = { fieldId: "f_q", itemCode: "Q1" };
  const sourceContext = context({ answers: [answer("Q1", { rawValueText: "documented" })] });

  const rejected = validateMapping(target, mapping("f_q", { sourceRef, status: "rejected" }), sourceContext);
  assert.equal(rejected.outcome, "fail");
  assert.equal(failIssue(rejected)?.code, "mapping_rejected");
  assert.equal(rejected.resolvedValue, null);

  const stale = validateMapping(target, mapping("f_q", { sourceRef, status: "stale" }), sourceContext);
  assert.equal(stale.outcome, "fail");
  assert.equal(failIssue(stale)?.code, "mapping_stale");

  const draft = validateMapping(target, mapping("f_q", { sourceRef, status: "draft" }), sourceContext);
  assert.equal(draft.outcome, "warn");
  assert.equal(draft.resolvedValue, "documented");

  const report = preflight({
    fields: [target],
    mappings: [mapping("f_q", { sourceRef, status: "draft" })],
    context: sourceContext,
  });
  assert.deepEqual(report.payload, { f_q: "documented" });
});

test("orphan and duplicate mappings are reported as failures instead of being dropped", () => {
  const report = preflight({
    fields: [field({ fieldId: "f_a", title: "A" })],
    mappings: [
      mapping("f_a", { sourceRef: { fieldId: "f_a", itemCode: "Q1" } }),
      {
        mappingId: "map_dup",
        mappingKind: "observed_answer",
        valueTransform: "verbatim",
        sourceRef: { fieldId: "f_a", itemCode: "Q1" },
        status: "validated",
        rationale: null,
      },
      mapping("f_ghost", { mappingId: "map_ghost", sourceRef: { fieldId: "f_ghost", itemCode: "Q1" } }),
      {
        mappingId: "map_unbound",
        mappingKind: "observed_answer",
        valueTransform: "verbatim",
        sourceRef: { itemCode: "Q1" },
        status: "validated",
        rationale: null,
      },
    ],
    context: context({ answers: [answer("Q1", { rawValueText: "documented" })] }),
  });
  assert.equal(report.fields.length, 3);
  const duplicate = entry(report, "f_a");
  assert.equal(duplicate.outcome, "fail");
  assert.equal(failIssue(duplicate)?.code, "duplicate_mapping_for_field");
  assert.equal(report.payload.f_a, undefined);

  const ghost = report.fields.find((validation) => validation.mappingId === "map_ghost");
  assert.equal(ghost?.outcome, "fail");
  assert.equal(ghost?.issues[0]?.code, "mapping_targets_unknown_field");

  const unbound = report.fields.find((validation) => validation.mappingId === "map_unbound");
  assert.equal(unbound?.fieldTitle, "(mapping without field binding)");
  assert.equal(unbound?.issues[0]?.code, "mapping_field_binding_missing");

  assert.equal(report.counts.fail, 3);
  assert.equal(report.outcome, "fail");
  assert.ok(report.auditNotes.some((note) => note.includes("target no field of this form version")));
});

// ------------------------------------------------------------------ provenance --

test("every payload key carries machine-readable provenance on its field entry", () => {
  const report = preflight({
    fields: [field({ fieldId: "f_q1", title: "Q1" }), field({ fieldId: "f_free", title: "Free" })],
    mappings: [
      mapping("f_q1", { sourceRef: { fieldId: "f_q1", itemCode: "Q1" } }),
      mapping("f_free", { mappingKind: "fixed_constant", sourceRef: { fieldId: "f_free", value: "fixed" } }),
    ],
    context: context({
      answers: [answer("Q1", { rawValueText: "documented", documentedSourceId: "ds_42", sourceLocator: "sheet1!C7" })],
    }),
  });
  for (const key of Object.keys(report.payload)) {
    const provenance = entry(report, key).issues.find((item) => item.code === "mapping_provenance");
    assert.ok(provenance, `payload key ${key} must carry provenance`);
    assert.ok(provenance?.message.includes("payload value provenance"));
  }
  const observed = entry(report, "f_q1").issues.find((item) => item.code === "mapping_provenance");
  assert.equal(observed?.detail?.documentedSourceId, "ds_42");
  assert.equal(observed?.detail?.sourceLocator, "sheet1!C7");
  assert.equal(observed?.detail?.isMissing, false);
  assert.ok(report.auditNotes.some((note) => note.includes("fixed constants are used for: f_free")));
});

// ------------------------------------------------------------- other sources --

test("derived scores resolve from computed scales and refuse not-computable ones", () => {
  const target = field({ fieldId: "f_total", title: "Total", fieldType: "short_text", isRequired: true });
  const link = mapping("f_total", {
    mappingKind: "derived_score",
    valueTransform: "numeric_round",
    sourceRef: { fieldId: "f_total", scaleCode: "TOTAL", scoreField: "raw" },
  });

  const computed = validateMapping(target, link, context({ scores: [score("TOTAL", { rawScore: 12.6 })] }));
  assert.equal(computed.outcome, "pass");
  assert.equal(computed.resolvedValue, "13");
  assert.equal(computed.valueKind, "numeric");
  assert.ok(
    computed.issues.some((item) => item.code === "mapping_provenance" && item.detail?.algorithmVersion === "1.0.0"),
  );

  const notComputable = validateMapping(
    target,
    link,
    context({ scores: [score("TOTAL", { rawScore: null, computability: "not_computable" })] }),
  );
  assert.equal(notComputable.outcome, "fail");
  assert.equal(failIssue(notComputable)?.code, "source_score_not_computable");
  assert.equal(notComputable.resolvedValue, null);

  const unknownScale = validateMapping(target, link, context({ scores: [] }));
  assert.equal(unknownScale.outcome, "fail");
  assert.equal(failIssue(unknownScale)?.code, "source_score_not_found");

  // The same unavailable score on an optional field warns and omits the key.
  const optional = validateMapping(
    field({ fieldId: "f_total_opt", title: "Total optional" }),
    mapping("f_total_opt", {
      mappingKind: "derived_score",
      valueTransform: "numeric_round",
      sourceRef: { fieldId: "f_total_opt", scaleCode: "TOTAL", scoreField: "raw" },
    }),
    context({ scores: [score("TOTAL", { rawScore: null, computability: "not_computable" })] }),
  );
  assert.equal(optional.outcome, "warn");
  assert.equal(optional.resolvedValue, null);
});

test("participant attributes resolve documented values and never carry identity data", () => {
  const target = field({ fieldId: "f_cohort", title: "Cohort" });
  const link = mapping("f_cohort", {
    mappingKind: "participant_attribute",
    sourceRef: { fieldId: "f_cohort", attribute: "cohort_label" },
  });

  const resolved = validateMapping(target, link, context({ attributes: { cohort_label: "wave_2" } }));
  assert.equal(resolved.outcome, "pass");
  assert.equal(resolved.resolvedValue, "wave_2");
  assert.ok(resolved.issues.some((item) => item.code === "mapping_provenance" && item.detail?.attribute === "cohort_label"));

  const identity = validateMapping(
    target,
    mapping("f_cohort", {
      mappingKind: "participant_attribute",
      sourceRef: { fieldId: "f_cohort", attribute: "contact_email" },
    }),
    context({ attributes: { contact_email: "respondent@example.org" } }),
  );
  assert.equal(identity.outcome, "fail");
  assert.equal(failIssue(identity)?.code, "identity_attribute_not_permitted");
  assert.equal(identity.resolvedValue, null);

  const missing = validateMapping(target, link, context({ attributes: {} }));
  assert.equal(missing.outcome, "warn");
  assert.equal(missing.resolvedValue, null);
  assert.equal(failIssue(missing), undefined);
  assert.ok(missing.issues.some((item) => item.code === "source_attribute_missing"));
});

test("researcher-declared fixed constants are the only non-documented payload source", () => {
  const target = field({ fieldId: "f_wave", title: "Wave", fieldType: "multiple_choice", options: ["T1", "T2"] });
  const constant = mapping("f_wave", {
    mappingKind: "fixed_constant",
    sourceRef: { fieldId: "f_wave", value: "T1" },
    rationale: "single-wave study",
  });

  const resolved = validateMapping(target, constant, context());
  assert.equal(resolved.outcome, "pass");
  assert.equal(resolved.resolvedValue, "T1");
  assert.ok(
    resolved.issues.some((item) => item.code === "mapping_provenance" && item.detail?.mappingKind === "fixed_constant"),
  );

  const notAnOption = validateMapping(
    target,
    mapping("f_wave", { mappingKind: "fixed_constant", sourceRef: { fieldId: "f_wave", value: "T3" } }),
    context(),
  );
  assert.equal(notAnOption.outcome, "fail");
  assert.equal(failIssue(notAnOption)?.code, "value_not_an_option");

  const undeclared = validateMapping(
    target,
    mapping("f_wave", { mappingKind: "fixed_constant", sourceRef: { fieldId: "f_wave" } }),
    context(),
  );
  assert.equal(undeclared.outcome, "fail");
  assert.equal(failIssue(undeclared)?.code, "fixed_constant_value_missing");

  const report = preflight({ fields: [target], mappings: [constant] });
  assert.deepEqual(report.payload, { f_wave: "T1" });
});

// ------------------------------------------------------------- determinism --

test("the preflight is pure: generatedAt is injected and repeated runs are identical", () => {
  const input: PreflightInput = {
    studyId: "std_1",
    participantId: "pat_1",
    externalFormVersionId: "efv_1",
    fields: [field({ fieldId: "f_q1", title: "Q1" })],
    mappings: [mapping("f_q1", { sourceRef: { fieldId: "f_q1", itemCode: "Q1" } })],
    context: context({ answers: [answer("Q1", { rawValueText: "documented" })] }),
    consent: CONSENT_GRANTED,
    platformSubmissionAuthorized: false,
    generatedAt: "2026-02-01T10:00:00.000Z",
  };
  const first = buildPreflight(input);
  const second = buildPreflight({ ...input, generatedAt: "2026-02-01T10:00:00.000Z" });
  assert.equal(first.generatedAt, "2026-02-01T10:00:00.000Z");
  assert.deepEqual(first, second);

  const later = buildPreflight({ ...input, generatedAt: "2030-12-31T23:59:59.000Z" });
  assert.equal(later.generatedAt, "2030-12-31T23:59:59.000Z");
  assert.deepEqual(later.fields, first.fields);
  assert.deepEqual(later.payload, first.payload);

  assert.throws(
    () => buildPreflight({ ...input, generatedAt: undefined }),
    (error: unknown) => error instanceof DomainError && error.code === "generated_at_required",
  );
});

// ------------------------------------------------------------- version drift --

test("detectVersionDrift reports added, removed, retitled, retyped, option and order changes", () => {
  const previous = [
    field({ fieldId: "f_age", orderIndex: 0, title: "Age" }),
    field({ fieldId: "f_sex", orderIndex: 1, title: "Sex", fieldType: "multiple_choice", options: ["Male", "Female"] }),
    field({ fieldId: "f_note", orderIndex: 2, title: "Note" }),
  ];
  const current = [
    field({ fieldId: "f_sex", orderIndex: 0, title: "Sex at birth", fieldType: "dropdown", options: ["Male", "Female", "Other"] }),
    field({ fieldId: "f_age", orderIndex: 1, title: "Age" }),
    field({ fieldId: "f_new", orderIndex: 2, title: "New question" }),
  ];
  const drift = detectVersionDrift(previous, current);
  assert.deepEqual(drift.added, ["f_new"]);
  assert.deepEqual(drift.removed, ["f_note"]);
  assert.deepEqual(drift.retitled, [{ fieldId: "f_sex", previousTitle: "Sex", currentTitle: "Sex at birth" }]);
  assert.deepEqual(drift.retyped, [{ fieldId: "f_sex", previousType: "multiple_choice", currentType: "dropdown" }]);
  assert.deepEqual(drift.optionsAdded, [{ fieldId: "f_sex", options: ["Other"] }]);
  assert.deepEqual(drift.optionsRemoved, []);
  assert.deepEqual(drift.reordered, [
    { fieldId: "f_sex", previousIndex: 1, currentIndex: 0 },
    { fieldId: "f_age", previousIndex: 0, currentIndex: 1 },
  ]);

  assert.deepEqual(detectVersionDrift(previous, previous), {
    added: [],
    removed: [],
    retitled: [],
    retyped: [],
    optionsAdded: [],
    optionsRemoved: [],
    reordered: [],
  });

  const droppedOptions = detectVersionDrift(
    [field({ fieldId: "f_sex", title: "Sex", options: ["Male", "Female", "Other"] })],
    [field({ fieldId: "f_sex", title: "Sex", options: ["Male", "Female"] })],
  );
  assert.deepEqual(droppedOptions.optionsRemoved, [{ fieldId: "f_sex", options: ["Other"] }]);
});

// -------------------------------------------------------------- suggestions --

test("suggestMappings claims high confidence only on an exact normalised match", () => {
  const fields = [
    field({ fieldId: "f_age", orderIndex: 0, title: "01 Age at enrolment" }),
    field({ fieldId: "f_pick", orderIndex: 1, title: "Preferred activity", fieldType: "multiple_choice", options: ["Reading", "Sport"] }),
    field({ fieldId: "f_scale", orderIndex: 2, title: "Pain intensity", fieldType: "linear_scale", options: ["1", "2", "3", "4", "5"] }),
    field({ fieldId: "f_head", orderIndex: 3, title: "Part 2", fieldType: "section_header" }),
  ];
  const sourceContext = context({
    answers: [
      answer("AGE", { questionText: "Age at enrolment?", responseType: "numeric", rawValueText: "34", valueNumeric: 34 }),
      answer("ACT", { questionText: "Activities you enjoy", responseType: "checkbox", options: ["Reading", "Sport"], rawValueText: "Reading" }),
      answer("PAIN", { questionText: "Pain intensity", responseType: "likert", rawValueText: "3", valueNumeric: 3, minValue: 1, maxValue: 5 }),
    ],
  });
  const suggestions = suggestMappings(fields, sourceContext);

  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.fieldId),
    ["f_age", "f_pick", "f_scale"],
  );
  assert.deepEqual(
    suggestions.filter((suggestion) => suggestion.confidence === "high").map((suggestion) => suggestion.fieldId),
    ["f_age", "f_scale"],
  );

  const age = suggestions.find((suggestion) => suggestion.fieldId === "f_age");
  assert.equal(age?.suggestionKind, "observed_answer");
  assert.equal(age?.confidence, "high");
  assert.equal(age?.sourceRef.itemCode, "AGE");
  assert.equal(age?.sourceRef.fieldId, "f_age");

  const pick = suggestions.find((suggestion) => suggestion.fieldId === "f_pick");
  assert.equal(pick?.confidence, "medium");
  assert.equal(pick?.sourceRef.match, "option_labels");
  assert.equal(pick?.sourceRef.itemCode, "ACT");

  const scale = suggestions.find((suggestion) => suggestion.fieldId === "f_scale");
  assert.equal(scale?.confidence, "high");
  assert.equal(scale?.sourceRef.itemCode, "PAIN");

  assert.ok(suggestions.every((suggestion) => suggestion.reason.includes(SUGGESTION_ACCEPTANCE_NOTE)));
  assert.equal(suggestions.some((suggestion) => suggestion.suggestionKind === "fixed_constant"), false);
  assert.equal(suggestions.some((suggestion) => suggestion.fieldId === "f_head"), false);
  assert.deepEqual(suggestMappings([...fields].reverse(), sourceContext), suggestions);
});

test("suggestMappings stays low confidence when only a numeric range matches", () => {
  const suggestions: MappingSuggestion[] = suggestMappings(
    [field({ fieldId: "f_scale", title: "Weekly rating", fieldType: "linear_scale", options: ["1", "2", "3", "4", "5"] })],
    context({ answers: [answer("Q7", { questionText: "How often did you feel tired?", responseType: "likert", minValue: 1, maxValue: 5 })] }),
  );
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.confidence, "low");
  assert.equal(suggestions[0]?.sourceRef.match, "numeric_range");
  assert.equal(suggestions[0]?.suggestionKind, "observed_answer");
});

test("suggestMappings downgrades ambiguous exact title matches instead of guessing", () => {
  const suggestions = suggestMappings(
    [field({ fieldId: "f_age", title: "Age at enrolment" })],
    context({
      answers: [
        answer("Q1", { questionText: "Age at enrolment", rawValueText: "34" }),
        answer("Q2", { questionText: "Age at enrolment?", rawValueText: "34" }),
      ],
    }),
  );
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.confidence, "medium");
  assert.ok(suggestions[0]?.reason.includes("match equally"));
  assert.equal(suggestions[0]?.sourceRef.itemCode, "Q1");
});
