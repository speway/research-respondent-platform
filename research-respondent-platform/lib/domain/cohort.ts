/**
 * Pure, deterministic cohort / eligibility rule engine.
 *
 * Methodological contract enforced here:
 * - Every rule is a *requirement*. A trace outcome of `include` means the
 *   requirement is satisfied, `exclude` means it is definitively not satisfied,
 *   `indeterminate` means the data cannot answer the question, and
 *   `not_applicable` means the researcher explicitly asked for absent data to be
 *   skipped (`missingBehaviour: "ignore"`).
 * - Absent or unknown data NEVER satisfies a criterion: it yields
 *   `indeterminate` unless `missingBehaviour` says otherwise, and a participant
 *   is never counted as included while an unresolved criterion remains.
 * - Every explanation states the observed value, the expected value and why the
 *   decision was reached, in plain English, so the decision can be defended.
 * - No I/O, no ambient clock: `withinDays` windows need an explicit ``now``.
 */
import { DomainError } from "./types.ts";
import { finiteNumber, integer, isoDateTime } from "./guards.ts";
import type {
  CohortEvaluation,
  CohortPreview,
  CohortRule,
  CohortRuleOperator,
  CohortRuleSubject,
  CohortRuleTrace,
  ParticipantFact,
  ParticipantFactAssessment,
  ParticipantFactConsent,
  RuleIssue,
} from "./types.ts";

// ------------------------------------------------------------- vocabulary ----

export const MISSING_BEHAVIOURS = ["indeterminate", "exclude", "ignore"] as const;
export type MissingBehaviour = (typeof MISSING_BEHAVIOURS)[number];
export const DEFAULT_MISSING_BEHAVIOUR: MissingBehaviour = "indeterminate";

export const CONSENT_STATUSES = ["granted", "declined", "withdrawn", "expired", "none"] as const;
export const STUDY_STATUSES = ["invited", "enrolled", "active", "completed", "withdrawn", "excluded"] as const;

export const SCORE_METRICS = ["rawScore", "transformedScore", "standardizedScore", "percentile"] as const;
export type ScoreMetric = (typeof SCORE_METRICS)[number];
export const DEFAULT_SCORE_METRIC: ScoreMetric = "rawScore";

/**
 * Operators that describe a prohibited state ("must not be X"). They map to
 * `segment_rule.kind = 'exclude'`; every other operator is an inclusion
 * criterion (`kind = 'include'`). `CohortEvaluation.excludeHits` counts hits on
 * prohibited states, `includeFailures` counts failed inclusion criteria.
 */
export const PROHIBITIVE_OPERATORS = ["not_equals", "not_in", "is_missing"] as const;

export function isProhibitiveOperator(operator: CohortRuleOperator): boolean {
  return (PROHIBITIVE_OPERATORS as readonly string[]).includes(operator);
}

export type RulePolarity = "inclusion" | "exclusion";

export function rulePolarity(rule: CohortRule): RulePolarity {
  return isProhibitiveOperator(rule.operator) ? "exclusion" : "inclusion";
}

export const FACT_SUBJECTS: readonly CohortRuleSubject[] = [
  "participant_attribute",
  "consent",
  "study_enrolment",
  "scale_score",
  "assessment",
  "data_quality",
];

export const ALL_OPERATORS: readonly CohortRuleOperator[] = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "gte",
  "lte",
  "between",
  "is_missing",
  "is_present",
  "has_any_assessment",
  "has_scale_score",
  "consent_status",
  "study_status",
  "missingness_at_most",
];

/** Operator/subject compatibility matrix, also consumed by `validateRule`. */
export const SUBJECT_OPERATORS: Record<CohortRuleSubject, readonly CohortRuleOperator[]> = {
  participant_attribute: ["equals", "not_equals", "in", "not_in", "gte", "lte", "between", "is_missing", "is_present"],
  consent: ["consent_status", "equals", "not_equals", "in", "not_in", "is_missing", "is_present"],
  study_enrolment: ["study_status", "equals", "not_equals", "in", "not_in", "is_missing", "is_present"],
  scale_score: ["gte", "lte", "between", "equals", "not_equals", "in", "not_in", "is_missing", "is_present", "has_scale_score"],
  assessment: ["has_any_assessment", "has_scale_score", "missingness_at_most", "is_missing", "is_present"],
  data_quality: ["missingness_at_most", "is_missing", "is_present"],
};

// ------------------------------------------------- field metadata catalog ----

export type FactFieldType = "integer" | "number" | "string" | "boolean" | "enum" | "score_number" | "ratio";

export interface FactFieldOption {
  value: string;
  label: string;
}

export interface FactFieldDescriptor {
  /** Value for `CohortRule.field`, or null when the fact is selected by the operator. */
  field: string | null;
  label: string;
  type: FactFieldType;
  operators: readonly CohortRuleOperator[];
  options?: readonly FactFieldOption[];
  min?: number;
  max?: number;
  /** True when the engine derives the fact instead of reading a stored column. */
  derived?: boolean;
  note?: string;
}

export interface FactSubjectDescriptor {
  subject: CohortRuleSubject;
  label: string;
  description: string;
  /** How `CohortRule.field` is used for this subject. */
  fieldRole: "fact_field" | "study_scope" | "none";
  /** Additional rule keys that narrow the fact lookup. */
  scopeKeys: readonly ("instrumentVersionId" | "scaleCode" | "timepointLabel" | "withinDays")[];
  fields: readonly FactFieldDescriptor[];
}

export type FactFieldCatalog = Record<CohortRuleSubject, FactSubjectDescriptor>;

const ATTRIBUTE_OPERATORS: readonly CohortRuleOperator[] = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "gte",
  "lte",
  "between",
  "is_missing",
  "is_present",
];
const TEXT_MATCH_OPERATORS: readonly CohortRuleOperator[] = ["equals", "not_equals", "in", "not_in", "is_missing", "is_present"];

const ATTRIBUTE_FIELDS: readonly FactFieldDescriptor[] = [
  {
    field: "age_at_enrolment",
    label: "Age at enrolment",
    type: "integer",
    min: 0,
    max: 130,
    operators: ATTRIBUTE_OPERATORS,
    note: "Age as recorded when the participant was enrolled; never recomputed from today's date.",
  },
  { field: "birth_year", label: "Birth year", type: "integer", min: 1900, max: 2100, operators: ATTRIBUTE_OPERATORS },
  { field: "self_described_gender", label: "Self-described gender", type: "string", operators: TEXT_MATCH_OPERATORS },
  { field: "preferred_language", label: "Preferred language", type: "string", operators: TEXT_MATCH_OPERATORS },
  { field: "education_level", label: "Education level", type: "string", operators: TEXT_MATCH_OPERATORS },
  { field: "region", label: "Region", type: "string", operators: TEXT_MATCH_OPERATORS },
  { field: "recruitment_channel", label: "Recruitment channel", type: "string", operators: TEXT_MATCH_OPERATORS },
];

/** Cohort-safe participant attributes carried on every participant record. */
export const PARTICIPANT_ATTRIBUTE_FIELDS: readonly string[] = ATTRIBUTE_FIELDS.flatMap((descriptor) =>
  descriptor.field === null ? [] : [descriptor.field],
);

const CONSENT_FIELDS: readonly FactFieldDescriptor[] = [
  {
    field: null,
    label: "Consent status",
    type: "enum",
    options: [
      { value: "granted", label: "Granted" },
      { value: "declined", label: "Declined" },
      { value: "withdrawn", label: "Withdrawn" },
      { value: "expired", label: "Expired" },
      { value: "none", label: "No consent record" },
    ],
    operators: SUBJECT_OPERATORS.consent,
    note: "The effective record is the most recently active consent; ties break towards the more restrictive status.",
  },
];

const ENROLMENT_FIELDS: readonly FactFieldDescriptor[] = [
  {
    field: null,
    label: "Enrolment status",
    type: "enum",
    options: STUDY_STATUSES.map((status) => ({ value: status, label: status.charAt(0).toUpperCase() + status.slice(1) })),
    operators: SUBJECT_OPERATORS.study_enrolment,
  },
];

