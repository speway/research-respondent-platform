/**
 * Versioned, pure psychometric scoring engine (contract: ./types.ts, frozen).
 *
 * No I/O, no clock, no module state: identical inputs always produce identical
 * output, so a `ComputedScore` can be audited and re-derived later.
 *
 * Methodological rules enforced here:
 *  1. A missing item value is never invented, imputed or interpolated. The only
 *     permitted transformations are reverse-keying (`min + max - value`), the
 *     declared `multiplyBy`/`addConstant` scaling, the declared missing-data
 *     policy (proration / partial sum) and display rounding in `roundForDisplay`.
 *  2. Every number returned is reproducible from `algorithmVersion`,
 *     `sourceItemIds`, `contributions` and the observed answers.
 *  3. A score resting on fewer than `itemsExpected` items carries the missing
 *     count and is flagged `methodologicallyProvisional`.
 *  4. A clinical scale (`kind: "clinical_elevation"`) of an instrument version
 *     without `clinicalUsePermitted` never yields a band.
 *  5. Stored numbers keep full precision; `roundForDisplay` is display-only.
 */

import { DomainError } from "./types.ts";
import type {
  ComputedScore,
  ItemContribution,
  MissingPolicy,
  ScaleScoringSpec,
  ScorableAnswer,
  ScorableItem,
  ScoreAlgorithmDefinition,
  ScoreAlgorithmStep,
  ScoreDiagnostic,
  SessionScoringInput,
  SessionScoringResult,
} from "./types.ts";

// -------------------------------------------------------------- primitives --

export const DISPLAY_DECIMALS = 4;

