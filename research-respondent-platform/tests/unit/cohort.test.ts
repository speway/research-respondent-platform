/**
 * Cohort rule engine tests.
 *
 * The engine decides who is analysable, so these tests pin the methodological
 * rules as much as the mechanics: absent data never satisfies a criterion, every
 * trace shows observed vs expected, and the preview counts always add up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MISSING_BEHAVIOUR,
  FACT_FIELD_CATALOG,
  FACT_SUBJECTS,
  SUBJECT_OPERATORS,
  describeRule,
  evaluateCohort,
  evaluateRule,
  factFieldDescriptor,
  factSubjectDescriptor,
  parseRule,
  rulePolarity,
  validateRule,
} from "../../lib/domain/cohort.ts";
import { DomainError } from "../../lib/domain/types.ts";
import type {
  CohortRule,
  ParticipantFact,
  ParticipantFactAssessment,
  ParticipantFactConsent,
  ParticipantFactEnrolment,
  ParticipantFactScore,
} from "../../lib/domain/types.ts";

// ------------------------------------------------------------------ fixtures --

function fact(overrides: Partial<ParticipantFact> = {}): ParticipantFact {
  return {
    participantId: "p1",
    pseudonym: "P-001",
    attributes: {},
    consents: [],
    enrolments: [],
    assessments: [],
    scores: [],
    ...overrides,
  };
}

function consent(status: ParticipantFactConsent["status"], extra: Partial<ParticipantFactConsent> = {}): ParticipantFactConsent {
  return {
    status,
    studyId: "study-1",
    version: "v1",
    grantedAt: "2025-01-10T09:00:00.000Z",
    withdrawnAt: null,
    expiresAt: null,
    ...extra,
  };
}

function enrolment(status: ParticipantFactEnrolment["status"], extra: Partial<ParticipantFactEnrolment> = {}): ParticipantFactEnrolment {
  return { studyId: "study-1", status, enrolledAt: "2025-02-01T09:00:00.000Z", withdrawnAt: null, ...extra };
}

function assessment(extra: Partial<ParticipantFactAssessment> = {}): ParticipantFactAssessment {
  return {
    sessionId: "s1",
    studyId: "study-1",
    instrumentVersionId: "iv1",
    timepointLabel: "T1",
    completedAt: "2025-03-01T10:00:00.000Z",
    recordedAt: "2025-03-01T10:05:00.000Z",
    answeredItems: 18,
    totalItems: 20,
    missingItems: 2,
    ...extra,
  };
}

function score(extra: Partial<ParticipantFactScore> = {}): ParticipantFactScore {
  return {
    scaleCode: "TOLERANCE_TOTAL",
    instrumentVersionId: "iv1",
    rawScore: 42,
    transformedScore: 42,
    standardizedScore: 0.5,
    percentile: 70,
    computability: "computed",
    algorithmVersion: "1.0",
    assessmentSessionId: "s1",
    computedAt: "2025-03-01T10:06:00.000Z",
    ...extra,
  };
}

function rule(partial: Partial<CohortRule> = {}): CohortRule {
  return { id: "r1", subject: "participant_attribute", operator: "equals", ...partial };
}

const ageRule = (partial: Partial<CohortRule> = {}): CohortRule =>
  rule({ id: "age", subject: "participant_attribute", operator: "gte", field: "age_at_enrolment", value: 18, label: "Adult at enrolment", ...partial });

const consentRule = (partial: Partial<CohortRule> = {}): CohortRule =>
  rule({ id: "consent", subject: "consent", operator: "consent_status", value: "granted", label: "Consent on file", ...partial });

// ----------------------------------------------------------------- inclusion --

test("an inclusion criterion passes, fails definitively, and explains both", () => {
  const adult = fact({ attributes: { age_at_enrolment: 34 } });
  const minor = fact({ attributes: { age_at_enrolment: 16 } });

  const pass = evaluateRule(ageRule(), adult);
  assert.equal(pass.outcome, "include");
  assert.equal(pass.observed, "34");
  assert.equal(pass.expected, ">= 18");
  assert.equal(pass.missing, false);
  assert.equal(pass.label, "Adult at enrolment");
  assert.match(pass.explanation, /34/);
  assert.match(pass.explanation, />= 18/);
  assert.match(pass.explanation, /criterion is satisfied/i);

  const fail = evaluateRule(ageRule(), minor);
  assert.equal(fail.outcome, "exclude");
  assert.equal(fail.missing, false);
  assert.match(fail.explanation, /16/);
  assert.match(fail.explanation, /not satisfied/i);
  assert.match(fail.explanation, /excludes the participant/i);
});

test("numeric strings are compared as numbers, so an exported '34' is not silently dropped", () => {
  const trace = evaluateRule(ageRule(), fact({ attributes: { age_at_enrolment: "34" } }));
  assert.equal(trace.outcome, "include");
  assert.equal(trace.observed, '"34"');
});

test("prohibited conditions are exclusion rules and are counted as exclusion hits", () => {
  const forbidden = rule({ id: "region", field: "region", operator: "not_in", value: ["Moscow", "Tver"], label: "Outside pilot regions" });
  assert.equal(rulePolarity(forbidden), "exclusion");

  const hit = evaluateRule(forbidden, fact({ attributes: { region: "Moscow" } }));
  assert.equal(hit.outcome, "exclude");
  assert.match(hit.explanation, /prohibited condition was observed/i);

  const clear = evaluateRule(forbidden, fact({ attributes: { region: "Tula" } }));
  assert.equal(clear.outcome, "include");
  assert.match(clear.explanation, /prohibited condition was not observed/i);

  const preview = evaluateCohort([forbidden], [fact({ attributes: { region: "Moscow" } })]);
  assert.equal(preview.evaluations[0]?.excludeHits, 1);
  assert.equal(preview.evaluations[0]?.includeFailures, 0);
  assert.equal(preview.evaluations[0]?.decision, "excluded");
});

// ------------------------------------------------------------- missing data --

test("absent data is indeterminate by default, never a silent pass or fail", () => {
  const trace = evaluateRule(ageRule(), fact());
  assert.equal(DEFAULT_MISSING_BEHAVIOUR, "indeterminate");
  assert.equal(trace.outcome, "indeterminate");
  assert.equal(trace.missing, true);
  assert.match(trace.observed, /no value recorded/i);
  assert.match(trace.explanation, /can never satisfy/i);
  assert.match(trace.explanation, />= 18/);
});

test("missingBehaviour 'exclude' turns absent data into a documented exclusion", () => {
  const trace = evaluateRule(ageRule({ missingBehaviour: "exclude" }), fact());
  assert.equal(trace.outcome, "exclude");
  assert.equal(trace.missing, true);
  assert.match(trace.explanation, /missingBehaviour is "exclude"/i);

  const preview = evaluateCohort([ageRule({ missingBehaviour: "exclude" })], [fact()]);
  assert.equal(preview.excluded, 1);
  assert.equal(preview.included, 0);
});

test("missingBehaviour 'ignore' skips the rule but is surfaced as a cohort warning", () => {
  const trace = evaluateRule(ageRule({ missingBehaviour: "ignore" }), fact());
  assert.equal(trace.outcome, "not_applicable");
  assert.equal(trace.missing, true);
  assert.match(trace.explanation, /skipped/i);

  const preview = evaluateCohort([ageRule({ missingBehaviour: "ignore" })], [fact()]);
  assert.equal(preview.evaluations[0]?.decision, "included");
  const warning = preview.warnings.find((issue) => issue.code === "cohort.ignore_rules_present");
  assert.ok(warning, "expected an ignore-rules warning");
  assert.equal(warning.severity, "warn");
});

test("present-but-unusable values are treated as missing, not as zero", () => {
  const trace = evaluateRule(ageRule(), fact({ attributes: { age_at_enrolment: "not recorded" } }));
  assert.equal(trace.outcome, "indeterminate");
  assert.equal(trace.missing, true);
  assert.match(trace.explanation, /not a usable number/i);
});

test("missing markers such as 'n/a' count as absent, while is_missing satisfies on them", () => {
  const stored = fact({ attributes: { region: "n/a" } });
  assert.equal(evaluateRule(rule({ id: "eq", field: "region", operator: "equals", value: "Moscow" }), stored).outcome, "indeterminate");

  const missingTrace = evaluateRule(rule({ id: "miss", field: "region", operator: "is_missing" }), stored);
  assert.equal(missingTrace.outcome, "include");
  assert.equal(missingTrace.missing, true);
  assert.match(missingTrace.explanation, /criterion is satisfied/i);

  const presentOnEmpty = evaluateRule(rule({ id: "pres", field: "region", operator: "is_present" }), fact());
  assert.equal(presentOnEmpty.outcome, "indeterminate");
  const presentExcluded = evaluateRule(rule({ id: "pres", field: "region", operator: "is_present", missingBehaviour: "exclude" }), fact());
  assert.equal(presentExcluded.outcome, "exclude");
});

// ------------------------------------------------------------------- consent --

test("consent status covers granted, declined, withdrawn, expired and none", () => {
  const expected: Array<[ParticipantFactConsent["status"], string]> = [
    ["granted", "include"],
    ["declined", "exclude"],
    ["withdrawn", "exclude"],
    ["expired", "exclude"],
  ];
  for (const [status, outcome] of expected) {
    const trace = evaluateRule(consentRule(), fact({ consents: [consent(status)] }));
    assert.equal(trace.outcome, outcome, `status ${status}`);
    assert.equal(trace.observed, JSON.stringify(status));
    assert.equal(trace.expected, 'consent status "granted"');
  }
});

test("a consent record explicitly marked 'none' can satisfy a none rule but never a granted rule", () => {
  const stored = fact({ consents: [consent("none")] });
  assert.equal(evaluateRule(consentRule({ value: "none" }), stored).outcome, "include");
  assert.equal(evaluateRule(consentRule(), stored).outcome, "exclude");
});

test("a participant with no consent record is indeterminate, or excluded when the researcher says so", () => {
  const empty = fact();
  assert.equal(evaluateRule(consentRule(), empty).outcome, "indeterminate");
  assert.equal(evaluateRule(consentRule({ missingBehaviour: "exclude" }), empty).outcome, "exclude");
  const trace = evaluateRule(consentRule({ missingBehaviour: "ignore" }), empty);
  assert.equal(trace.outcome, "not_applicable");
});

test("consent rules scope to the study named in field, and the newest record wins", () => {
  const twoStudies = fact({
    consents: [
      consent("granted", { studyId: "study-1" }),
      consent("withdrawn", { studyId: "study-2", grantedAt: "2024-05-01T00:00:00.000Z", withdrawnAt: "2025-05-01T00:00:00.000Z" }),
    ],
  });
  assert.equal(evaluateRule(consentRule({ field: "study-1" }), twoStudies).outcome, "include");
  assert.equal(evaluateRule(consentRule({ field: "study-2" }), twoStudies).outcome, "exclude");
  assert.equal(evaluateRule(consentRule({ field: "study-3" }), twoStudies).outcome, "indeterminate");

  const superseded = fact({
    consents: [
      consent("granted", { grantedAt: "2025-01-10T09:00:00.000Z" }),
      consent("withdrawn", { grantedAt: "2024-01-10T09:00:00.000Z", withdrawnAt: "2025-02-01T09:00:00.000Z" }),
    ],
  });
  const trace = evaluateRule(consentRule(), superseded);
  assert.equal(trace.outcome, "exclude");
  assert.equal(trace.observed, '"withdrawn"');
});

// ------------------------------------------------------------ study status --

test("study enrolment status is evaluated per study and tolerates status lists", () => {
  const active = fact({ enrolments: [enrolment("active")] });
  assert.equal(evaluateRule(rule({ id: "st", subject: "study_enrolment", operator: "study_status", value: "active" }), active).outcome, "include");
  assert.equal(evaluateRule(rule({ id: "st", subject: "study_enrolment", operator: "study_status", value: "withdrawn" }), active).outcome, "exclude");
  assert.equal(
    evaluateRule(rule({ id: "st", subject: "study_enrolment", operator: "in", value: ["enrolled", "active"] }), active).outcome,
    "include",
  );
  assert.equal(evaluateRule(rule({ id: "st", subject: "study_enrolment", operator: "study_status", value: "active" }), fact()).outcome, "indeterminate");
  assert.equal(
    evaluateRule(rule({ id: "st", subject: "study_enrolment", operator: "study_status", value: "active", field: "study-9" }), active).outcome,
    "indeterminate",
  );
});

// ----------------------------------------------------------- numeric bounds --

test("age gte, lte and between treat both bounds as inclusive", () => {
  const value = (age: number) => evaluateRule(ageRule(), fact({ attributes: { age_at_enrolment: age } })).outcome;
  assert.equal(value(18), "include");
  assert.equal(value(17), "exclude");

  const atMost = ageRule({ operator: "lte", value: 65 });
  assert.equal(evaluateRule(atMost, fact({ attributes: { age_at_enrolment: 65 } })).outcome, "include");
  assert.equal(evaluateRule(atMost, fact({ attributes: { age_at_enrolment: 66 } })).outcome, "exclude");

  const between = ageRule({ operator: "between", value: 18, valueMax: 65 });
  assert.equal(evaluateRule(between, fact({ attributes: { age_at_enrolment: 18 } })).outcome, "include");
  assert.equal(evaluateRule(between, fact({ attributes: { age_at_enrolment: 65 } })).outcome, "include");
  assert.equal(evaluateRule(between, fact({ attributes: { age_at_enrolment: 17 } })).outcome, "exclude");
  assert.equal(evaluateRule(between, fact({ attributes: { age_at_enrolment: 66 } })).outcome, "exclude");
  const trace = evaluateRule(between, fact({ attributes: { age_at_enrolment: 40 } }));
  assert.equal(trace.expected, "between 18 and 65 inclusive");
});

test("string and numeric membership lists match by value, not by string form", () => {
  const education = rule({ id: "edu", field: "education_level", operator: "in", value: ["higher", "secondary"] });
  assert.equal(evaluateRule(education, fact({ attributes: { education_level: "Higher" } })).outcome, "include");
  assert.equal(evaluateRule(education, fact({ attributes: { education_level: "primary" } })).outcome, "exclude");

  const ages = ageRule({ operator: "in", value: [18, 19, 20] });
  assert.equal(evaluateRule(ages, fact({ attributes: { age_at_enrolment: 19 } })).outcome, "include");
  assert.equal(evaluateRule(ages, fact({ attributes: { age_at_enrolment: "20" } })).outcome, "include");
  assert.equal(evaluateRule(ages, fact({ attributes: { age_at_enrolment: 21 } })).outcome, "exclude");
});

// -------------------------------------------------------------- scale score --

test("scale score rules compare the requested metric and ignore non-computable scores", () => {
  const withScore = fact({ assessments: [assessment()], scores: [score()] });
  const gte = rule({ id: "tol", subject: "scale_score", operator: "gte", value: 40, scaleCode: "TOLERANCE_TOTAL", label: "Tolerance raw" });
  assert.equal(evaluateRule(gte, withScore).outcome, "include");
  assert.equal(evaluateRule({ ...gte, value: 50 }, withScore).outcome, "exclude");

  const percentile = { ...gte, field: "percentile", value: 70, label: "Tolerance percentile" };
  const percentileTrace = evaluateRule(percentile, withScore);
  assert.equal(percentileTrace.outcome, "include");
  assert.match(percentileTrace.explanation, /percentile/i);
  assert.equal(evaluateRule({ ...percentile, value: 71 }, withScore).outcome, "exclude");

  const notComputable = fact({
    assessments: [assessment()],
    scores: [score({ computability: "not_computable", rawScore: null, percentile: null })],
  });
  const trace = evaluateRule(gte, notComputable);
  assert.equal(trace.outcome, "indeterminate");
  assert.equal(trace.missing, true);
  assert.match(trace.explanation, /not computable/i);

  assert.equal(evaluateRule(gte, fact()).outcome, "indeterminate");
});

test("has_scale_score requires a computable score for the named scale", () => {
  const ruleHas = rule({ id: "has", subject: "scale_score", operator: "has_scale_score", scaleCode: "TOLERANCE_TOTAL" });
  const computable = fact({ assessments: [assessment()], scores: [score()] });
  assert.equal(evaluateRule(ruleHas, computable).outcome, "include");

  const broken = fact({ assessments: [assessment()], scores: [score({ computability: "not_computable" })] });
  assert.equal(evaluateRule(ruleHas, broken).outcome, "exclude");

  assert.equal(evaluateRule(ruleHas, fact()).outcome, "indeterminate");
});

test("scale score rules honour withinDays only when a reference instant is supplied", () => {
  const withScore = fact({ assessments: [assessment()], scores: [score()] });
  const windowed = rule({
    id: "recent",
    subject: "scale_score",
    operator: "gte",
    value: 40,
    scaleCode: "TOLERANCE_TOTAL",
    withinDays: 30,
  });

  const undated = evaluateRule(windowed, withScore);
  assert.equal(undated.outcome, "indeterminate");
  assert.match(undated.explanation, /no usable reference timestamp/i);

  assert.equal(evaluateRule(windowed, withScore, { now: "2025-03-10T00:00:00.000Z" }).outcome, "include");
  assert.equal(evaluateRule(windowed, withScore, { now: "2025-06-01T00:00:00.000Z" }).outcome, "indeterminate");
});

// ------------------------------------------------------------- assessment ----

test("has_any_assessment counts matching sessions and respects the minimum count", () => {
  const one = fact({ assessments: [assessment()] });
  const hasAny = rule({ id: "any", subject: "assessment", operator: "has_any_assessment" });
  assert.equal(evaluateRule(hasAny, one).outcome, "include");
  assert.equal(evaluateRule(hasAny, fact()).outcome, "exclude");
  assert.equal(evaluateRule({ ...hasAny, value: 2 }, one).outcome, "exclude");
  assert.equal(
    evaluateRule({ ...hasAny, timepointLabel: "T2" }, one).outcome,
    "exclude",
    "a session at another timepoint must not satisfy a T2 rule",
  );
});

test("missingness_at_most aggregates item coverage, accepts proportions and percentages, and never assumes zero", () => {
  const sessions = fact({ assessments: [assessment(), assessment({ sessionId: "s2", missingItems: 8, totalItems: 20 })] });
  const threshold = (value: number) => rule({ id: "miss", subject: "assessment", operator: "missingness_at_most", value });

  const included = evaluateRule(threshold(0.3), sessions);
  assert.equal(included.outcome, "include");
  assert.match(included.observed, /25%/);
  assert.match(included.observed, /10 of 40 items missing across 2 session\(s\)/);

  assert.equal(evaluateRule(threshold(0.2), sessions).outcome, "exclude");
  assert.equal(evaluateRule(threshold(25), sessions).outcome, "include");
  assert.equal(evaluateRule(threshold(24), sessions).outcome, "exclude");
  assert.equal(evaluateRule(threshold(0.3), fact()).outcome, "indeterminate");

  const noItems = fact({ assessments: [assessment({ totalItems: 0, answeredItems: 0, missingItems: 0 })] });
  assert.equal(evaluateRule(threshold(0.3), noItems).outcome, "indeterminate");
});

test("data_quality missingness rates the participant record itself", () => {
  const partlyRecorded = fact({ attributes: { region: "Moscow" } });
  const loose = rule({ id: "dq-loose", subject: "data_quality", operator: "missingness_at_most", value: 0.9 });
  const strict = rule({ id: "dq-strict", subject: "data_quality", operator: "missingness_at_most", value: 0.5 });

  const trace = evaluateRule(loose, partlyRecorded);
  assert.equal(trace.outcome, "include");
  assert.match(trace.observed, /6 of 7 attributes missing/);
  assert.equal(evaluateRule(strict, partlyRecorded).outcome, "exclude");

  const oneField = rule({ id: "dq-one", subject: "data_quality", operator: "missingness_at_most", value: 0, field: "region" });
  assert.equal(evaluateRule(oneField, partlyRecorded).outcome, "include");
  assert.equal(evaluateRule(oneField, fact()).outcome, "exclude");
});

// ------------------------------------------------------------- aggregation ---

test("preview counts, ruleSummary and missingnessSummary stay consistent", () => {
  const rules = [ageRule(), consentRule()];
  const facts = [
    fact({ participantId: "p1", pseudonym: "P-001", attributes: { age_at_enrolment: 34 }, consents: [consent("granted")] }),
    fact({ participantId: "p2", pseudonym: "P-002", attributes: { age_at_enrolment: 16 }, consents: [] }),
    fact({ participantId: "p3", pseudonym: "P-003", attributes: {}, consents: [] }),
  ];
  const preview = evaluateCohort(rules, facts);

  assert.equal(preview.denominator, 3);
  assert.equal(preview.included, 1);
  assert.equal(preview.excluded, 1);
  assert.equal(preview.indeterminate, 1);
  assert.equal(preview.included + preview.excluded + preview.indeterminate, preview.denominator);
  assert.equal(preview.warnings.length, 0, "valid rules must not raise warnings");
  assert.deepEqual(
    preview.evaluations.map((entry) => entry.decision),
    ["included", "excluded", "indeterminate"],
  );

  assert.equal(preview.ruleSummary.length, 2);
  const [ageSummary, consentSummary] = preview.ruleSummary;
  assert.equal(ageSummary?.ruleId, "age");
  assert.equal(ageSummary?.label, "Adult at enrolment");
  assert.deepEqual(
    { include: ageSummary?.include, exclude: ageSummary?.exclude, indeterminate: ageSummary?.indeterminate, notApplicable: ageSummary?.notApplicable },
    { include: 1, exclude: 1, indeterminate: 1, notApplicable: 0 },
  );
  assert.equal(consentSummary?.include, 1);
  assert.equal(consentSummary?.indeterminate, 2);

  const ageField = preview.missingnessSummary.find((entry) => entry.field === "age_at_enrolment");
  assert.ok(ageField, "age_at_enrolment must appear in the missingness summary");
  assert.equal(ageField.missingCount, 1);
  assert.equal(ageField.presentCount, 2);
  const consentField = preview.missingnessSummary.find((entry) => entry.field === "consent.status");
  assert.ok(consentField);
  assert.equal(consentField.missingCount, 2);
  assert.equal(consentField.presentCount, 1);

  const third = preview.evaluations[2];
  assert.equal(third?.indeterminateReasons.length, 2);
  assert.match(third?.indeterminateReasons[0] ?? "", /Adult at enrolment/);
});

test("records with unknown data are never silently counted as included", () => {
  const rules = [ageRule(), consentRule(), rule({ id: "region", field: "region", operator: "not_in", value: ["Moscow"] })];
  const facts = [
    fact({ participantId: "blank", pseudonym: "P-BLANK" }),
    fact({ participantId: "partial", pseudonym: "P-PARTIAL", attributes: { age_at_enrolment: 30 } }),
    fact({
      participantId: "full",
      pseudonym: "P-FULL",
      attributes: { age_at_enrolment: 30, region: "Tula" },
      consents: [consent("granted")],
    }),
  ];
  const preview = evaluateCohort(rules, facts);

  assert.equal(preview.denominator, 3);
  assert.equal(preview.included, 1);
  assert.equal(preview.indeterminate, 2);
  assert.equal(preview.excluded, 0);
  assert.equal(preview.evaluations[0]?.decision, "indeterminate");
  assert.equal(preview.evaluations[1]?.decision, "indeterminate");

  for (const evaluation of preview.evaluations.filter((entry) => entry.decision === "included")) {
    for (const trace of evaluation.traces) {
      assert.equal(trace.outcome, "include", `${evaluation.pseudonym}: ${trace.label} -> ${trace.outcome}`);
      assert.equal(trace.missing, false);
    }
  }
  assert.equal(preview.evaluations.find((entry) => entry.pseudonym === "P-BLANK")?.includeFailures, 0);
});

test("evaluation is pure and deterministic across repeated runs", () => {
  const rules = [ageRule(), consentRule(), rule({ id: "edu", field: "education_level", operator: "in", value: ["higher"] })];
  const facts = [
    fact({ participantId: "p1", attributes: { age_at_enrolment: 34, education_level: "higher" }, consents: [consent("granted")] }),
    fact({ participantId: "p2", attributes: { age_at_enrolment: 15 } }),
  ];
  const before = JSON.stringify({ rules, facts });
  const first = JSON.stringify(evaluateCohort(rules, facts));
  const second = JSON.stringify(evaluateCohort(rules, facts));
  assert.equal(first, second);
  assert.equal(JSON.stringify({ rules, facts }), before, "evaluation must not mutate its inputs");
});

test("an empty rule set includes everyone and says so", () => {
  const preview = evaluateCohort([], [fact()]);
  assert.equal(preview.included, 1);
  assert.equal(preview.denominator, 1);
  assert.equal(preview.warnings.some((issue) => issue.code === "cohort.no_rules"), true);
});

test("duplicate rule ids are reported instead of silently doubling the filter", () => {
  const preview = evaluateCohort([ageRule(), ageRule()], [fact({ attributes: { age_at_enrolment: 30 } })]);
  assert.equal(preview.warnings.some((issue) => issue.code === "cohort.duplicate_rule_id"), true);
  assert.equal(preview.ruleSummary.length, 1);
  assert.equal(preview.ruleSummary[0]?.include, 2);
});

// -------------------------------------------------------------- validation ---

test("validateRule flags unusable schemas with actionable codes", () => {
  const codes = (candidate: CohortRule) => validateRule(candidate).map((issue) => issue.code);
  const failures = (candidate: CohortRule) => validateRule(candidate).filter((issue) => issue.severity === "fail");

  assert.deepEqual(codes(ageRule()), []);
  assert.equal(codes(ageRule({ operator: "between", value: 18 })).includes("rule.between_max_required"), true);
  assert.equal(codes(rule({ id: "s", subject: "scale_score", operator: "gte", value: 20, field: "rawScore" })).includes("rule.scale_code_required"), true);
  assert.equal(
    codes(rule({ id: "x", subject: "participant_attribute", operator: "consent_status", value: "granted", field: "region" })).includes(
      "rule.operator_unsupported",
    ),
    true,
  );
  assert.equal(codes(rule({ id: "x", subject: "consent", operator: "consent_status", value: "maybe" })).includes("rule.status_unknown"), true);
  assert.equal(codes(ageRule({ withinDays: 0 })).includes("rule.within_days_invalid"), true);
  assert.equal(codes(ageRule({ operator: "in", value: [] })).includes("rule.value_empty"), true);
  assert.equal(codes(ageRule({ operator: "gte", value: true })).includes("rule.value_not_numeric"), true);
  assert.equal(codes(rule({ id: "x", subject: "data_quality", operator: "is_missing" })).includes("rule.field_required"), true);
  assert.equal(codes(rule({ id: "x", subject: "assessment", operator: "missingness_at_most", value: 150 })).includes("rule.threshold_out_of_range"), true);
  assert.equal(failures(rule({ id: "", field: "region" })).some((issue) => issue.code === "rule.id_required"), true);

  const unknownField = validateRule(rule({ id: "x", field: "favourite_colour", operator: "equals", value: "blue" }));
  assert.equal(unknownField.some((issue) => issue.code === "rule.field_unknown" && issue.severity === "warn"), true);
});

test("a misconfigured rule is indeterminate at evaluation time instead of throwing", () => {
  const broken = ageRule({ operator: "between", value: 18 });
  const trace = evaluateRule(broken, fact({ attributes: { age_at_enrolment: 30 } }));
  assert.equal(trace.outcome, "indeterminate");
  assert.match(trace.explanation, /misconfigured/i);
  const preview = evaluateCohort([broken], [fact({ attributes: { age_at_enrolment: 30 } })]);
  assert.equal(preview.included, 0);
  assert.equal(preview.warnings.some((issue) => issue.code === "rule.between_max_required"), true);
});

// ----------------------------------------------------------------- parsing ---

test("parseRule normalises stored JSON and rejects unusable rules", () => {
  const parsed = parseRule({
    id: "  age  ",
    subject: "participant_attribute",
    operator: "gte",
    field: "age_at_enrolment",
    value: "18",
    label: " Adult ",
    missingBehaviour: "exclude",
  });
  assert.equal(parsed.id, "age");
  assert.equal(parsed.value, 18);
  assert.equal(parsed.label, "Adult");
  assert.equal(parsed.missingBehaviour, "exclude");
  assert.equal(evaluateRule(parsed, fact({ attributes: { age_at_enrolment: 30 } })).outcome, "include");

  const invalid = (input: unknown, field: string) =>
    assert.throws(
      () => parseRule(input),
      (error: unknown) => error instanceof DomainError && error.code === "cohort.rule_invalid" && error.detail.field === field,
    );
  invalid(null, "rule");
  invalid({ subject: "consent", operator: "consent_status", value: "granted" }, "id");
  invalid({ id: "x", subject: "consent", operator: "consent_status", value: "granted", missingBehaviour: "maybe" }, "missingBehaviour");
  invalid({ id: "x", subject: "participant_attribute", operator: "between", field: "age_at_enrolment", value: 18 }, "valueMax");
  invalid({ id: "x", subject: "scale_score", operator: "gte", value: 20 }, "scaleCode");
  invalid({ id: "x", subject: "consent", operator: "is_missing", value: "granted" }, "value");
  invalid({ id: "x", subject: "participant_attribute", operator: "in", field: "region", value: [] }, "value");
});

// ----------------------------------------------------------------- catalog ---

test("the field catalog describes every subject with typed, usable filter metadata", () => {
  assert.deepEqual(Object.keys(FACT_FIELD_CATALOG).sort(), [...FACT_SUBJECTS].sort());
  for (const subject of FACT_SUBJECTS) {
    const descriptor = FACT_FIELD_CATALOG[subject];
    assert.equal(descriptor.subject, subject);
    assert.ok(descriptor.fields.length > 0, `${subject} needs at least one field`);
    assert.ok(SUBJECT_OPERATORS[subject].length > 0, `${subject} needs at least one operator`);
    for (const field of descriptor.fields) {
      assert.ok(field.operators.length > 0, `${subject}.${field.field ?? field.label} needs operators`);
      for (const operator of field.operators) {
        assert.equal(SUBJECT_OPERATORS[subject].includes(operator), true, `${operator} is not allowed on ${subject}`);
      }
    }
  }
  assert.deepEqual(
    Object.keys(SUBJECT_OPERATORS).sort(),
    [...FACT_SUBJECTS].sort(),
  );
  const age = FACT_FIELD_CATALOG.participant_attribute.fields.find((field) => field.field === "age_at_enrolment");
  assert.equal(age?.type, "integer");
  assert.equal(age?.operators.includes("between"), true);
  assert.equal(age?.operators.includes("consent_status"), false);
  assert.equal(factFieldDescriptor("participant_attribute", "age_at_enrolment")?.type, "integer");
  assert.equal(factFieldDescriptor("consent", undefined)?.type, "enum");
  assert.equal(factSubjectDescriptor("consent").fieldRole, "study_scope");
  assert.equal(factSubjectDescriptor("assessment").fieldRole, "none");
});

test("describeRule produces a readable label when the rule has none", () => {
  assert.equal(describeRule(ageRule({ label: undefined })), "Age at enrolment is at least 18");
  assert.equal(describeRule(consentRule({ label: undefined })), 'Consent status is "granted"');
  assert.equal(
    describeRule(rule({ id: "x", subject: "assessment", operator: "missingness_at_most", value: 0.2, label: undefined })),
    "Item missingness is at most 20%",
  );
});