const SCORE_FIELDS: readonly FactFieldDescriptor[] = [
  { field: "rawScore", label: "Raw score", type: "score_number", operators: SUBJECT_OPERATORS.scale_score },
  { field: "transformedScore", label: "Transformed score", type: "score_number", operators: SUBJECT_OPERATORS.scale_score },
  { field: "standardizedScore", label: "Standardized score", type: "score_number", operators: SUBJECT_OPERATORS.scale_score },
  { field: "percentile", label: "Percentile", type: "score_number", min: 0, max: 100, operators: SUBJECT_OPERATORS.scale_score },
];

const ASSESSMENT_FIELDS: readonly FactFieldDescriptor[] = [
  {
    field: null,
    label: "Matching assessment sessions",
    type: "integer",
    min: 0,
    derived: true,
    operators: ["has_any_assessment", "is_missing", "is_present"],
  },
  {
    field: null,
    label: "Computable scores in matching sessions",
    type: "integer",
    min: 0,
    derived: true,
    operators: ["has_scale_score"],
    note: "Counts only scores with computability 'computed'.",
  },
  {
    field: null,
    label: "Item missingness across matching sessions",
    type: "ratio",
    min: 0,
    max: 1,
    derived: true,
    operators: ["missingness_at_most"],
    note: "Sum of missing items over sum of expected items; 0..1, or 0..100 when the threshold exceeds 1.",
  },
];

const DATA_QUALITY_FIELDS: readonly FactFieldDescriptor[] = [
  {
    field: null,
    label: "Overall attribute completeness",
    type: "ratio",
    min: 0,
    max: 1,
    derived: true,
    operators: ["missingness_at_most"],
    note: "Share of catalogued participant attributes without a usable value; omit `field` to use every catalogued attribute.",
  },
  ...ATTRIBUTE_FIELDS.map((descriptor) => ({ ...descriptor, operators: ["is_missing", "is_present"] as readonly CohortRuleOperator[] })),
];

/**
 * Field metadata for the cohort filter builder: which subjects exist, which
 * fields they expose, and which operators each field supports.
 */
export const FACT_FIELD_CATALOG: FactFieldCatalog = {
  participant_attribute: {
    subject: "participant_attribute",
    label: "Participant attribute",
    description: "Stored, cohort-safe participant attributes such as age at enrolment or region.",
    fieldRole: "fact_field",
    scopeKeys: [],
    fields: ATTRIBUTE_FIELDS,
  },
  consent: {
    subject: "consent",
    label: "Consent",
    description:
      "Consent record status. `field` optionally names the study id whose consent is inspected; without it every consent record is considered.",
    fieldRole: "study_scope",
    scopeKeys: ["withinDays"],
    fields: CONSENT_FIELDS,
  },
  study_enrolment: {
    subject: "study_enrolment",
    label: "Study enrolment",
    description:
      "Enrolment status. `field` optionally names the study id whose enrolment is inspected; without it every enrolment is considered.",
    fieldRole: "study_scope",
    scopeKeys: ["withinDays"],
    fields: ENROLMENT_FIELDS,
  },
  scale_score: {
    subject: "scale_score",
    label: "Scale score",
    description: "A derived score for one scale. `scaleCode` is required; `field` selects which score column is compared.",
    fieldRole: "fact_field",
    scopeKeys: ["scaleCode", "instrumentVersionId", "timepointLabel", "withinDays"],
    fields: SCORE_FIELDS,
  },
  assessment: {
    subject: "assessment",
    label: "Assessment data quality",
    description: "Presence and item-level completeness of assessment sessions. The operator selects the fact; `field` is ignored.",
    fieldRole: "none",
    scopeKeys: ["instrumentVersionId", "scaleCode", "timepointLabel", "withinDays"],
    fields: ASSESSMENT_FIELDS,
  },
  data_quality: {
    subject: "data_quality",
    label: "Attribute completeness",
    description: "How much of the participant record is actually recorded. `field` may name one attribute or be omitted for the whole set.",
    fieldRole: "fact_field",
    scopeKeys: [],
    fields: DATA_QUALITY_FIELDS,
  },
};

export function factSubjectDescriptor(subject: CohortRuleSubject): FactSubjectDescriptor {
  return FACT_FIELD_CATALOG[subject];
}

export function factFieldDescriptor(subject: CohortRuleSubject, field: string | undefined): FactFieldDescriptor | null {
  const descriptor = FACT_FIELD_CATALOG[subject];
  if (field === undefined) return descriptor.fields.find((entry) => entry.field === null) ?? null;
  return descriptor.fields.find((entry) => entry.field === field) ?? null;
}

// ----------------------------------------------------------- presentation ----

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function num(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1e6) / 1e6);
}

function pct(ratio: number): string {
  return `${num(Math.round(ratio * 1000) / 10)}%`;
}

function fmt(value: unknown): string {
  if (value === undefined || value === null) return "(not set)";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? num(value) : String(value);
  if (Array.isArray(value)) return `[${value.map((item) => fmt(item)).join(", ")}]`;
  return String(value);
}