/** Display-only rounding: stored scores keep full precision. */
export function roundForDisplay(value: number, decimals: number = DISPLAY_DECIMALS): number {
  if (!Number.isFinite(value) || !Number.isInteger(decimals) || decimals < 0) return value;
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

const SCORABLE_RESPONSE_TYPES: ReadonlySet<string> = new Set([
  "likert",
  "yes_no",
  "multiple_choice",
  "numeric",
  "categorical",
]);

/** open_text and date items can never carry a numeric score. */
export function isNumericallyScorable(responseType: ScorableItem["responseType"]): boolean {
  return SCORABLE_RESPONSE_TYPES.has(responseType);
}

const MISSING_POLICIES: readonly MissingPolicy[] = [
  "strict_complete",
  "prorate_if_min_met",
  "sum_available_only",
  "no_score",
];

const AGGREGATE_STEP_KINDS: ReadonlySet<string> = new Set([
  "recoded_sum",
  "weighted_sum",
  "mean_of_items",
  "subscale_sum",
]);

const STEP_KINDS: ReadonlySet<string> = new Set([
  ...AGGREGATE_STEP_KINDS,
  "linear_transform",
  "z_score",
  "percentile_lookup",
  "band_lookup",
]);

/**
 * Proration factor for `prorate_if_min_met`.
 *
 * Sum-family aggregates (recoded_sum, weighted_sum, subscale_sum) are scaled by
 * `itemsExpected / itemsUsed`, i.e. the available sum is expanded to the
 * full-item total. `mean_of_items` is the one exception: the mean of the
 * available items is already the expected value of the full-item mean, so
 * multiplying it by `expected / used` would push the estimate outside the
 * declared item range; its factor is therefore 1.
 */
export function prorationFactorFor(stepKind: string, expected: number, used: number): number {
  if (used <= 0 || expected <= used) return 1;
  return stepKind === "mean_of_items" ? 1 : expected / used;
}

export type ScoringDiagnosticCode =
  | "scoring.algorithm_version_missing"
  | "scoring.unknown_missing_policy"
  | "scoring.min_items_invalid"
  | "scoring.min_items_exceeds_referenced"
  | "scoring.steps_empty"
  | "scoring.unknown_step_kind"
  | "scoring.step_malformed"
  | "scoring.empty_item_codes"
  | "scoring.unknown_item_code"
  | "scoring.item_not_scorable"
  | "scoring.duplicate_step_item"
  | "scoring.duplicate_subscale"
  | "scoring.reverse_bounds_missing"
  | "scoring.reverse_key_invalid"
  | "scoring.weight_not_finite"
  | "scoring.subscale_list_empty"
  | "scoring.subscale_value_missing"
  | "scoring.subscale_provenance_unavailable"
  | "scoring.linear_transform_invalid"
  | "scoring.z_score_sd_invalid"
  | "scoring.percentile_table_empty"
  | "scoring.percentile_table_not_monotonic"
  | "scoring.percentile_out_of_range"
  | "scoring.percentile_below_table"
  | "scoring.bands_empty"
  | "scoring.bands_not_monotonic"
  | "scoring.band_label_missing"
  | "scoring.band_not_matched"
  | "scoring.source_value_missing"
  | "scoring.source_scale_unknown"
  | "scoring.source_scale_not_computable"
  | "scoring.multiple_aggregate_steps"
  | "scoring.no_primary_value"
  | "scoring.incomplete_data"
  | "scoring.required_item_missing"
  | "scoring.value_not_numeric"
  | "scoring.value_out_of_range"
  | "scoring.policy_no_score"
  | "scoring.strict_complete_incomplete"
  | "scoring.min_items_not_met"
  | "scoring.no_usable_items"
  | "scoring.prorated"
  | "scoring.partial_sum_unscaled"
  | "scoring.clinical_band_suppressed"
  | "scoring.clinical_interpretation_blocked"
  | "scoring.provisional_instrument"
  | "scoring.answer_without_item"
  | "scoring.duplicate_item_code"
  | "scoring.duplicate_scale_code"
  | "scoring.open_text_items_excluded"
  | "scoring.scale_algorithm_invalid";

type DiagnosticSeverity = ScoreDiagnostic["severity"];

function diag(
  code: ScoringDiagnosticCode,
  severity: DiagnosticSeverity,
  message: string,
  itemCode?: string,
): ScoreDiagnostic {
  return itemCode === undefined ? { code, severity, message } : { code, severity, message, itemCode };
}

/** Order-preserving removal of repeats (validateAlgorithm and runtime checks overlap). */
function dedupeDiagnostics(list: ScoreDiagnostic[]): ScoreDiagnostic[] {
  const seen = new Set<string>();
  const out: ScoreDiagnostic[] = [];
  for (const entry of list) {
    const key = `${entry.code}|${entry.severity}|${entry.itemCode ?? ""}|${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function isStrictlyIncreasing(values: number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || current <= previous) return false;
  }
  return true;
}

// ----------------------------------------------------------------- context --

export interface PriorScaleValue {
  rawScore: number | null;
  /** Item definition ids the prior scale was computed from, for provenance chaining. */
  sourceItemIds?: string[];
}

/**
 * Runtime facts the scorer must not infer from an algorithm definition.
 *
 * `priorScales` lets `subscale_sum`, `linear_transform.fromRawScale`, `z_score`
 * and `percentile_lookup`/`band_lookup` consume scales computed earlier *in the
 * same session*; `scoreSession` fills it in declaration order, so a consuming
 * scale must be declared after the scale it consumes.
 */
export interface ScoreContext {
  clinicalUsePermitted: boolean;
  provisionalInstrument: boolean;
  priorScales?: Record<string, PriorScaleValue>;
}

// ----------------------------------------------------------- item indexing --

function indexItemsByCode(items: ScorableItem[]): Map<string, ScorableItem> {
  const byCode = new Map<string, ScorableItem>();
  for (const item of items) if (!byCode.has(item.itemCode)) byCode.set(item.itemCode, item);
  return byCode;
}

function indexAnswersByItemId(answers: ScorableAnswer[]): Map<string, ScorableAnswer> {
  const byItemId = new Map<string, ScorableAnswer>();
  for (const answer of answers) if (!byItemId.has(answer.itemDefinitionId)) byItemId.set(answer.itemDefinitionId, answer);
  return byItemId;
}

function indexAnswersByCode(answers: ScorableAnswer[]): Map<string, ScorableAnswer> {
  const byCode = new Map<string, ScorableAnswer>();
  for (const answer of answers) if (!byCode.has(answer.itemCode)) byCode.set(answer.itemCode, answer);
  return byCode;
}

function answerFor(
  item: ScorableItem,
  byItemId: Map<string, ScorableAnswer>,
  byCode: Map<string, ScorableAnswer>,
): ScorableAnswer | null {
  return byItemId.get(item.itemDefinitionId) ?? byCode.get(item.itemCode) ?? null;
}

type ValueResolution =
  | { ok: true; value: number }
  /** `observed` keeps a rejected number visible (out of range); it is never used in a computation. */
  | { ok: false; reason: string; note: string; observed: number | null };

/**
 * The single gate deciding whether an observed answer may enter a computation.
 * Anything that is not a finite, in-range number is *missing*: never clamped,
 * never coerced, never replaced.
 */
function resolveValue(item: ScorableItem, answer: ScorableAnswer | null): ValueResolution {
  if (!isNumericallyScorable(item.responseType)) {
    return { ok: false, reason: "not_scorable_type", note: `${item.responseType} item cannot carry a numeric score`, observed: null };
  }
  if (answer === null) return { ok: false, reason: "not_collected", note: "no observed answer for this item", observed: null };
  if (answer.isMissing) {
    const reason = answer.missingReason ?? "flagged_missing";
    return { ok: false, reason, note: `answer flagged missing (${reason})`, observed: null };
  }
  const value = answer.valueNumeric;
  if (value === null || !Number.isFinite(value)) {
    return { ok: false, reason: "value_not_numeric", note: "answer holds no finite numeric value", observed: null };
  }
  if (item.minValue !== null && value < item.minValue) {
    return { ok: false, reason: "value_out_of_range", note: `value ${value} is below the declared minimum ${item.minValue}`, observed: value };
  }
  if (item.maxValue !== null && value > item.maxValue) {
    return { ok: false, reason: "value_out_of_range", note: `value ${value} is above the declared maximum ${item.maxValue}`, observed: value };
  }
  return { ok: true, value };
}

function resolveReverseBounds(
  item: ScorableItem,
  stepKey: { min: number; max: number } | undefined,
): { min: number; max: number } | null {
  if (stepKey !== undefined && Number.isFinite(stepKey.min) && Number.isFinite(stepKey.max) && stepKey.max > stepKey.min) {
    return { min: stepKey.min, max: stepKey.max };
  }
  if (
    item.minValue !== null &&
    item.maxValue !== null &&
    Number.isFinite(item.minValue) &&
    Number.isFinite(item.maxValue) &&
    item.maxValue > item.minValue
  ) {
    return { min: item.minValue, max: item.maxValue };
  }
  return null;
}

// ---------------------------------------------------------- parseAlgorithm --

interface ParseIssue {
  path: string;
  code: ScoringDiagnosticCode;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (!isNonEmptyString(entry)) return null;
    out.push(entry);
  }
  return out;
}

function parseStep(raw: unknown, path: string, issues: ParseIssue[]): ScoreAlgorithmStep | null {
  if (!isRecord(raw)) {
    issues.push({ path, code: "scoring.step_malformed", message: "step must be an object" });
    return null;
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !STEP_KINDS.has(kind)) {
    issues.push({ path: `${path}.kind`, code: "scoring.unknown_step_kind", message: `unsupported step kind ${JSON.stringify(kind)}` });
    return null;
  }

  const reverseKey = raw.reverseKey;
  let parsedReverseKey: { min: number; max: number } | undefined;
  if (reverseKey !== undefined) {
    if (!isRecord(reverseKey) || !isFiniteNumber(reverseKey.min) || !isFiniteNumber(reverseKey.max) || reverseKey.max <= reverseKey.min) {
      issues.push({ path: `${path}.reverseKey`, code: "scoring.reverse_key_invalid", message: "reverseKey needs finite min < max" });
    } else {
      parsedReverseKey = { min: reverseKey.min, max: reverseKey.max };
    }
  }

  const scaleReference = (field: "fromRawScale" | "sourceRawScale"): string | undefined => {
    const value = raw[field];
    if (value === undefined) return undefined;
    if (!isNonEmptyString(value)) {
      issues.push({ path: `${path}.${field}`, code: "scoring.step_malformed", message: `${field} must be a non-empty scale code` });
      return undefined;
    }
    return value;
  };

  if (kind === "recoded_sum" || kind === "mean_of_items") {
    const itemCodes = stringArray(raw.itemCodes);
    if (itemCodes === null || itemCodes.length === 0) {
      issues.push({ path: `${path}.itemCodes`, code: "scoring.empty_item_codes", message: "itemCodes must be a non-empty array of item codes" });
      return null;
    }
    let reverseItemCodes: string[] | undefined;
    if (raw.reverseItemCodes !== undefined) {
      const parsed = stringArray(raw.reverseItemCodes);
      if (parsed === null) issues.push({ path: `${path}.reverseItemCodes`, code: "scoring.step_malformed", message: "reverseItemCodes must be an array of item codes" });
      else reverseItemCodes = parsed;
    }
    if (kind === "mean_of_items") {
      for (const unsupported of ["multiplyBy", "addConstant"] as const) {
        if (raw[unsupported] !== undefined) {
          issues.push({
            path: `${path}.${unsupported}`,
            code: "scoring.step_malformed",
            message: `mean_of_items does not declare ${unsupported}; declare a linear_transform step instead`,
          });
        }
      }
      return {
        kind: "mean_of_items",
        itemCodes,
        ...(reverseItemCodes === undefined ? {} : { reverseItemCodes }),
        ...(parsedReverseKey === undefined ? {} : { reverseKey: parsedReverseKey }),
      };
    }
    const multiplyBy = raw.multiplyBy === undefined ? undefined : isFiniteNumber(raw.multiplyBy) ? raw.multiplyBy : null;
    const addConstant = raw.addConstant === undefined ? undefined : isFiniteNumber(raw.addConstant) ? raw.addConstant : null;
    if (multiplyBy === null) issues.push({ path: `${path}.multiplyBy`, code: "scoring.linear_transform_invalid", message: "multiplyBy must be a finite number" });
    if (addConstant === null) issues.push({ path: `${path}.addConstant`, code: "scoring.linear_transform_invalid", message: "addConstant must be a finite number" });
    return {
      kind: "recoded_sum",
      itemCodes,
      ...(reverseItemCodes === undefined ? {} : { reverseItemCodes }),
      ...(parsedReverseKey === undefined ? {} : { reverseKey: parsedReverseKey }),
      ...(multiplyBy === undefined || multiplyBy === null ? {} : { multiplyBy }),
      ...(addConstant === undefined || addConstant === null ? {} : { addConstant }),
    };
  }

  if (kind === "weighted_sum") {
    if (!Array.isArray(raw.weights) || raw.weights.length === 0) {
      issues.push({ path: `${path}.weights`, code: "scoring.step_malformed", message: "weights must be a non-empty array" });
      return null;
    }
    const weights: Array<{ itemCode: string; weight: number; reverse?: boolean }> = [];
    raw.weights.forEach((entry, index) => {
      const at = `${path}.weights[${index}]`;
      if (!isRecord(entry) || !isNonEmptyString(entry.itemCode)) {
        issues.push({ path: at, code: "scoring.step_malformed", message: "weight entry needs a non-empty itemCode" });
        return;
      }
      if (!isFiniteNumber(entry.weight)) {
        issues.push({ path: `${at}.weight`, code: "scoring.weight_not_finite", message: `weight for item ${entry.itemCode} must be a finite number` });
        return;
      }
      if (entry.reverse !== undefined && typeof entry.reverse !== "boolean") {
        issues.push({ path: `${at}.reverse`, code: "scoring.step_malformed", message: "reverse must be a boolean" });
        return;
      }
      weights.push({ itemCode: entry.itemCode, weight: entry.weight, ...(entry.reverse === true ? { reverse: true } : {}) });
    });
    if (weights.length === 0) return null;
    const multiplyBy = raw.multiplyBy === undefined ? undefined : isFiniteNumber(raw.multiplyBy) ? raw.multiplyBy : null;
    const addConstant = raw.addConstant === undefined ? undefined : isFiniteNumber(raw.addConstant) ? raw.addConstant : null;
    if (multiplyBy === null) issues.push({ path: `${path}.multiplyBy`, code: "scoring.linear_transform_invalid", message: "multiplyBy must be a finite number" });
    if (addConstant === null) issues.push({ path: `${path}.addConstant`, code: "scoring.linear_transform_invalid", message: "addConstant must be a finite number" });
    return {
      kind: "weighted_sum",
      weights,
      ...(multiplyBy === undefined || multiplyBy === null ? {} : { multiplyBy }),
      ...(addConstant === undefined || addConstant === null ? {} : { addConstant }),
    };
  }

  if (kind === "subscale_sum") {
    if (!Array.isArray(raw.subscales) || raw.subscales.length === 0) {
      issues.push({ path: `${path}.subscales`, code: "scoring.subscale_list_empty", message: "subscales must be a non-empty array" });
      return null;
    }
    const subscales: Array<{ scaleCode: string }> = [];
    raw.subscales.forEach((entry, index) => {
      if (!isRecord(entry) || !isNonEmptyString(entry.scaleCode)) {
        issues.push({ path: `${path}.subscales[${index}]`, code: "scoring.step_malformed", message: "subscale entry needs a non-empty scaleCode" });
        return;
      }
      subscales.push({ scaleCode: entry.scaleCode });
    });
    if (subscales.length === 0) return null;
    return { kind: "subscale_sum", subscales };
  }

  if (kind === "linear_transform") {
    if (!isFiniteNumber(raw.multiplyBy) || !isFiniteNumber(raw.addConstant)) {
      issues.push({ path, code: "scoring.linear_transform_invalid", message: "linear_transform requires finite multiplyBy and addConstant" });
      return null;
    }
    const fromRawScale = scaleReference("fromRawScale");
    return { kind: "linear_transform", multiplyBy: raw.multiplyBy, addConstant: raw.addConstant, ...(fromRawScale === undefined ? {} : { fromRawScale }) };
  }

  if (kind === "z_score") {
    if (!isFiniteNumber(raw.mean) || !isFiniteNumber(raw.sd) || raw.sd <= 0) {
      issues.push({ path, code: "scoring.z_score_sd_invalid", message: "z_score requires a finite mean and a finite sd > 0" });
      return null;
    }
    const sourceRawScale = scaleReference("sourceRawScale");
    return { kind: "z_score", mean: raw.mean, sd: raw.sd, ...(sourceRawScale === undefined ? {} : { sourceRawScale }) };
  }

  if (kind === "percentile_lookup") {
    if (!Array.isArray(raw.table) || raw.table.length === 0) {
      issues.push({ path: `${path}.table`, code: "scoring.percentile_table_empty", message: "table must be a non-empty array" });
      return null;
    }
    const table: Array<{ atOrAbove: number; percentile: number }> = [];
    raw.table.forEach((entry, index) => {
      if (!isRecord(entry) || !isFiniteNumber(entry.atOrAbove) || !isFiniteNumber(entry.percentile)) {
        issues.push({ path: `${path}.table[${index}]`, code: "scoring.step_malformed", message: "table entry needs finite atOrAbove and percentile" });
        return;
      }
      table.push({ atOrAbove: entry.atOrAbove, percentile: entry.percentile });
    });
    if (table.length === 0) return null;
    const sourceRawScale = scaleReference("sourceRawScale");
    return { kind: "percentile_lookup", table, ...(sourceRawScale === undefined ? {} : { sourceRawScale }) };
  }

  if (!Array.isArray(raw.bands) || raw.bands.length === 0) {
    issues.push({ path: `${path}.bands`, code: "scoring.bands_empty", message: "bands must be a non-empty array" });
    return null;
  }
  const bands: Array<{ max: number | null; label: string; note?: string }> = [];
  raw.bands.forEach((entry, index) => {
    const at = `${path}.bands[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path: at, code: "scoring.step_malformed", message: "band entry must be an object" });
      return;
    }
    const max = entry.max === null ? null : isFiniteNumber(entry.max) ? entry.max : undefined;
    if (max === undefined) {
      issues.push({ path: `${at}.max`, code: "scoring.step_malformed", message: "band max must be a finite number or null" });
      return;
    }
    if (!isNonEmptyString(entry.label)) {
      issues.push({ path: `${at}.label`, code: "scoring.band_label_missing", message: "band label must be a non-empty string" });
      return;
    }
    if (entry.note !== undefined && typeof entry.note !== "string") {
      issues.push({ path: `${at}.note`, code: "scoring.step_malformed", message: "band note must be a string" });
      return;
    }
    bands.push({ max, label: entry.label, ...(typeof entry.note === "string" ? { note: entry.note } : {}) });
  });
  if (bands.length === 0) return null;
  return { kind: "band_lookup", bands };
}

/**
 * Structural runtime validation of a persisted `algorithm_json` payload.
 *
 * Throws `DomainError` with code `scoring.algorithm_invalid` (details under
 * `detail.issues`). Methodological problems that need the item list — unknown
 * item codes, non-monotonic tables, missing reverse bounds — are reported by
 * `validateAlgorithm` instead, because they depend on the instrument version.
 */
export function parseAlgorithm(input: unknown): ScoreAlgorithmDefinition {
  if (!isRecord(input)) {
    throw new DomainError("scoring.algorithm_invalid", "Score algorithm definition must be an object", {
      issues: [{ path: "$", code: "scoring.algorithm_invalid", message: "expected an object" }],
    });
  }
  const issues: ParseIssue[] = [];

  const algorithmVersion = isNonEmptyString(input.algorithmVersion) ? input.algorithmVersion : "";
  if (algorithmVersion === "") {
    issues.push({ path: "$.algorithmVersion", code: "scoring.algorithm_version_missing", message: "non-empty algorithmVersion is required" });
  }

  const missingPolicy = input.missingPolicy;
  if (typeof missingPolicy !== "string" || !MISSING_POLICIES.includes(missingPolicy as MissingPolicy)) {
    issues.push({
      path: "$.missingPolicy",
      code: "scoring.unknown_missing_policy",
      message: `missingPolicy must be one of ${MISSING_POLICIES.join(", ")}`,
    });
  }

  const minItemsRequired = input.minItemsRequired;
  if (typeof minItemsRequired !== "number" || !Number.isInteger(minItemsRequired) || minItemsRequired < 0) {
    issues.push({ path: "$.minItemsRequired", code: "scoring.min_items_invalid", message: "minItemsRequired must be an integer >= 0" });
  }

  const steps: ScoreAlgorithmStep[] = [];
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    issues.push({ path: "$.steps", code: "scoring.steps_empty", message: "at least one algorithm step is required" });
  } else {
    input.steps.forEach((raw, index) => {
      const step = parseStep(raw, `$.steps[${index}]`, issues);
      if (step !== null) steps.push(step);
    });
  }

  if (input.documentation !== undefined && typeof input.documentation !== "string") {
    issues.push({ path: "$.documentation", code: "scoring.step_malformed", message: "documentation must be a string" });
  }

  if (issues.length > 0) {
    throw new DomainError("scoring.algorithm_invalid", `Score algorithm definition is invalid (${issues.length} issue(s))`, {
      issues: issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })),
    });
  }

  return {
    algorithmVersion,
    steps,
    missingPolicy: missingPolicy as MissingPolicy,
    minItemsRequired: minItemsRequired as number,
    ...(typeof input.documentation === "string" ? { documentation: input.documentation } : {}),
  };
}

// ------------------------------------------------------- validateAlgorithm --

const REVERSE_BOUNDS_MESSAGE = (at: string, code: string) =>
  `${at} reverse-keys item ${code} without finite min/max bounds (item minValue/maxValue or a step reverseKey)`;