function fieldLabel(field: string): string {
  for (const subject of FACT_SUBJECTS) {
    for (const descriptor of FACT_FIELD_CATALOG[subject].fields) {
      if (descriptor.field === field) return descriptor.label;
    }
  }
  const spaced = field.replace(/[_-]+/g, " ").trim();
  return spaced === "" ? "Attribute" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function metricName(field: string | undefined): string {
  switch (field) {
    case "transformedScore":
      return "transformed score";
    case "standardizedScore":
      return "standardized score";
    case "percentile":
      return "percentile";
    case "rawScore":
    case undefined:
      return "raw score";
    default:
      return `metric ${JSON.stringify(field)}`;
  }
}

function metricOf(rule: CohortRule): ScoreMetric {
  const field = rule.field?.trim();
  return (SCORE_METRICS as readonly string[]).includes(field ?? "") ? (field as ScoreMetric) : DEFAULT_SCORE_METRIC;
}

function minCount(rule: CohortRule): number {
  const value = toNumber(rule.value);
  return value !== null && Number.isInteger(value) && value >= 1 ? value : 1;
}

/** Threshold as a ratio; values above 1 are read as percentages. */
function ratioThreshold(rule: CohortRule): number | null {
  const value = toNumber(rule.value);
  if (value === null) return null;
  return value > 1 ? value / 100 : value;
}

function thresholdText(rule: CohortRule): string {
  const value = toNumber(rule.value);
  if (value === null) return "(invalid threshold)";
  return value > 1 ? `${num(value)}%` : pct(value);
}

export function describeRule(rule: CohortRule): string {
  const label = rule.label?.trim();
  if (label !== undefined && label !== "") return label;
  if (rule.operator === "missingness_at_most") {
    return rule.subject === "assessment"
      ? `Item missingness is at most ${thresholdText(rule)}`
      : `Attribute missingness is at most ${thresholdText(rule)}`;
  }
  if (rule.subject === "assessment" && rule.operator === "has_any_assessment") {
    return `Has at least ${minCount(rule)} matching assessment session(s)`;
  }
  if (rule.subject === "assessment" && rule.operator === "has_scale_score") {
    return `Has at least ${minCount(rule)} computable score(s)${rule.scaleCode ? ` for ${rule.scaleCode}` : ""}`;
  }
  return `${subjectNoun(rule)} ${operatorPhrase(rule)}`.trim();
}

function subjectNoun(rule: CohortRule): string {
  switch (rule.subject) {
    case "participant_attribute": {
      const field = rule.field?.trim() ?? "";
      return field === "" ? "Participant attribute" : fieldLabel(field);
    }
    case "scale_score":
      return rule.scaleCode ? `${rule.scaleCode} ${metricName(rule.field)}` : `Scale score (${metricName(rule.field)})`;
    case "consent":
      return "Consent";
    case "study_enrolment":
      return "Study enrolment";
    case "assessment":
      return "Assessment record";
    default:
      return "Participant record";
  }
}

function operatorPhrase(rule: CohortRule): string {
  switch (rule.operator) {
    case "equals":
      return `is ${fmt(rule.value)}`;
    case "not_equals":
      return `is not ${fmt(rule.value)}`;
    case "in":
      return `is one of ${fmt(rule.value)}`;
    case "not_in":
      return `is none of ${fmt(rule.value)}`;
    case "gte":
      return `is at least ${fmt(rule.value)}`;
    case "lte":
      return `is at most ${fmt(rule.value)}`;
    case "between":
      return `is between ${fmt(rule.value)} and ${fmt(rule.valueMax)}`;
    case "is_missing":
      return "is missing";
    case "is_present":
      return "is present";
    case "consent_status":
    case "study_status":
      return `status is ${fmt(rule.value)}`;
    default:
      return "meets the condition";
  }
}

function expectedText(rule: CohortRule): string {
  switch (rule.operator) {
    case "equals":
      return `= ${fmt(rule.value)}`;
    case "not_equals":
      return `not equal to ${fmt(rule.value)}`;
    case "in":
      return `one of ${fmt(rule.value)}`;
    case "not_in":
      return `none of ${fmt(rule.value)}`;
    case "gte":
      return `>= ${fmt(rule.value)}`;
    case "lte":
      return `<= ${fmt(rule.value)}`;
    case "between":
      return `between ${fmt(rule.value)} and ${fmt(rule.valueMax)} inclusive`;
    case "is_missing":
      return "missing";
    case "is_present":
      return "present";
    case "consent_status":
      return `consent status ${fmt(rule.value)}`;
    case "study_status":
      return `enrolment status ${fmt(rule.value)}`;
    case "has_any_assessment":
      return `at least ${minCount(rule)} assessment session(s)`;
    case "has_scale_score":
      return `at least ${minCount(rule)} computable score(s)`;
    case "missingness_at_most":
      return `at most ${thresholdText(rule)} missing`;
    default:
      return "a supported condition";
  }
}

// ------------------------------------------------------ comparison helpers ----

/** Recorded text that stands for "no value"; it never satisfies a criterion. */
const MISSING_MARKERS = new Set([
  "na",
  "n/a",
  "nan",
  "null",
  "nil",
  "-",
  "--",
  "—",
  "–",
  "unknown",
  "неизвестно",
  "нет данных",
  "нет ответа",
  "пропуск",
  "пропущено",
  "не указано",
]);

/** Text that consists only of digits and numeric separators, so it compares as a number. */
const NUMERIC_TEXT = /^[+-]?[\d\s.,']+$/;

interface Resolved {
  /** A recorded value exists. */
  present: boolean;
  /** A recorded value exists and is usable for a comparison. */
  usable: boolean;
  value: string | number | boolean | null;
  /** Why no usable value exists, in plain English. */
  problem: string | null;
}

function absentValue(problem: string): Resolved {
  return { present: false, usable: false, value: null, problem };
}

function presentValue(value: string | number | boolean): Resolved {
  return { present: true, usable: true, value, problem: null };
}

function resolveAttribute(attributes: Record<string, string | number | boolean | null>, field: string): Resolved {
  const raw = attributes[field];
  if (raw === undefined || raw === null) return absentValue(`no value recorded for attribute ${JSON.stringify(field)}`);
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return absentValue(`attribute ${JSON.stringify(field)} is recorded as an empty string`);
    if (MISSING_MARKERS.has(text.toLowerCase())) {
      return absentValue(`attribute ${JSON.stringify(field)} is recorded as ${JSON.stringify(text)}, which marks a missing value`);
    }
    return presentValue(text);
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return absentValue(`attribute ${JSON.stringify(field)} is recorded as ${String(raw)}`);
    return presentValue(raw);
  }
  return presentValue(raw);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "" || MISSING_MARKERS.has(text.toLowerCase())) return null;
    try {
      return finiteNumber(text, "value");
    } catch {
      return null;
    }
  }
  return null;
}

function looseEquals(observed: unknown, expected: unknown): boolean {
  if (expected === undefined || expected === null) return false;
  if (typeof expected === "boolean") {
    if (typeof observed === "boolean") return observed === expected;
    const parsed = String(observed).trim().toLowerCase();
    return parsed === (expected ? "true" : "false") || parsed === (expected ? "1" : "0");
  }
  if (typeof expected === "number") {
    const numeric = toNumber(observed);
    return numeric !== null && numeric === expected;
  }
  const left = String(observed).trim();
  const right = String(expected).trim();
  if (left === "" || right === "") return false;
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (leftNumber !== null && rightNumber !== null && NUMERIC_TEXT.test(left) && NUMERIC_TEXT.test(right)) {
    return leftNumber === rightNumber;
  }
  return left.toLowerCase() === right.toLowerCase();
}

function timestampOf(value: unknown): number | null {
  const iso = isoDateTime(value);
  return iso === null ? null : Date.parse(iso);
}

function compareDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function pickBest<T>(items: readonly T[], better: (candidate: T, current: T) => boolean): T {
  let best = items[0] as T;
  for (let index = 1; index < items.length; index += 1) {
    const candidate = items[index] as T;
    if (better(candidate, best)) best = candidate;
  }
  return best;
}

// ---------------------------------------------------------------- windows ----

export interface CohortEvaluationOptions {
  /**
   * Reference instant for `withinDays` windows, ISO 8601. The engine never reads
   * the clock: without `now`, a windowed rule is indeterminate instead of
   * silently using "today".
   */
  now?: string;
}

interface Window {
  active: boolean;
  from: number;
  to: number;
  error: string | null;
}

const OPEN_WINDOW: Window = { active: false, from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY, error: null };

function resolveWindow(rule: CohortRule, options: CohortEvaluationOptions): Window {
  const days = rule.withinDays;
  if (days === undefined) return OPEN_WINDOW;
  const reference = options.now === undefined ? null : isoDateTime(options.now);
  if (reference === null) {
    return {
      active: true,
      from: 0,
      to: 0,
      error: `the rule is limited to the last ${days} day(s) but no usable reference timestamp (\`now\`) was supplied`,
    };
  }
  const to = Date.parse(reference);
  return { active: true, from: to - days * 86_400_000, to, error: null };
}

function inWindow(timestamp: number | null, window: Window): boolean {
  if (!window.active) return true;
  if (timestamp === null) return false;
  return timestamp >= window.from && timestamp <= window.to;
}

function windowTrace(rule: CohortRule, error: string): CohortRuleTrace {
  return traceOf(
    rule,
    "indeterminate",
    "no reference date",
    expectedText(rule),
    `Observed no reference date; expected ${expectedText(rule)}. The rule cannot be evaluated because ${error}. Missing or unknown data can never satisfy a criterion, so the outcome is indeterminate.`,
    true,
  );
}

// ------------------------------------------------------------------ traces ----

function ruleIdOf(rule: CohortRule): string {
  return typeof rule.id === "string" ? rule.id : String(rule.id ?? "");
}

function traceOf(
  rule: CohortRule,
  outcome: CohortRuleTrace["outcome"],
  observed: string,
  expected: string,
  explanation: string,
  missing: boolean,
): CohortRuleTrace {
  return {
    ruleId: ruleIdOf(rule),
    label: describeRule(rule),
    subject: rule.subject,
    operator: rule.operator,
    outcome,
    observed,
    expected,
    explanation,
    missing,
  };
}

function behaviourOf(rule: CohortRule): MissingBehaviour {
  const behaviour = rule.missingBehaviour;
  return behaviour !== undefined && (MISSING_BEHAVIOURS as readonly string[]).includes(behaviour)
    ? (behaviour as MissingBehaviour)
    : DEFAULT_MISSING_BEHAVIOUR;
}

function absentOutcome(rule: CohortRule, problem: string, factPhrase: string): CohortRuleTrace {
  const expected = expectedText(rule);
  const prefix = `Observed ${factPhrase} = ${problem}; expected ${expected}.`;
  switch (behaviourOf(rule)) {
    case "ignore":
      return traceOf(
        rule,
        "not_applicable",
        problem,
        expected,
        `${prefix} The rule was skipped because missingBehaviour is "ignore", so it neither includes nor excludes this participant.`,
        true,
      );
    case "exclude":
      return traceOf(
        rule,
        "exclude",
        problem,
        expected,
        `${prefix} missingBehaviour is "exclude", so the absent value fails the criterion and the rule excludes the participant.`,
        true,
      );
    default:
      return traceOf(
        rule,
        "indeterminate",
        problem,
        expected,
        `${prefix} Missing or unknown data can never satisfy an eligibility criterion, so the outcome is indeterminate and needs a human decision.`,
        true,
      );
  }
}

function misconfigured(rule: CohortRule, detail: string): CohortRuleTrace {
  return traceOf(
    rule,
    "indeterminate",
    "rule cannot be evaluated",
    expectedText(rule),
    `The rule is misconfigured: ${detail} Until the rule is fixed the participant is never counted as included.`,
    false,
  );
}

function finish(
  rule: CohortRule,
  satisfied: boolean,
  observedText: string,
  factPhrase: string,
  missing = false,
): CohortRuleTrace {
  const expected = expectedText(rule);
  const prohibitive = isProhibitiveOperator(rule.operator);
  if (satisfied) {
    return traceOf(
      rule,
      "include",
      observedText,
      expected,
      prohibitive
        ? `Observed ${factPhrase} = ${observedText}; expected ${expected}. The prohibited condition was not observed, so the criterion is satisfied.`
        : `Observed ${factPhrase} = ${observedText}; expected ${expected}. The criterion is satisfied.`,
      missing,
    );
  }
  return traceOf(
    rule,
    "exclude",
    observedText,
    expected,
    prohibitive
      ? `Observed ${factPhrase} = ${observedText}; expected ${expected}. The prohibited condition was observed, so the rule excludes the participant.`
      : `Observed ${factPhrase} = ${observedText}; expected ${expected}. The criterion is not satisfied, so the rule excludes the participant.`,
    missing,
  );
}

function evaluateScalar(rule: CohortRule, resolved: Resolved, factPhrase: string): CohortRuleTrace {
  const expected = expectedText(rule);
  const operator = rule.operator;

  if (operator === "is_missing" || operator === "is_present") {
    const observedText = resolved.present ? fmt(resolved.value) : (resolved.problem ?? "no value recorded");
    if (operator === "is_missing") {
      return resolved.present
        ? finish(rule, false, observedText, factPhrase)
        : finish(rule, true, observedText, factPhrase, true);
    }
    if (resolved.present) return finish(rule, true, observedText, factPhrase);
    return absentOutcome(rule, resolved.problem ?? `${factPhrase} has no recorded value`, factPhrase);
  }

  if (!resolved.usable || resolved.value === null) {
    return absentOutcome(rule, resolved.problem ?? `${factPhrase} has no usable value`, factPhrase);
  }

  const observed = resolved.value;
  const observedText = fmt(observed);

  switch (operator) {
    case "equals":
      return finish(rule, looseEquals(observed, rule.value), observedText, factPhrase);
    case "not_equals":
      return finish(rule, !looseEquals(observed, rule.value), observedText, factPhrase);
    case "in":
    case "not_in": {
      const list = Array.isArray(rule.value) ? rule.value : [];
      const hit = list.some((item) => looseEquals(observed, item));
      return finish(rule, operator === "in" ? hit : !hit, observedText, factPhrase);
    }
    case "consent_status":
    case "study_status":
      return finish(rule, looseEquals(observed, rule.value), observedText, factPhrase);
    case "gte":
    case "lte":
    case "between": {
      const numeric = toNumber(observed);
      const low = toNumber(rule.value);
      const high = toNumber(rule.valueMax);
      if (numeric === null) {
        return absentOutcome(rule, `${observedText} is not a usable number`, factPhrase);
      }
      if (low === null) return misconfigured(rule, `\`value\` must be numeric for ${operator}.`);
      if (operator === "between" && high === null) return misconfigured(rule, "`between` requires a numeric `valueMax`.");
      const satisfied =
        operator === "gte" ? numeric >= low : operator === "lte" ? numeric <= low : numeric >= low && numeric <= (high as number);
      return finish(rule, satisfied, observedText, factPhrase);
    }
    default:
      return misconfigured(rule, `operator ${operator} cannot be evaluated for this subject. ${expected}`);
  }
}

// -------------------------------------------------------------- fact scope ----

function scopeSuffix(rule: CohortRule): string {
  const bits: string[] = [];
  if (rule.instrumentVersionId !== undefined) bits.push(rule.instrumentVersionId);
  if (rule.scaleCode !== undefined) bits.push(rule.scaleCode);
  if (rule.timepointLabel !== undefined) bits.push(rule.timepointLabel);
  if (rule.withinDays !== undefined) bits.push(`last ${rule.withinDays} day(s)`);
  return bits.length === 0 ? "" : ` matching ${bits.join(", ")}`;
}

function scopedKey(base: string, rule: CohortRule): string {
  const bits: string[] = [];
  if (rule.instrumentVersionId !== undefined) bits.push(rule.instrumentVersionId);
  if (rule.scaleCode !== undefined) bits.push(rule.scaleCode);
  if (rule.timepointLabel !== undefined) bits.push(rule.timepointLabel);
  if (rule.withinDays !== undefined) bits.push(`last${rule.withinDays}d`);
  return bits.length === 0 ? base : `${base}[${bits.join("|")}]`;
}

function assessmentTimestamp(assessment: ParticipantFactAssessment): number | null {
  return timestampOf(assessment.completedAt) ?? timestampOf(assessment.recordedAt);
}

function latestConsentTimestamp(record: ParticipantFactConsent): string | null {
  const candidates = [record.grantedAt, record.withdrawnAt, record.expiresAt];
  let best: string | null = null;
  let bestMs: number | null = null;
  for (const candidate of candidates) {
    const ms = timestampOf(candidate);
    if (ms === null) continue;
    if (bestMs === null || ms > bestMs) {
      bestMs = ms;
      best = candidate;
    }
  }
  return best;
}

const CONSENT_STATUS_RANK: Record<string, number> = { withdrawn: 4, expired: 3, declined: 2, none: 1, granted: 0 };
const ENROLMENT_STATUS_RANK: Record<string, number> = { excluded: 5, withdrawn: 4, invited: 3, enrolled: 2, active: 1, completed: 0 };

function evaluateAttributeSubject(rule: CohortRule, fact: ParticipantFact): RuleEvaluation {
  const field = rule.field?.trim() ?? "";
  const resolved = resolveAttribute(fact.attributes, field);
  const phrase = field === "" ? "Participant attribute" : fieldLabel(field);
  return { trace: evaluateScalar(rule, resolved, phrase), probe: { key: field, present: resolved.usable } };
}

function evaluateConsentSubject(rule: CohortRule, fact: ParticipantFact, window: Window, factPhrase: string): RuleEvaluation {
  const study = rule.field?.trim();
  const key = study === undefined || study === "" ? "consent.status" : `consent.status[${study}]`;
  if (window.error !== null) return { trace: windowTrace(rule, window.error), probe: null };

  const candidates = fact.consents.filter(
    (record) =>
      (study === undefined || study === "" || record.studyId === study) &&
      inWindow(timestampOf(latestConsentTimestamp(record)), window),
  );
  if (candidates.length === 0) {
    const scope = study === undefined || study === "" ? "" : ` for study ${study}`;
    const problem = `no consent record${scope}${window.active ? ` active within the last ${rule.withinDays} day(s)` : ""}`;
    return { trace: evaluateScalar(rule, absentValue(problem), factPhrase), probe: { key, present: false } };
  }
  const record = pickBest(candidates, (candidate, current) => {
    const byTime = compareDesc(timestampOf(latestConsentTimestamp(candidate)), timestampOf(latestConsentTimestamp(current)));
    if (byTime !== 0) return byTime < 0;
    const byRank = (CONSENT_STATUS_RANK[candidate.status] ?? 0) - (CONSENT_STATUS_RANK[current.status] ?? 0);
    if (byRank !== 0) return byRank > 0;
    return compareText(String(candidate.version ?? ""), String(current.version ?? "")) > 0;
  });
  return { trace: evaluateScalar(rule, presentValue(record.status), factPhrase), probe: { key, present: true } };
}