/**
 * Methodological validation of an algorithm against the item definitions it will
 * run on: unknown item codes, weights on missing items, reverse items without
 * bounds, unknown step kinds, `minItemsRequired` above the referenced item count,
 * non-monotonic percentile tables and non-monotonic bands.
 *
 * Diagnostics only: deciding whether to score is the caller's job.
 */
export function validateAlgorithm(algorithm: ScoreAlgorithmDefinition, items: ScorableItem[]): ScoreDiagnostic[] {
  const diagnostics: ScoreDiagnostic[] = [];
  const byCode = indexItemsByCode(items);

  if (!isNonEmptyString(algorithm.algorithmVersion)) {
    diagnostics.push(diag("scoring.algorithm_version_missing", "fail", "algorithmVersion is required to make a score reproducible"));
  }
  if (!MISSING_POLICIES.includes(algorithm.missingPolicy)) {
    diagnostics.push(diag("scoring.unknown_missing_policy", "fail", `unknown missingPolicy ${JSON.stringify(algorithm.missingPolicy)}`));
  }
  if (!Number.isInteger(algorithm.minItemsRequired) || algorithm.minItemsRequired < 0) {
    diagnostics.push(diag("scoring.min_items_invalid", "fail", "minItemsRequired must be an integer >= 0"));
  }
  if (!Array.isArray(algorithm.steps) || algorithm.steps.length === 0) {
    diagnostics.push(diag("scoring.steps_empty", "fail", "the algorithm declares no steps"));
    return diagnostics;
  }

  const scorableCodes = new Set<string>();
  let hasItemAggregate = false;

  algorithm.steps.forEach((step, stepIndex) => {
    const at = `step ${stepIndex + 1} (${String(step.kind)})`;
    if (!STEP_KINDS.has(step.kind)) {
      diagnostics.push(diag("scoring.unknown_step_kind", "fail", `${at} uses an unsupported step kind`));
      return;
    }

    if (step.kind === "recoded_sum" || step.kind === "mean_of_items") {
      hasItemAggregate = true;
      if (step.itemCodes.length === 0) diagnostics.push(diag("scoring.empty_item_codes", "fail", `${at} declares no item codes`));
      const declared = new Set<string>();
      for (const code of step.itemCodes) {
        if (declared.has(code)) {
          diagnostics.push(diag("scoring.duplicate_step_item", "warn", `${at} references item ${code} more than once`, code));
          continue;
        }
        declared.add(code);
        const item = byCode.get(code);
        if (item === undefined) {
          diagnostics.push(diag("scoring.unknown_item_code", "fail", `${at} references item code ${code}, which is not in this instrument version`, code));
          continue;
        }
        if (!isNumericallyScorable(item.responseType)) {
          diagnostics.push(diag("scoring.item_not_scorable", "warn", `${at} references ${item.responseType} item ${code}; it is excluded from numeric scoring`, code));
          continue;
        }
        scorableCodes.add(code);
      }
      const reverseKey = step.reverseKey;
      if (reverseKey !== undefined && !(Number.isFinite(reverseKey.min) && Number.isFinite(reverseKey.max) && reverseKey.max > reverseKey.min)) {
        diagnostics.push(diag("scoring.reverse_key_invalid", "fail", `${at} declares reverseKey without finite min < max`));
      }
      // Every reversed item needs bounds: step-level reverseItemCodes, plus the
      // item's own reverseScored flag for items referenced by this step.
      const reversed = new Set<string>(step.reverseItemCodes ?? []);
      for (const code of step.itemCodes) {
        const item = byCode.get(code);
        if (item !== undefined && item.reverseScored) reversed.add(code);
      }
      for (const code of reversed) {
        const item = byCode.get(code);
        if (item === undefined) {
          diagnostics.push(diag("scoring.unknown_item_code", "fail", `${at} reverse-keys item code ${code}, which is not in this instrument version`, code));
          continue;
        }
        if (!isNumericallyScorable(item.responseType)) continue;
        if (resolveReverseBounds(item, step.reverseKey) === null) {
          diagnostics.push(diag("scoring.reverse_bounds_missing", "fail", REVERSE_BOUNDS_MESSAGE(at, code), code));
        }
      }
      return;
    }

    if (step.kind === "weighted_sum") {
      hasItemAggregate = true;
      const declared = new Set<string>();
      for (const entry of step.weights) {
        if (!Number.isFinite(entry.weight)) {
          diagnostics.push(diag("scoring.weight_not_finite", "fail", `${at} gives item ${entry.itemCode} a non-finite weight`, entry.itemCode));
          continue;
        }
        if (declared.has(entry.itemCode)) {
          diagnostics.push(diag("scoring.duplicate_step_item", "warn", `${at} weights item ${entry.itemCode} more than once`, entry.itemCode));
          continue;
        }
        declared.add(entry.itemCode);
        const item = byCode.get(entry.itemCode);
        if (item === undefined) {
          diagnostics.push(diag("scoring.unknown_item_code", "fail", `${at} weights item code ${entry.itemCode}, which is not in this instrument version`, entry.itemCode));
          continue;
        }
        if (!isNumericallyScorable(item.responseType)) {
          diagnostics.push(diag("scoring.item_not_scorable", "warn", `${at} weights ${item.responseType} item ${entry.itemCode}; it is excluded from numeric scoring`, entry.itemCode));
          continue;
        }
        scorableCodes.add(entry.itemCode);
        if ((entry.reverse === true || item.reverseScored) && resolveReverseBounds(item, undefined) === null) {
          diagnostics.push(diag("scoring.reverse_bounds_missing", "fail", REVERSE_BOUNDS_MESSAGE(at, entry.itemCode), entry.itemCode));
        }
      }
      return;
    }

    if (step.kind === "subscale_sum") {
      if (step.subscales.length === 0) diagnostics.push(diag("scoring.subscale_list_empty", "fail", `${at} declares no subscales`));
      const declared = new Set<string>();
      for (const subscale of step.subscales) {
        if (declared.has(subscale.scaleCode)) {
          diagnostics.push(diag("scoring.duplicate_subscale", "warn", `${at} lists subscale ${subscale.scaleCode} more than once`));
        }
        declared.add(subscale.scaleCode);
      }
      return;
    }

    if (step.kind === "linear_transform") {
      if (!Number.isFinite(step.multiplyBy) || !Number.isFinite(step.addConstant)) {
        diagnostics.push(diag("scoring.linear_transform_invalid", "fail", `${at} needs a finite multiplyBy and addConstant`));
      }
      return;
    }

    if (step.kind === "z_score") {
      if (!Number.isFinite(step.mean) || !Number.isFinite(step.sd) || step.sd <= 0) {
        diagnostics.push(diag("scoring.z_score_sd_invalid", "fail", `${at} needs a finite mean and sd > 0`));
      }
      return;
    }

    if (step.kind === "percentile_lookup") {
      if (step.table.length === 0) {
        diagnostics.push(diag("scoring.percentile_table_empty", "fail", `${at} declares an empty percentile table`));
        return;
      }
      let previousAt: number | null = null;
      let previousPercentile: number | null = null;
      step.table.forEach((entry, index) => {
        if (previousAt !== null && entry.atOrAbove <= previousAt) {
          diagnostics.push(diag("scoring.percentile_table_not_monotonic", "fail", `${at} table entry ${index + 1} is not strictly above the previous atOrAbove`));
        }
        if (entry.percentile < 0 || entry.percentile > 100) {
          diagnostics.push(diag("scoring.percentile_out_of_range", "fail", `${at} declares percentile ${entry.percentile} outside 0..100`));
        }
        if (previousPercentile !== null && entry.percentile < previousPercentile) {
          diagnostics.push(diag("scoring.percentile_table_not_monotonic", "warn", `${at} percentiles decrease as atOrAbove increases`));
        }
        previousAt = entry.atOrAbove;
        previousPercentile = entry.percentile;
      });
      return;
    }

    if (step.bands.length === 0) {
      diagnostics.push(diag("scoring.bands_empty", "fail", `${at} declares no bands`));
      return;
    }
    let previousMax: number | null = null;
    let sawOpenEnded = false;
    step.bands.forEach((band, index) => {
      if (band.label.trim() === "") diagnostics.push(diag("scoring.band_label_missing", "fail", `${at} band ${index + 1} has an empty label`));
      if (sawOpenEnded) diagnostics.push(diag("scoring.bands_not_monotonic", "fail", `${at} declares a band after the open-ended (max: null) band`));
      if (band.max === null) {
        sawOpenEnded = true;
        return;
      }
      if (previousMax !== null && band.max <= previousMax) {
        diagnostics.push(diag("scoring.bands_not_monotonic", "fail", `${at} band ${index + 1} upper bound ${band.max} does not increase`));
      }
      previousMax = band.max;
    });
  });

  if (hasItemAggregate && Number.isInteger(algorithm.minItemsRequired) && algorithm.minItemsRequired > scorableCodes.size) {
    diagnostics.push(
      diag(
        "scoring.min_items_exceeds_referenced",
        "fail",
        `minItemsRequired ${algorithm.minItemsRequired} exceeds the ${scorableCodes.size} scorable item(s) the algorithm references`,
      ),
    );
  }

  return dedupeDiagnostics(diagnostics);
}