function evaluateEnrolmentSubject(rule: CohortRule, fact: ParticipantFact, window: Window, factPhrase: string): RuleEvaluation {
  const study = rule.field?.trim();
  const key = study === undefined || study === "" ? "study_enrolment.status" : `study_enrolment.status[${study}]`;
  if (window.error !== null) return { trace: windowTrace(rule, window.error), probe: null };

  const candidates = fact.enrolments.filter(
    (record) =>
      (study === undefined || study === "" || record.studyId === study) &&
      inWindow(timestampOf(record.enrolledAt), window),
  );
  if (candidates.length === 0) {
    const scope = study === undefined || study === "" ? "" : ` for study ${study}`;
    const problem = `no enrolment record${scope}${window.active ? ` within the last ${rule.withinDays} day(s)` : ""}`;
    return { trace: evaluateScalar(rule, absentValue(problem), factPhrase), probe: { key, present: false } };
  }
  const record = pickBest(candidates, (candidate, current) => {
    const byTime = compareDesc(timestampOf(candidate.enrolledAt), timestampOf(current.enrolledAt));
    if (byTime !== 0) return byTime < 0;
    const byRank = (ENROLMENT_STATUS_RANK[candidate.status] ?? 0) - (ENROLMENT_STATUS_RANK[current.status] ?? 0);
    if (byRank !== 0) return byRank > 0;
    return compareDesc(timestampOf(candidate.withdrawnAt), timestampOf(current.withdrawnAt)) < 0;
  });
  return { trace: evaluateScalar(rule, presentValue(record.status), factPhrase), probe: { key, present: true } };
}

function evaluateScoreSubject(rule: CohortRule, fact: ParticipantFact, window: Window): RuleEvaluation {
  const scaleCode = rule.scaleCode?.trim() ?? "";
  const metric = metricOf(rule);
  const phrase = `${scaleCode || "scale"} ${metricName(metric)}`;
  const key = `${scaleCode}.${metric}${rule.timepointLabel !== undefined ? `[${rule.timepointLabel}]` : ""}`;
  if (window.error !== null) return { trace: windowTrace(rule, window.error), probe: null };

  const sessions = new Map(fact.assessments.map((assessment) => [assessment.sessionId, assessment]));
  const candidates = fact.scores.filter((score) => {
    if (score.scaleCode !== scaleCode) return false;
    if (rule.instrumentVersionId !== undefined && score.instrumentVersionId !== rule.instrumentVersionId) return false;
    if (rule.timepointLabel !== undefined) {
      const session = sessions.get(score.assessmentSessionId);
      if (session === undefined || session.timepointLabel !== rule.timepointLabel) return false;
    }
    if (window.active) {
      const session = sessions.get(score.assessmentSessionId);
      if (session === undefined || !inWindow(assessmentTimestamp(session), window)) return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    const problem = scaleCode === "" ? "no score recorded" : `no score recorded for scale ${JSON.stringify(scaleCode)}${scopeSuffix(rule)}`;
    return { trace: evaluateScalar(rule, absentValue(problem), phrase), probe: { key, present: false } };
  }

  if (rule.operator === "has_scale_score") {
    const computed = candidates.filter((score) => score.computability === "computed");
    return {
      trace: finish(
        rule,
        computed.length >= minCount(rule),
        `${computed.length} computable score(s)`,
        `computable ${phrase} scores`,
      ),
      probe: { key, present: computed.length > 0 },
    };
  }

  const score = pickBest(candidates, (candidate, current) => {
    const byTime = compareDesc(timestampOf(candidate.computedAt), timestampOf(current.computedAt));
    if (byTime !== 0) return byTime < 0;
    return compareText(candidate.assessmentSessionId, current.assessmentSessionId) < 0;
  });

  if (score.computability !== "computed") {
    return {
      trace: evaluateScalar(
        rule,
        absentValue(`the score from session ${score.assessmentSessionId} is not computable (algorithm ${score.algorithmVersion})`),
        phrase,
      ),
      probe: { key, present: false },
    };
  }
  const value = score[metric];
  if (value === null || !Number.isFinite(value)) {
    return {
      trace: evaluateScalar(rule, absentValue(`the score from session ${score.assessmentSessionId} has no ${metricName(metric)} recorded`), phrase),
      probe: { key, present: false },
    };
  }
  return { trace: evaluateScalar(rule, presentValue(value), phrase), probe: { key, present: true } };
}

function matchesAssessmentScope(rule: CohortRule, assessment: ParticipantFactAssessment, window: Window): boolean {
  if (rule.instrumentVersionId !== undefined && assessment.instrumentVersionId !== rule.instrumentVersionId) return false;
  if (rule.timepointLabel !== undefined && assessment.timepointLabel !== rule.timepointLabel) return false;
  return inWindow(assessmentTimestamp(assessment), window);
}

function evaluateAssessmentSubject(rule: CohortRule, fact: ParticipantFact, window: Window): RuleEvaluation {
  const phrase = "matching assessment sessions";
  if (window.error !== null) return { trace: windowTrace(rule, window.error), probe: null };

  const selected = fact.assessments.filter((assessment) => matchesAssessmentScope(rule, assessment, window));
  const countKey = scopedKey("assessment.sessions", rule);

  switch (rule.operator) {
    case "has_any_assessment": {
      const minimum = minCount(rule);
      return {
        trace: finish(rule, selected.length >= minimum, `${selected.length} session(s)`, phrase),
        probe: { key: countKey, present: selected.length > 0 },
      };
    }
    case "has_scale_score": {
      const sessionIds = new Set(selected.map((assessment) => assessment.sessionId));
      const computable = fact.scores.filter(
        (score) =>
          sessionIds.has(score.assessmentSessionId) &&
          score.computability === "computed" &&
          (rule.scaleCode === undefined || score.scaleCode === rule.scaleCode) &&
          (rule.instrumentVersionId === undefined || score.instrumentVersionId === rule.instrumentVersionId),
      );
      return {
        trace: finish(rule, computable.length >= minCount(rule), `${computable.length} computable score(s)`, "computable scores"),
        probe: { key: scopedKey("assessment.scaleScores", rule), present: computable.length > 0 },
      };
    }
    case "missingness_at_most": {
      const threshold = ratioThreshold(rule);
      if (threshold === null) return { trace: misconfigured(rule, "`missingness_at_most` requires a numeric `value`."), probe: null };
      if (selected.length === 0) {
        return {
          trace: absentOutcome(rule, `no assessment session${scopeSuffix(rule)}`, "item missingness"),
          probe: { key: scopedKey("assessment.missingness", rule), present: false },
        };
      }
      let totalItems = 0;
      let missingItems = 0;
      for (const assessment of selected) {
        totalItems += Math.max(0, assessment.totalItems);
        missingItems += Math.max(0, assessment.missingItems);
      }
      if (totalItems === 0) {
        return {
          trace: absentOutcome(rule, "the matching sessions record no expected items", "item missingness"),
          probe: { key: scopedKey("assessment.missingness", rule), present: false },
        };
      }
      const ratio = missingItems / totalItems;
      return {
        trace: finish(
          rule,
          ratio <= threshold + 1e-9,
          `${pct(ratio)} (${missingItems} of ${totalItems} items missing across ${selected.length} session(s))`,
          "item missingness",
        ),
        probe: { key: scopedKey("assessment.missingness", rule), present: true },
      };
    }
    default: {
      const observed = `${selected.length} session(s)`;
      if (rule.operator === "is_missing" || selected.length > 0) {
        const satisfied = rule.operator === "is_missing" ? selected.length === 0 : true;
        return {
          trace: finish(rule, satisfied, observed, phrase, selected.length === 0),
          probe: { key: countKey, present: selected.length > 0 },
        };
      }
      return {
        trace: absentOutcome(rule, `no assessment session${scopeSuffix(rule)}`, phrase),
        probe: { key: countKey, present: false },
      };
    }
  }
}

function attributesUnderReview(rule: CohortRule): readonly string[] {
  const field = rule.field?.trim();
  if (field === undefined || field === "" || field === "*") return PARTICIPANT_ATTRIBUTE_FIELDS;
  return [field];
}

function evaluateDataQualitySubject(rule: CohortRule, fact: ParticipantFact): RuleEvaluation {
  const phrase = "participant attribute completeness";
  if (rule.operator === "missingness_at_most") {
    const threshold = ratioThreshold(rule);
    if (threshold === null) return { trace: misconfigured(rule, "`missingness_at_most` requires a numeric `value`."), probe: null };
    const fields = attributesUnderReview(rule);
    if (fields.length === 0) return { trace: misconfigured(rule, "no participant attributes are available to inspect."), probe: null };
    const missing = fields.filter((field) => !resolveAttribute(fact.attributes, field).usable);
    const ratio = missing.length / fields.length;
    const listed = missing.slice(0, 3).join(", ");
    return {
      trace: finish(
        rule,
        ratio <= threshold + 1e-9,
        `${pct(ratio)} (${missing.length} of ${fields.length} attributes missing${missing.length === 0 ? "" : `: ${listed}${missing.length > 3 ? ", ..." : ""}`})`,
        phrase,
      ),
      probe: { key: scopedKey("data_quality.missingness", rule), present: missing.length < fields.length },
    };
  }
  const field = rule.field?.trim() ?? "";
  const resolved = resolveAttribute(fact.attributes, field);
  return { trace: evaluateScalar(rule, resolved, fieldLabel(field)), probe: { key: field, present: resolved.usable } };
}

// ------------------------------------------------------------- evaluation ----

interface FactProbe {
  key: string;
  present: boolean;
}

interface RuleEvaluation {
  trace: CohortRuleTrace;
  /** Null when the rule cannot describe data presence at all (misconfigured/window). */
  probe: FactProbe | null;
}

function failingIssues(rule: CohortRule): RuleIssue[] {
  return validateRule(rule).filter((issue) => issue.severity === "fail");
}

function evaluateChecked(rule: CohortRule, fact: ParticipantFact, options: CohortEvaluationOptions, failures: RuleIssue[]): RuleEvaluation {
  if (failures.length > 0) {
    return { trace: misconfigured(rule, failures.map((issue) => issue.message).join(" ")), probe: null };
  }
  const window = resolveWindow(rule, options);
  switch (rule.subject) {
    case "participant_attribute":
      return evaluateAttributeSubject(rule, fact);
    case "consent":
      return evaluateConsentSubject(rule, fact, window, "consent status");
    case "study_enrolment":
      return evaluateEnrolmentSubject(rule, fact, window, "enrolment status");
    case "scale_score":
      return evaluateScoreSubject(rule, fact, window);
    case "assessment":
      return evaluateAssessmentSubject(rule, fact, window);
    case "data_quality":
      return evaluateDataQualitySubject(rule, fact);
    default:
      return { trace: misconfigured(rule, `unknown subject ${JSON.stringify(rule.subject)}.`), probe: null };
  }
}

export function evaluateRule(rule: CohortRule, fact: ParticipantFact, options: CohortEvaluationOptions = {}): CohortRuleTrace {
  return evaluateChecked(rule, fact, options, failingIssues(rule)).trace;
}

export function evaluateCohort(
  rules: CohortRule[],
  facts: ParticipantFact[],
  options: CohortEvaluationOptions = {},
): CohortPreview {
  const warnings: RuleIssue[] = [];
  if (facts.length === 0) {
    warnings.push({
      code: "cohort.denominator_empty",
      severity: "info",
      message: "No participants were supplied, so every count is zero.",
    });
  }
  if (rules.length === 0) {
    warnings.push({
      code: "cohort.no_rules",
      severity: "warn",
      message: "The cohort defines no rules, so every participant in the denominator is counted as included.",
    });
  }

  const seenRuleIds = new Set<string>();
  const duplicateRuleIds: string[] = [];
  const ignoreRuleIds: string[] = [];
  for (const rule of rules) {
    for (const issue of validateRule(rule)) {
      warnings.push({ ...issue, detail: { ruleId: ruleIdOf(rule), ...(issue.detail ?? {}) } });
    }
    const id = ruleIdOf(rule);
    if (seenRuleIds.has(id)) {
      if (!duplicateRuleIds.includes(id)) duplicateRuleIds.push(id);
    }
    seenRuleIds.add(id);
    if (behaviourOf(rule) === "ignore" && !ignoreRuleIds.includes(id)) ignoreRuleIds.push(id);
  }
  for (const id of duplicateRuleIds) {
    warnings.push({
      code: "cohort.duplicate_rule_id",
      severity: "warn",
      message: `Rule id ${JSON.stringify(id)} appears more than once; outcomes are aggregated per rule id.`,
      detail: { ruleId: id },
    });
  }
  if (ignoreRuleIds.length > 0) {
    warnings.push({
      code: "cohort.ignore_rules_present",
      severity: "warn",
      message: `Rules ${ignoreRuleIds.map((id) => JSON.stringify(id)).join(", ")} use missingBehaviour "ignore", so participants whose data is absent for those rules can still be included. Review the methodology before using this cohort.`,
      detail: { ruleIds: ignoreRuleIds },
    });
  }

  const failuresByRule = new Map<CohortRule, RuleIssue[]>();
  for (const rule of rules) if (!failuresByRule.has(rule)) failuresByRule.set(rule, failingIssues(rule));

  const countsByRuleId = new Map<
    string,
    { ruleId: string; label: string; include: number; exclude: number; indeterminate: number; notApplicable: number }
  >();
  const presenceByKey = new Map<string, Map<string, boolean>>();
  const evaluations: CohortEvaluation[] = [];
  let included = 0;
  let excluded = 0;
  let indeterminate = 0;

  for (const fact of facts) {
    const traces: CohortRuleTrace[] = [];
    const indeterminateReasons: string[] = [];
    let includeFailures = 0;
    let excludeHits = 0;

    for (const rule of rules) {
      const { trace, probe } = evaluateChecked(rule, fact, options, failuresByRule.get(rule) ?? []);
      traces.push(trace);

      if (trace.outcome === "exclude") {
        if (isProhibitiveOperator(rule.operator)) excludeHits += 1;
        else includeFailures += 1;
      }
      if (trace.outcome === "indeterminate") {
        indeterminateReasons.push(`${trace.label}: ${trace.observed} (expected ${trace.expected})`);
      }

      const id = ruleIdOf(rule);
      let counts = countsByRuleId.get(id);
      if (counts === undefined) {
        counts = { ruleId: id, label: trace.label, include: 0, exclude: 0, indeterminate: 0, notApplicable: 0 };
        countsByRuleId.set(id, counts);
      }
      if (trace.outcome === "not_applicable") counts.notApplicable += 1;
      else counts[trace.outcome] += 1;

      if (probe !== null) {
        const perParticipant = presenceByKey.get(probe.key) ?? new Map<string, boolean>();
        perParticipant.set(fact.participantId, (perParticipant.get(fact.participantId) ?? false) || probe.present);
        presenceByKey.set(probe.key, perParticipant);
      }
    }

    const decision: CohortEvaluation["decision"] =
      includeFailures + excludeHits > 0 ? "excluded" : indeterminateReasons.length > 0 ? "indeterminate" : "included";
    if (decision === "included") included += 1;
    else if (decision === "excluded") excluded += 1;
    else indeterminate += 1;

    evaluations.push({
      participantId: fact.participantId,
      pseudonym: fact.pseudonym,
      decision,
      traces,
      includeFailures,
      excludeHits,
      indeterminateReasons,
    });
  }

  const missingnessSummary = Array.from(presenceByKey.entries())
    .map(([field, perParticipant]) => {
      let presentCount = 0;
      for (const present of perParticipant.values()) if (present) presentCount += 1;
      return { field, missingCount: perParticipant.size - presentCount, presentCount };
    })
    .sort((a, b) => b.missingCount - a.missingCount || compareText(a.field, b.field));

  return {
    denominator: facts.length,
    included,
    excluded,
    indeterminate,
    evaluations,
    ruleSummary: Array.from(countsByRuleId.values()),
    missingnessSummary,
    warnings,
  };
}

// -------------------------------------------------------------- validation ----

function toIssue(severity: RuleIssue["severity"], code: string, message: string, detail?: Record<string, unknown>): RuleIssue {
  return detail === undefined ? { code, severity, message } : { code, severity, message, detail };
}

export function validateRule(rule: CohortRule): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const fail = (code: string, message: string, detail?: Record<string, unknown>) =>
    issues.push(toIssue("fail", code, message, detail));
  const warn = (code: string, message: string, detail?: Record<string, unknown>) =>
    issues.push(toIssue("warn", code, message, detail));
  const info = (code: string, message: string, detail?: Record<string, unknown>) =>
    issues.push(toIssue("info", code, message, detail));

  if (typeof rule !== "object" || rule === null) {
    fail("rule.not_object", "A cohort rule must be an object.");
    return issues;
  }
  if (typeof rule.id !== "string" || rule.id.trim() === "") {
    fail("rule.id_required", "Every rule needs a non-empty id.", { field: "id" });
  }

  const descriptor = (FACT_FIELD_CATALOG as Record<string, FactSubjectDescriptor | undefined>)[String(rule.subject)];
  if (descriptor === undefined) {
    fail("rule.subject_unknown", `Unknown rule subject ${JSON.stringify(rule.subject)}.`, { field: "subject" });
    return issues;
  }
  const subject = rule.subject;
  const operator = rule.operator;
  if (!(ALL_OPERATORS as readonly string[]).includes(operator)) {
    fail("rule.operator_unknown", `Unknown rule operator ${JSON.stringify(operator)}.`, { field: "operator" });
    return issues;
  }
  const allowed = SUBJECT_OPERATORS[subject];
  if (!allowed.includes(operator)) {
    fail("rule.operator_unsupported", `${operator} is not available for subject ${subject}; allowed: ${allowed.join(", ")}.`, {
      field: "operator",
    });
  }

  const field = typeof rule.field === "string" ? rule.field.trim() : "";
  const isMissingOperator = operator === "is_missing" || operator === "is_present";

  if (subject === "participant_attribute" && field === "") {
    fail("rule.field_required", "participant_attribute rules must name the attribute in `field`.", { field: "field" });
  }
  if (subject === "data_quality" && isMissingOperator && field === "") {
    fail("rule.field_required", `\`${operator}\` on data_quality must name the attribute in \`field\`.`, { field: "field" });
  }
  if ((subject === "participant_attribute" || subject === "data_quality") && field !== "" && field !== "*") {
    if (!PARTICIPANT_ATTRIBUTE_FIELDS.includes(field)) {
      warn(
        "rule.field_unknown",
        `${JSON.stringify(field)} is not a catalogued participant attribute; the rule only works for participants whose record actually carries that key.`,
        { field: "field" },
      );
    }
  }
  if (subject === "assessment" && field !== "") {
    info("rule.field_ignored", "Assessment rules select the fact with the operator; `field` is ignored.", { field: "field" });
  }
  if (subject === "scale_score") {
    if (field !== "" && !(SCORE_METRICS as readonly string[]).includes(field)) {
      fail("rule.metric_unknown", `Scale score metrics must be one of: ${SCORE_METRICS.join(", ")}.`, {
        field: "field",
        received: field,
      });
    }
    if (rule.scaleCode === undefined || String(rule.scaleCode).trim() === "") {
      fail("rule.scale_code_required", "Scale score rules must name the scale in `scaleCode`.", { field: "scaleCode" });
    }
  }

  const value = rule.value;
  if (isMissingOperator && value !== undefined) {
    info("rule.value_ignored", `\`${operator}\` does not use \`value\`; it is ignored.`, { field: "value" });
  }
  const needsValue = !isMissingOperator && operator !== "has_any_assessment" && operator !== "has_scale_score";
  if (needsValue && value === undefined) {
    fail("rule.value_required", `\`${operator}\` requires \`value\`.`, { field: "value" });
  }

  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(value)) {
      fail("rule.value_type", `\`${operator}\` requires an array of values in \`value\`.`, { field: "value" });
    } else if (value.length === 0) {
      fail("rule.value_empty", `\`${operator}\` requires at least one value.`, { field: "value" });
    } else {
      for (const item of value) {
        if (typeof item !== "string" && typeof item !== "number") {
          fail("rule.value_type", `\`${operator}\` values must be strings or numbers.`, { field: "value", received: item });
        }
      }
    }
  }

  if (operator === "gte" || operator === "lte" || operator === "between") {
    if (value !== undefined && toNumber(value) === null) {
      fail("rule.value_not_numeric", `\`${operator}\` compares numbers, so \`value\` must be numeric.`, {
        field: "value",
        received: value,
      });
    }
  }
  if (operator === "between") {
    if (rule.valueMax === undefined) {
      fail("rule.between_max_required", "`between` requires `valueMax`.", { field: "valueMax" });
    } else {
      const high = toNumber(rule.valueMax);
      const low = toNumber(value);
      if (high === null) {
        fail("rule.value_not_numeric", "`valueMax` must be a finite number or numeric string.", {
          field: "valueMax",
          received: rule.valueMax,
        });
      } else if (low !== null && low > high) {
        fail("rule.between_bounds", `\`value\` (${num(low)}) must not exceed \`valueMax\` (${num(high)}).`, { field: "valueMax" });
      }
    }
  } else if (rule.valueMax !== undefined) {
    info("rule.value_max_ignored", "`valueMax` is only used by `between`.", { field: "valueMax" });
  }

  if (operator === "has_any_assessment" || operator === "has_scale_score") {
    if (value !== undefined) {
      const minimum = toNumber(value);
      if (minimum === null || !Number.isInteger(minimum) || minimum < 1) {
        fail("rule.value_not_numeric", `\`${operator}\` accepts an optional whole-number minimum count.`, {
          field: "value",
          received: value,
        });
      }
    }
  }

  if (operator === "missingness_at_most") {
    const threshold = toNumber(value);
    if (threshold === null) {
      fail("rule.value_not_numeric", "`missingness_at_most` requires a numeric threshold.", { field: "value", received: value });
    } else if (threshold < 0) {
      fail("rule.threshold_out_of_range", "A missingness threshold cannot be negative.", { field: "value", received: threshold });
    } else if (threshold > 100) {
      fail("rule.threshold_out_of_range", "A missingness threshold above 100% is meaningless.", { field: "value", received: threshold });
    } else if (threshold > 1) {
      info("rule.threshold_percent", `Threshold ${num(threshold)} is read as ${num(threshold)}%; use 0..1 for a proportion.`, {
        field: "value",
      });
    }
  }

  const statuses =
    subject === "consent"
      ? { name: "Consent", values: CONSENT_STATUSES as readonly string[] }
      : subject === "study_enrolment"
        ? { name: "Enrolment", values: STUDY_STATUSES as readonly string[] }
        : null;
  const statusOperators: readonly CohortRuleOperator[] = [
    "consent_status",
    "study_status",
    "equals",
    "not_equals",
    "in",
    "not_in",
  ];
  if (statuses !== null && statusOperators.includes(operator)) {
    const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const item of items) {
      if (typeof item !== "string" || !statuses.values.includes(item)) {
        fail("rule.status_unknown", `${statuses.name} status must be one of: ${statuses.values.join(", ")}.`, {
          field: "value",
          received: item,
        });
      }
    }
  }

  if (rule.withinDays !== undefined) {
    if (!Number.isInteger(rule.withinDays) || rule.withinDays < 1) {
      fail("rule.within_days_invalid", "`withinDays` must be a positive whole number of days.", { field: "withinDays" });
    } else if (subject === "data_quality") {
      warn("rule.within_days_ignored", "data_quality rules describe the participant record as stored and ignore `withinDays`.", {
        field: "withinDays",
      });
    }
  }

  if (rule.missingBehaviour !== undefined && !(MISSING_BEHAVIOURS as readonly string[]).includes(rule.missingBehaviour)) {
    fail("rule.missing_behaviour_unknown", `missingBehaviour must be one of: ${MISSING_BEHAVIOURS.join(", ")}.`, {
      field: "missingBehaviour",
      received: rule.missingBehaviour,
    });
  }

  for (const key of ["instrumentVersionId", "scaleCode", "timepointLabel", "label"] as const) {
    const text = rule[key];
    if (text !== undefined && (typeof text !== "string" || text.trim() === "")) {
      fail("rule.text_field_invalid", `\`${key}\` must be a non-empty string when present.`, { field: key, received: text });
    }
  }
  const scopedSubjects: readonly CohortRuleSubject[] = ["scale_score", "assessment"];
  if (rule.instrumentVersionId !== undefined && !scopedSubjects.includes(subject)) {
    warn("rule.scope_ignored", `\`instrumentVersionId\` is not used by ${subject} rules.`, { field: "instrumentVersionId" });
  }
  if (rule.timepointLabel !== undefined && !scopedSubjects.includes(subject)) {
    warn("rule.scope_ignored", `\`timepointLabel\` is not used by ${subject} rules.`, { field: "timepointLabel" });
  }
  if (rule.scaleCode !== undefined && !scopedSubjects.includes(subject)) {
    warn("rule.scope_ignored", `\`scaleCode\` is not used by ${subject} rules.`, { field: "scaleCode" });
  }

  return issues;
}