// ------------------------------------------------------------- aggregation --

interface Term {
  /** Item code, or subscale code for `subscale_sum`. */
  code: string;
  item: ScorableItem | null;
  weight: number;
  reversed: boolean;
  itemDefinitionId: string | null;
}

interface TermOutcome {
  term: Term;
  /** Observed (pre-reverse) numeric value, null when unavailable. */
  value: number | null;
  reversed: boolean;
  included: boolean;
  /** Term added to the aggregate: weight * (reversed value). */
  contribution: number | null;
  note: string | null;
  missingReason: string | null;
}

interface AggregateOutcome {
  value: number | null;
  /** Set when the aggregate could not be formed (policy, missing source, invalid data). */
  blockedReason: string | null;
  contributions: ItemContribution[];
  sourceItemIds: string[];
  expected: number;
  used: number;
  missing: number;
  partial: boolean;
  prorated: boolean;
  diagnostics: ScoreDiagnostic[];
}

function aggregateTerms(
  step: ScoreAlgorithmStep,
  byCode: Map<string, ScorableItem>,
  diagnostics: ScoreDiagnostic[],
): Term[] {
  const terms: Term[] = [];
  const seen = new Set<string>();

  if (step.kind === "recoded_sum" || step.kind === "mean_of_items") {
    const reverseCodes = new Set(step.reverseItemCodes ?? []);
    for (const code of step.itemCodes) {
      const item = byCode.get(code) ?? null;
      if (seen.has(code)) {
        diagnostics.push(diag("scoring.duplicate_step_item", "warn", `${step.kind} lists item ${code} more than once; the first occurrence is used`, code));
        continue;
      }
      seen.add(code);
      if (item === null) {
        diagnostics.push(diag("scoring.unknown_item_code", "fail", `${step.kind} references item code ${code}, which is not in this instrument version`, code));
        continue;
      }
      if (!isNumericallyScorable(item.responseType)) {
        diagnostics.push(diag("scoring.item_not_scorable", "warn", `${item.responseType} item ${code} is excluded from numeric scoring`, code));
        continue;
      }
      terms.push({
        code,
        item,
        weight: 1,
        reversed: reverseCodes.has(code) || item.reverseScored,
        itemDefinitionId: item.itemDefinitionId,
      });
    }
    return terms;
  }

  if (step.kind === "weighted_sum") {
    for (const entry of step.weights) {
      const item = byCode.get(entry.itemCode) ?? null;
      if (seen.has(entry.itemCode)) {
        diagnostics.push(diag("scoring.duplicate_step_item", "warn", `weighted_sum weights item ${entry.itemCode} more than once; the first weight is used`, entry.itemCode));
        continue;
      }
      seen.add(entry.itemCode);
      if (item === null) {
        diagnostics.push(diag("scoring.unknown_item_code", "fail", `weighted_sum references item code ${entry.itemCode}, which is not in this instrument version`, entry.itemCode));
        continue;
      }
      if (!Number.isFinite(entry.weight)) {
        diagnostics.push(diag("scoring.weight_not_finite", "fail", `weighted_sum gives item ${entry.itemCode} a non-finite weight`, entry.itemCode));
        continue;
      }
      if (!isNumericallyScorable(item.responseType)) {
        diagnostics.push(diag("scoring.item_not_scorable", "warn", `${item.responseType} item ${entry.itemCode} is excluded from numeric scoring`, entry.itemCode));
        continue;
      }
      terms.push({
        code: entry.itemCode,
        item,
        weight: entry.weight,
        reversed: entry.reverse === true || item.reverseScored,
        itemDefinitionId: item.itemDefinitionId,
      });
    }
  }

  return terms;
}

function evaluateTerms(
  terms: Term[],
  step: ScoreAlgorithmStep,
  answersByItemId: Map<string, ScorableAnswer>,
  answersByCode: Map<string, ScorableAnswer>,
  diagnostics: ScoreDiagnostic[],
): TermOutcome[] {
  const stepKey = "reverseKey" in step ? step.reverseKey : undefined;
  return terms.map((term) => {
    const item = term.item;
    if (item === null) {
      return { term, value: null, reversed: false, included: false, contribution: null, note: "unknown item code", missingReason: "unknown_item_code" };
    }
    const resolution = resolveValue(item, answerFor(item, answersByItemId, answersByCode));
    if (!resolution.ok) {
      if (resolution.reason === "value_not_numeric" || resolution.reason === "value_out_of_range") {
        diagnostics.push(
          diag(
            resolution.reason === "value_not_numeric" ? "scoring.value_not_numeric" : "scoring.value_out_of_range",
            "warn",
            `${resolution.note}; the item is treated as missing and is never coerced or imputed`,
            item.itemCode,
          ),
        );
      }
      return { term, value: resolution.observed, reversed: false, included: false, contribution: null, note: resolution.note, missingReason: resolution.reason };
    }

    let value = resolution.value;
    let reversed = false;
    let note: string | null = null;
    if (term.reversed) {
      const bounds = resolveReverseBounds(item, stepKey);
      if (bounds === null) {
        diagnostics.push(
          diag(
            "scoring.reverse_bounds_missing",
            "fail",
            `item ${item.itemCode} is reverse-keyed but has no finite min/max bounds (item minValue/maxValue or a step reverseKey)`,
            item.itemCode,
          ),
        );
        return {
          term,
          value: null,
          reversed: false,
          included: false,
          contribution: null,
          note: "reverse-keyed without min/max bounds",
          missingReason: "reverse_bounds_missing",
        };
      }
      value = bounds.min + bounds.max - value;
      reversed = true;
      note = `reverse-keyed: ${bounds.min} + ${bounds.max} - ${resolution.value} = ${value}`;
    }
    return { term, value: resolution.value, reversed, included: true, contribution: term.weight * value, note, missingReason: null };
  });
}

function runAggregateStep(
  step: ScoreAlgorithmStep,
  missingPolicy: MissingPolicy,
  minItemsRequired: number,
  byCode: Map<string, ScorableItem>,
  answersByItemId: Map<string, ScorableAnswer>,
  answersByCode: Map<string, ScorableAnswer>,
  priorScales: Record<string, PriorScaleValue>,
): AggregateOutcome {
  const diagnostics: ScoreDiagnostic[] = [];
  const outcomes: TermOutcome[] = [];
  const sourceItemIds: string[] = [];
  const seenSources = new Set<string>();

  if (step.kind === "subscale_sum") {
    const seen = new Set<string>();
    for (const subscale of step.subscales) {
      if (seen.has(subscale.scaleCode)) {
        diagnostics.push(diag("scoring.duplicate_subscale", "warn", `subscale_sum lists ${subscale.scaleCode} more than once; the first entry is used`));
        continue;
      }
      seen.add(subscale.scaleCode);
      const entry: PriorScaleValue | undefined = priorScales[subscale.scaleCode];
      const term: Term = { code: subscale.scaleCode, item: null, weight: 1, reversed: false, itemDefinitionId: null };
      if (entry === undefined) {
        diagnostics.push(
          diag("scoring.subscale_value_missing", "fail", `subscale_sum references scale ${subscale.scaleCode}, which was not computed earlier in this session`, subscale.scaleCode),
        );
        outcomes.push({ term, value: null, reversed: false, included: false, contribution: null, note: "subscale was not computed earlier in this session", missingReason: "subscale_unknown" });
        continue;
      }
      if (entry.sourceItemIds === undefined || entry.sourceItemIds.length === 0) {
        diagnostics.push(
          diag(
            "scoring.subscale_provenance_unavailable",
            "warn",
            `subscale ${subscale.scaleCode} was supplied without source item ids; the sum's provenance is incomplete`,
            subscale.scaleCode,
          ),
        );
      } else {
        for (const id of entry.sourceItemIds) {
          if (!seenSources.has(id)) {
            seenSources.add(id);
            sourceItemIds.push(id);
          }
        }
      }
      if (entry.rawScore === null || !Number.isFinite(entry.rawScore)) {
        diagnostics.push(diag("scoring.subscale_value_missing", "fail", `subscale ${subscale.scaleCode} is not computable, so the sum cannot be formed`, subscale.scaleCode));
        outcomes.push({ term, value: null, reversed: false, included: false, contribution: null, note: "subscale raw score unavailable", missingReason: "subscale_not_computable" });
        continue;
      }
      outcomes.push({
        term,
        value: entry.rawScore,
        reversed: false,
        included: true,
        contribution: entry.rawScore,
        note: `raw score of subscale ${subscale.scaleCode}`,
        missingReason: null,
      });
    }
  } else {
    outcomes.push(...evaluateTerms(aggregateTerms(step, byCode, diagnostics), step, answersByItemId, answersByCode, diagnostics));
    for (const outcome of outcomes) {
      const id = outcome.term.itemDefinitionId;
      if (id !== null && !seenSources.has(id)) {
        seenSources.add(id);
        sourceItemIds.push(id);
      }
    }
  }

  const expected = outcomes.length;
  const used = outcomes.filter((outcome) => outcome.included).length;
  const missing = expected - used;
  const missingCodes = outcomes.filter((outcome) => !outcome.included).map((outcome) => outcome.term.code);
  const isMean = step.kind === "mean_of_items";

  // An aggregate with nothing scoreable to reference cannot produce a value.
  if (expected === 0) {
    diagnostics.push(
      diag("scoring.no_primary_value", "fail", `${step.kind} references no scorable item, so no aggregate can be formed`),
    );
  }

  // A failing diagnostic (unknown item code, missing reverse bounds, invalid
  // weight) means the declared aggregate cannot be formed at all.
  const failing = diagnostics.find((entry) => entry.severity === "fail");
  let blockedReason: ScoringDiagnosticCode | null = failing === undefined ? null : (failing.code as ScoringDiagnosticCode);

  let available: number | null = null;
  if (blockedReason === null && used > 0) {
    const included = outcomes.filter((outcome) => outcome.included && outcome.contribution !== null);
    const total = included.reduce((sum, outcome) => sum + (outcome.contribution ?? 0), 0);
    available = isMean ? total / included.length : total;
  }

  let value: number | null = null;
  let prorated = false;
  // A computable score always rests on at least one observation; minItemsRequired
  // can only raise that floor.
  const floor = Number.isInteger(minItemsRequired) && minItemsRequired > 1 ? minItemsRequired : 1;

  if (blockedReason === null) {
    if (missing > 0) {
      diagnostics.push(
        diag("scoring.incomplete_data", "warn", `${missing} of ${expected} item(s) referenced by ${step.kind} are missing: ${missingCodes.join(", ")}`),
      );
    }
    if (missingPolicy === "no_score") {
      blockedReason = "scoring.policy_no_score";
      diagnostics.push(diag("scoring.policy_no_score", "info", "missingPolicy 'no_score' forbids emitting any derived value, even from complete data"));
    } else if (missingPolicy === "strict_complete") {
      if (missing > 0) {
        blockedReason = "scoring.strict_complete_incomplete";
        diagnostics.push(
          diag(
            "scoring.strict_complete_incomplete",
            "fail",
            `missingPolicy 'strict_complete' requires every referenced item; ${missing} of ${expected} are missing: ${missingCodes.join(", ")}`,
          ),
        );
      } else {
        value = available;
      }
    } else if (used < floor) {
      const code: ScoringDiagnosticCode = used === 0 ? "scoring.no_usable_items" : "scoring.min_items_not_met";
      blockedReason = code;
      diagnostics.push(
        diag(
          code,
          "fail",
          used === 0
            ? `no usable item value is available for ${step.kind}; a score is never derived from zero observations`
            : `only ${used} usable item(s) for ${step.kind}, below minItemsRequired ${minItemsRequired}`,
        ),
      );
    } else if (missingPolicy === "prorate_if_min_met") {
      const factor = prorationFactorFor(step.kind, expected, used);
      prorated = factor !== 1;
      value = available === null ? null : available * factor;
      if (missing > 0) {
        diagnostics.push(
          diag(
            "scoring.prorated",
            "warn",
            prorated
              ? `${step.kind} computed on ${used} of ${expected} items and scaled by itemsExpected/itemsUsed = ${expected}/${used} = ${roundForDisplay(factor)}; the score is provisional`
              : `${step.kind} computed on ${used} of ${expected} items; a mean-based aggregate is not scaled because it is already an estimate of the full-item mean; the score is provisional`,
          ),
        );
      }
    } else {
      if (missing > 0) {
        diagnostics.push(
          diag(
            "scoring.partial_sum_unscaled",
            "warn",
            `missingPolicy 'sum_available_only' returns the raw sum of ${used} available item(s); it is never scaled to the ${expected}-item total and is provisional`,
          ),
        );
      }
      value = available;
    }
  }

  // The declared scaling is applied *after* proration: the constant offset is a
  // property of the scale, not of a per-item quantity.
  if (value !== null && (step.kind === "recoded_sum" || step.kind === "weighted_sum")) {
    const multiplyBy = step.multiplyBy ?? 1;
    const addConstant = step.addConstant ?? 0;
    if (!Number.isFinite(multiplyBy) || !Number.isFinite(addConstant)) {
      blockedReason = "scoring.linear_transform_invalid";
      diagnostics.push(
        diag("scoring.linear_transform_invalid", "fail", `${step.kind} declares a non-finite multiplyBy/addConstant; no value is emitted`),
      );
      value = null;
    } else if (multiplyBy !== 1 || addConstant !== 0) {
      value = value * multiplyBy + addConstant;
    }
  }

  const blockedNote = blockedReason === null ? null : `excluded: score not computable (${blockedReason})`;
  const contributions: ItemContribution[] = outcomes.map((outcome) => {
    const included = outcome.included && value !== null;
    if (included) {
      return {
        itemCode: outcome.term.code,
        value: outcome.value,
        reversed: outcome.reversed,
        contribution: outcome.contribution,
        included: true,
        ...(outcome.note === null ? {} : { note: outcome.note }),
      };
    }
    const reasonNote = outcome.note ?? `missing (${outcome.missingReason ?? "unknown"})`;
    return {
      itemCode: outcome.term.code,
      value: outcome.value,
      reversed: outcome.reversed,
      contribution: null,
      included: false,
      note: blockedNote === null ? reasonNote : `${reasonNote}; ${blockedNote}`,
    };
  });

  return {
    value,
    blockedReason,
    contributions,
    sourceItemIds,
    expected,
    used,
    missing,
    partial: missing > 0,
    prorated,
    diagnostics: dedupeDiagnostics(diagnostics),
  };
}

// -------------------------------------------------------------- transforms --