// ----------------------------------------------------------------- parsing ----

function invalidRule(field: string, message: string, detail: Record<string, unknown> = {}): DomainError {
  return new DomainError("cohort.rule_invalid", message, { field, ...detail });
}

function ruleString(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalidRule(field, `\`${field}\` is required and must be a non-empty string.`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidRule(field, `\`${field}\` must be text but ${typeof value} was received.`, { received: value });
  }
  const text = value.trim();
  if (text === "") {
    if (required) throw invalidRule(field, `\`${field}\` must not be blank.`);
    return undefined;
  }
  return text;
}

function ruleEnum<T extends string>(value: unknown, values: readonly T[], field: string, required: boolean): T | undefined {
  const text = ruleString(value, field, required);
  if (text === undefined) return undefined;
  if (!(values as readonly string[]).includes(text)) {
    throw invalidRule(field, `\`${field}\` must be one of: ${values.join(", ")}.`, { received: text, allowed: values });
  }
  return text as T;
}

function ruleNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return finiteNumber(value, field);
  } catch (error) {
    if (error instanceof DomainError) {
      throw invalidRule(field, `\`${field}\` must be a finite number: ${error.message}`, { received: value });
    }
    throw error;
  }
}

function ruleInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return integer(value, field);
  } catch (error) {
    if (error instanceof DomainError) {
      throw invalidRule(field, `\`${field}\` must be a whole number: ${error.message}`, { received: value });
    }
    throw error;
  }
}