function resolveSourceValue(
  reference: string | undefined,
  chain: number | null,
  priorScales: Record<string, PriorScaleValue>,
  stepKind: string,
  diagnostics: ScoreDiagnostic[],
): number | null {
  if (reference !== undefined) {
    const prior: PriorScaleValue | undefined = priorScales[reference];
    if (prior === undefined) {
      diagnostics.push(diag("scoring.source_scale_unknown", "fail", `${stepKind} references scale ${reference}, which was not computed earlier in this session`));
      return null;
    }
    if (prior.rawScore === null || !Number.isFinite(prior.rawScore)) {
      diagnostics.push(diag("scoring.source_scale_not_computable", "fail", `${stepKind} references scale ${reference}, which is not computable`));
      return null;
    }
    return prior.rawScore;
  }
  if (chain === null) {
    diagnostics.push(
      diag("scoring.source_value_missing", "fail", `${stepKind} has no sourceRawScale/fromRawScale and no earlier step produced a value`),
    );
    return null;
  }
  return chain;
}

function selectPercentile(
  table: Array<{ atOrAbove: number; percentile: number }>,
  value: number,
): { atOrAbove: number; percentile: number } | null {
  let selected: { atOrAbove: number; percentile: number } | null = null;
  for (const entry of table) {
    if (entry.atOrAbove <= value && (selected === null || entry.atOrAbove > selected.atOrAbove)) selected = entry;
  }
  return selected;
}

function selectBand(
  bands: Array<{ max: number | null; label: string; note?: string }>,
  value: number,
): { max: number | null; label: string; note?: string } | null {
  for (const band of bands) if (band.max === null || value <= band.max) return band;
  return null;
}

// -------------------------------------------------------------- scoreScale --

/**
 * Score one scale.
 *
 * A `ComputedScore` is always returned, even when nothing is computable:
 * `computability`, `notComputableReason`, `itemsUsed/itemsMissing/itemsExpected`
 * and the full provenance are reported either way. Items that cannot carry a
 * numeric score (open_text, date) and unknown item codes never enter
 * `itemsExpected`/`contributions`, but they are always reported as diagnostics.
 */
export function scoreScale(
  spec: ScaleScoringSpec,
  items: ScorableItem[],
  answers: ScorableAnswer[],
  context: ScoreContext,
): ComputedScore {
  const clinicalUsePermitted = context.clinicalUsePermitted === true;
  const provisionalInstrument = context.provisionalInstrument === true;
  const priorScales = context.priorScales ?? {};
  const algorithm = spec.algorithm;
  const byCode = indexItemsByCode(items);
  const answersByItemId = indexAnswersByItemId(answers);
  const answersByCode = indexAnswersByCode(answers);

  const diagnostics: ScoreDiagnostic[] = validateAlgorithm(algorithm, items);
  let provisional = provisionalInstrument;

  if (provisionalInstrument) {
    diagnostics.push(
      diag("scoring.provisional_instrument", "warn", `instrument version ${spec.instrumentVersionId} is provisional: scores must not be presented as validated results`),
    );
  }
  if (spec.kind === "clinical_elevation" && !clinicalUsePermitted) {
    provisional = true;
    diagnostics.push(
      diag(
        "scoring.clinical_interpretation_blocked",
        "warn",
        `scale ${spec.scaleCode} is a clinical elevation scale but instrument version ${spec.instrumentVersionId} has clinicalUsePermitted=false: no clinical band or interpretation is emitted`,
      ),
    );
  }

  const contributions: ItemContribution[] = [];
  const sourceItemIds: string[] = [];
  const seenSourceIds = new Set<string>();
  let itemsExpected = 0;
  let itemsUsed = 0;
  let chain: number | null = null;
  let rawScore: number | null = null;
  let transformedScore: number | null = null;
  let standardizedScore: number | null = null;
  let percentile: number | null = null;
  let bandLabel: string | null = null;
  let bandNote: string | null = null;
  let primaryDeclared = false;
  let primaryValue: number | null = null;
  let primaryBlockedReason: string | null = null;
  let multipleAggregatesWarned = false;

  const steps = Array.isArray(algorithm.steps) ? algorithm.steps : [];

  for (const step of steps) {
    if (!STEP_KINDS.has(step.kind)) {
      diagnostics.push(diag("scoring.unknown_step_kind", "fail", `step kind ${JSON.stringify((step as { kind?: unknown }).kind)} is not supported`));
      continue;
    }

    if (AGGREGATE_STEP_KINDS.has(step.kind)) {
      if (primaryDeclared && !multipleAggregatesWarned) {
        multipleAggregatesWarned = true;
        diagnostics.push(
          diag(
            "scoring.multiple_aggregate_steps",
            "warn",
            `the algorithm declares more than one aggregate step; the first one supplies rawScore, contributions and item counts, later aggregates only update the pipeline value`,
          ),
        );
      }
      const outcome = runAggregateStep(step, algorithm.missingPolicy, algorithm.minItemsRequired, byCode, answersByItemId, answersByCode, priorScales);
      diagnostics.push(...outcome.diagnostics);
      if (!primaryDeclared) {
        primaryDeclared = true;
        contributions.push(...outcome.contributions);
        for (const id of outcome.sourceItemIds) {
          if (!seenSourceIds.has(id)) {
            seenSourceIds.add(id);
            sourceItemIds.push(id);
          }
        }
        itemsExpected = outcome.expected;
        itemsUsed = outcome.used;
        primaryValue = outcome.value;
        primaryBlockedReason = outcome.value === null ? outcome.blockedReason : null;
        rawScore = outcome.value;
      }
      if (outcome.partial) provisional = true;
      if (outcome.value !== null) chain = outcome.value;
      continue;
    }

    const stepDiagnostics: ScoreDiagnostic[] = [];

    if (step.kind === "linear_transform") {
      const source = resolveSourceValue(step.fromRawScale, chain, priorScales, "linear_transform", stepDiagnostics);
      if (source !== null) {
        if (!Number.isFinite(step.multiplyBy) || !Number.isFinite(step.addConstant)) {
          stepDiagnostics.push(diag("scoring.linear_transform_invalid", "fail", "linear_transform needs a finite multiplyBy and addConstant"));
        } else {
          chain = source * step.multiplyBy + step.addConstant;
          transformedScore = chain;
        }
      }
    } else if (step.kind === "z_score") {
      const source = resolveSourceValue(step.sourceRawScale, chain, priorScales, "z_score", stepDiagnostics);
      if (source !== null) {
        if (!Number.isFinite(step.mean) || !Number.isFinite(step.sd) || step.sd <= 0) {
          stepDiagnostics.push(diag("scoring.z_score_sd_invalid", "fail", "z_score needs a finite mean and sd > 0; no standard score is emitted"));
        } else {
          standardizedScore = (source - step.mean) / step.sd;
        }
      }
    } else if (step.kind === "percentile_lookup") {
      const source = resolveSourceValue(step.sourceRawScale, chain, priorScales, "percentile_lookup", stepDiagnostics);
      if (source !== null) {
        if (step.table.length === 0) {
          stepDiagnostics.push(diag("scoring.percentile_table_empty", "fail", "percentile_lookup declares an empty table; no percentile is emitted"));
        } else if (!isStrictlyIncreasing(step.table.map((entry) => entry.atOrAbove))) {
          stepDiagnostics.push(
            diag("scoring.percentile_table_not_monotonic", "fail", "percentile_lookup table is not strictly increasing in atOrAbove; no percentile is emitted"),
          );
        } else {
          const entry = selectPercentile(step.table, source);
          if (entry === null) {
            const lowest = step.table[0]?.atOrAbove ?? "n/a";
            stepDiagnostics.push(
              diag(
                "scoring.percentile_below_table",
                "warn",
                `observed value ${source} is below the lowest table entry (atOrAbove ${lowest}); no percentile is extrapolated`,
              ),
            );
          } else if (entry.percentile < 0 || entry.percentile > 100) {
            stepDiagnostics.push(
              diag("scoring.percentile_out_of_range", "warn", `table entry ${entry.atOrAbove} declares percentile ${entry.percentile} outside 0..100; it is not used`),
            );
          } else {
            percentile = entry.percentile;
          }
        }
      }
    } else if (step.kind === "band_lookup") {
      const source = resolveSourceValue(step.sourceRawScale, chain, priorScales, "band_lookup", stepDiagnostics);
      if (source !== null) {
        if (step.bands.length === 0) {
          stepDiagnostics.push(diag("scoring.bands_empty", "fail", "band_lookup declares no bands; no band is emitted"));
        } else {
          const band = selectBand(step.bands, source);
          if (band === null) {
            stepDiagnostics.push(diag("scoring.band_not_matched", "warn", `observed value ${source} falls outside every declared band; no band is invented`));
          } else if (band.label.trim() === "") {
            stepDiagnostics.push(diag("scoring.band_label_missing", "fail", "the matched band has an empty label; no band is emitted"));
          } else if (spec.kind === "clinical_elevation" && !clinicalUsePermitted) {
            stepDiagnostics.push(
              diag(
                "scoring.clinical_band_suppressed",
                "warn",
                `band '${band.label}' is suppressed: scale ${spec.scaleCode} is clinical but instrument version ${spec.instrumentVersionId} has clinicalUsePermitted=false`,
              ),
            );
          } else {
            bandLabel = band.label;
            bandNote = band.note ?? null;
          }
        }
      }
    }

    diagnostics.push(...stepDiagnostics);
  }

  if (!primaryDeclared) {
    primaryValue = transformedScore ?? standardizedScore ?? percentile;
    if (primaryValue === null && bandLabel === null) primaryBlockedReason = "scoring.no_primary_value";
  }

  const itemsMissing = itemsExpected - itemsUsed;
  const computable = primaryValue !== null;
  const notComputableReason = computable
    ? null
    : primaryBlockedReason === null
      ? `scoring.no_primary_value: the declared algorithm produced no score for scale ${spec.scaleCode}`
      : `${primaryBlockedReason}: no score was produced for scale ${spec.scaleCode}`;

  const requiredMissing = contributions.filter((entry) => byCode.get(entry.itemCode)?.isRequired === true && !entry.included);
  if (requiredMissing.length > 0) {
    diagnostics.push(
      diag(
        "scoring.required_item_missing",
        "warn",
        `${requiredMissing.length} item(s) marked required are missing from scale ${spec.scaleCode}: ${requiredMissing.map((entry) => entry.itemCode).join(", ")}`,
      ),
    );
  }
  if (itemsMissing > 0) provisional = true;

  return {
    scaleCode: spec.scaleCode,
    computability: computable ? "computed" : "not_computable",
    notComputableReason,
    rawScore: computable ? rawScore : null,
    transformedScore: computable ? transformedScore : null,
    standardizedScore: computable ? standardizedScore : null,
    percentile: computable ? percentile : null,
    bandLabel: computable ? bandLabel : null,
    bandNote: computable ? bandNote : null,
    itemsUsed,
    itemsMissing,
    itemsExpected,
    sourceItemIds,
    contributions,
    algorithmVersion: algorithm.algorithmVersion,
    diagnostics: dedupeDiagnostics(diagnostics),
    methodologicallyProvisional: provisional,
  };
}

// ------------------------------------------------------------ scoreSession --

function coverageStatus(item: ScorableItem, answer: ScorableAnswer | null): { answered: boolean; reason: string | null } {
  if (answer !== null && !answer.isMissing) {
    if (!isNumericallyScorable(item.responseType)) return { answered: true, reason: null };
    const resolution = resolveValue(item, answer);
    return resolution.ok ? { answered: true, reason: null } : { answered: false, reason: resolution.reason };
  }
  if (answer === null) return { answered: false, reason: "not_collected" };
  return { answered: false, reason: answer.missingReason ?? "flagged_missing" };
}

/**
 * Score every scale of one assessment session and report session coverage.
 *
 * Scales are evaluated in declaration order, so a scale that consumes another
 * scale (`subscale_sum`, `fromRawScale`, `sourceRawScale`) must be declared after
 * the scale it consumes. Coverage counts an item as answered when a usable
 * observation exists; non-numeric or out-of-range values are reported as missing
 * with their reason instead of being coerced.
 */
export function scoreSession(input: SessionScoringInput): SessionScoringResult {
  const sessionDiagnostics: ScoreDiagnostic[] = [];
  const items = Array.isArray(input.items) ? input.items : [];
  const answers = Array.isArray(input.answers) ? input.answers : [];
  const answersByItemId = indexAnswersByItemId(answers);
  const answersByCode = indexAnswersByCode(answers);

  const seenCodes = new Set<string>();
  for (const item of items) {
    if (seenCodes.has(item.itemCode)) {
      sessionDiagnostics.push(
        diag("scoring.duplicate_item_code", "warn", `item code ${item.itemCode} appears more than once in this instrument version; the first definition is used`, item.itemCode),
      );
    }
    seenCodes.add(item.itemCode);
  }

  const knownItemIds = new Set(items.map((item) => item.itemDefinitionId));
  for (const answer of answers) {
    if (knownItemIds.has(answer.itemDefinitionId)) continue;
    sessionDiagnostics.push(
      diag("scoring.answer_without_item", "warn", `observed answer for ${answer.itemCode} has no matching item definition in this instrument version`, answer.itemCode),
    );
  }

  const missingByReason: Record<string, number> = {};
  let answeredItems = 0;
  for (const item of items) {
    const status = coverageStatus(item, answerFor(item, answersByItemId, answersByCode));
    if (status.answered) {
      answeredItems += 1;
      continue;
    }
    const reason = status.reason ?? "unknown";
    missingByReason[reason] = (missingByReason[reason] ?? 0) + 1;
    if (reason === "value_not_numeric" || reason === "value_out_of_range") {
      sessionDiagnostics.push(
        diag(
          reason === "value_not_numeric" ? "scoring.value_not_numeric" : "scoring.value_out_of_range",
          "warn",
          `item ${item.itemCode} is counted as missing (${reason}); the recorded value is never coerced into range`,
          item.itemCode,
        ),
      );
    }
  }

  for (const item of items) {
    if (item.responseType === "open_text") {
      sessionDiagnostics.push(
        diag("scoring.open_text_items_excluded", "info", `open_text item ${item.itemCode} is excluded from numeric scoring and never contributes to a scale`, item.itemCode),
      );
    } else if (item.responseType === "date") {
      sessionDiagnostics.push(diag("scoring.item_not_scorable", "info", `date item ${item.itemCode} cannot carry a numeric score and is excluded`, item.itemCode));
    }
  }

  const scores: ComputedScore[] = [];
  const priorScales: Record<string, PriorScaleValue> = {};
  const seenScaleCodes = new Set<string>();
  for (const spec of input.scales) {
    if (seenScaleCodes.has(spec.scaleCode)) {
      sessionDiagnostics.push(diag("scoring.duplicate_scale_code", "warn", `scale code ${spec.scaleCode} is scored more than once in this session`, spec.scaleCode));
    }
    seenScaleCodes.add(spec.scaleCode);
    const score = scoreScale(spec, items, answers, {
      clinicalUsePermitted: input.clinicalUsePermitted === true,
      provisionalInstrument: input.provisionalInstrument === true,
      priorScales,
    });
    scores.push(score);
    priorScales[spec.scaleCode] = { rawScore: score.rawScore, sourceItemIds: [...score.sourceItemIds] };
    const failures = score.diagnostics.filter((entry) => entry.severity === "fail");
    if (failures.length > 0) {
      sessionDiagnostics.push(
        diag(
          "scoring.scale_algorithm_invalid",
          "fail",
          `scale ${spec.scaleCode} reported ${failures.length} failing algorithm diagnostic(s): ${[...new Set(failures.map((entry) => entry.code))].join(", ")}`,
        ),
      );
    }
  }

  return {
    assessmentSessionId: input.assessmentSessionId,
    scores,
    sessionDiagnostics: dedupeDiagnostics(sessionDiagnostics),
    coverage: {
      totalItems: items.length,
      answeredItems,
      missingItems: items.length - answeredItems,
      missingByReason,
      completenessRatio: items.length === 0 ? 0 : answeredItems / items.length,
    },
  };
}