function parseRuleValue(operator: CohortRuleOperator, value: unknown): string | number | boolean | Array<string | number> {
  if (operator === "is_missing" || operator === "is_present") {
    throw invalidRule("value", `\`${operator}\` does not take a \`value\`.`, { received: value });
  }
  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(value)) {
      throw invalidRule("value", `\`${operator}\` requires an array of values.`, { received: value });
    }
    if (value.length === 0) throw invalidRule("value", `\`${operator}\` requires at least one value.`);
    return value.map((item, index) => {
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (typeof item === "string" && item.trim() !== "") return item.trim();
      throw invalidRule("value", `\`${operator}\` values must be strings or finite numbers.`, { index, received: item });
    });
  }
  if (
    operator === "gte" ||
    operator === "lte" ||
    operator === "between" ||
    operator === "missingness_at_most" ||
    operator === "has_any_assessment" ||
    operator === "has_scale_score"
  ) {
    const numeric = ruleNumber(value, "value");
    if (numeric === undefined) {
      throw invalidRule("value", `\`${operator}\` requires a numeric \`value\`.`, { received: value });
    }
    return numeric;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") throw invalidRule("value", "`value` must not be blank.");
    return text;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidRule("value", "`value` must be a finite number.", { received: String(value) });
    return value;
  }
  if (typeof value === "boolean") return value;
  throw invalidRule("value", "`value` must be text, a number, a boolean or an array of strings/numbers.", {
    received: Array.isArray(value) ? "array" : typeof value,
  });
}

/**
 * Runtime validation of a rule loaded from JSON (database row, HTTP body).
 *
 * Unknown keys are ignored so stored rules survive contract additions; every
 * recognised key is type-checked, numeric text is normalised to numbers, and a
 * rule that cannot be evaluated is rejected with `DomainError`
 * (`cohort.rule_invalid`) rather than silently producing a wrong cohort.
 */
export function parseRule(input: unknown): CohortRule {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRule("rule", "A cohort rule must be a JSON object.", {
      received: input === null ? "null" : Array.isArray(input) ? "array" : typeof input,
    });
  }
  const raw = input as Record<string, unknown>;
  const id = ruleString(raw.id, "id", true) as string;
  const subject = ruleEnum(raw.subject, FACT_SUBJECTS, "subject", true) as CohortRuleSubject;
  const operator = ruleEnum(raw.operator, ALL_OPERATORS, "operator", true) as CohortRuleOperator;

  const rule: CohortRule = { id, subject, operator };
  const field = ruleString(raw.field, "field", false);
  if (field !== undefined) rule.field = field;
  const instrumentVersionId = ruleString(raw.instrumentVersionId, "instrumentVersionId", false);
  if (instrumentVersionId !== undefined) rule.instrumentVersionId = instrumentVersionId;
  const scaleCode = ruleString(raw.scaleCode, "scaleCode", false);
  if (scaleCode !== undefined) rule.scaleCode = scaleCode;
  const timepointLabel = ruleString(raw.timepointLabel, "timepointLabel", false);
  if (timepointLabel !== undefined) rule.timepointLabel = timepointLabel;
  const label = ruleString(raw.label, "label", false);
  if (label !== undefined) rule.label = label;

  const withinDays = ruleInteger(raw.withinDays, "withinDays");
  if (withinDays !== undefined) rule.withinDays = withinDays;
  const valueMax = ruleNumber(raw.valueMax, "valueMax");
  if (valueMax !== undefined) rule.valueMax = valueMax;
  const missingBehaviour = ruleEnum(raw.missingBehaviour, MISSING_BEHAVIOURS, "missingBehaviour", false);
  if (missingBehaviour !== undefined) rule.missingBehaviour = missingBehaviour;

  if (raw.value !== undefined && raw.value !== null) {
    rule.value = parseRuleValue(operator, raw.value);
  }

  const failures = failingIssues(rule);
  if (failures.length > 0) {
    const first = failures[0] as RuleIssue;
    const pointer = typeof first.detail?.field === "string" ? first.detail.field : "rule";
    throw invalidRule(pointer, `The rule cannot be used: ${failures.map((issue) => issue.message).join(" ")}`, {
      issues: failures,
    });
  }
  return rule;
}
