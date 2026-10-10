/**
 * Unit tests for the psychometric scoring engine (lib/domain/scoring.ts).
 *
 * Every assertion here is also a methodological statement: missing values are
 * never imputed, reverse-keying is `min + max - value`, proration is declared and
 * reported, and a clinical scale without clinical-use permission never yields a
 * band.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../lib/domain/types.ts";
import type {
  ComputedScore,
  ItemContribution,
  ScaleScoringSpec,
  ScorableAnswer,
  ScorableItem,
  ScoreAlgorithmDefinition,
  ScoreDiagnostic,
  SessionScoringInput,
} from "../../lib/domain/types.ts";
import {
  isNumericallyScorable,
  parseAlgorithm,
  prorationFactorFor,
  roundForDisplay,
  scoreScale,
  scoreSession,
  validateAlgorithm,
} from "../../lib/domain/scoring.ts";

// ------------------------------------------------------------------ fixtures --

function item(partial: Partial<ScorableItem> & { itemCode: string }): ScorableItem {
  return {
    itemDefinitionId: partial.itemDefinitionId ?? `id-${partial.itemCode}`,
    itemCode: partial.itemCode,
    orderIndex: partial.orderIndex ?? (Number.parseInt(partial.itemCode, 10) || 0),
    responseType: partial.responseType ?? "likert",
    minValue: partial.minValue === undefined ? 1 : partial.minValue,
    maxValue: partial.maxValue === undefined ? 7 : partial.maxValue,
    reverseScored: partial.reverseScored ?? false,
    isRequired: partial.isRequired ?? true,
  };
}

function answer(itemCode: string, valueNumeric: number | null, overrides: Partial<ScorableAnswer> = {}): ScorableAnswer {
  const isMissing = overrides.isMissing ?? valueNumeric === null;
  return {
    itemDefinitionId: overrides.itemDefinitionId ?? `id-${itemCode}`,
    itemCode,
    valueNumeric,
    valueCoded: overrides.valueCoded ?? null,
    rawValueText: overrides.rawValueText ?? (valueNumeric === null ? "" : String(valueNumeric)),
    isMissing,
    missingReason: overrides.missingReason ?? null,
  };
}

function likertItems(...codes: string[]): ScorableItem[] {
  return codes.map((code) => item({ itemCode: code }));
}

function algorithm(partial: Partial<ScoreAlgorithmDefinition> = {}): ScoreAlgorithmDefinition {
  return {
    algorithmVersion: "1.0.0",
    steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03"] }],
    missingPolicy: "strict_complete",
    minItemsRequired: 3,
    ...partial,
  };
}

function scale(partial: Partial<ScaleScoringSpec> & { algorithm: ScoreAlgorithmDefinition }): ScaleScoringSpec {
  return {
    scaleDefinitionId: "sd-1",
    scaleCode: "TOT",
    scaleTitle: "Total",
    kind: "raw_sum",
    instrumentVersionId: "iv-1",
    itemCodes: ["01", "02", "03"],
    algorithmId: "sa-1",
    ...partial,
  };
}

const OPEN_CONTEXT = { clinicalUsePermitted: true, provisionalInstrument: false };

function has(diagnostics: ScoreDiagnostic[], code: string, severity?: ScoreDiagnostic["severity"]): boolean {
  return diagnostics.some((entry) => entry.code === code && (severity === undefined || entry.severity === severity));
}

function contribution(score: ComputedScore, itemCode: string): ItemContribution {
  const found = score.contributions.find((entry) => entry.itemCode === itemCode);
  assert.ok(found, `expected a contribution row for item ${itemCode}`);
  return found;
}

function session(partial: Partial<SessionScoringInput> & { items: ScorableItem[]; scales: ScaleScoringSpec[] }): SessionScoringInput {
  return {
    assessmentSessionId: "as-1",
    instrumentVersionId: "iv-1",
    instrumentTitle: "Demo inventory",
    clinicalUsePermitted: true,
    provisionalInstrument: false,
    answers: [],
    ...partial,
  };
}

// ------------------------------------------------------------------ helpers --

test("roundForDisplay rounds only for display and never leaks -0", () => {
  assert.equal(roundForDisplay(8 / 3), 2.6667);
  assert.equal(roundForDisplay(2), 2);
  assert.equal(roundForDisplay(0.00004), 0);
  assert.equal(Object.is(roundForDisplay(-0.00001), 0), true, "-0 must normalize to 0");
  assert.equal(roundForDisplay(1.23456, 2), 1.23);
  assert.equal(Number.isNaN(roundForDisplay(Number.NaN)), true);
});

test("prorationFactorFor scales sum-family aggregates and leaves means alone", () => {
  assert.equal(prorationFactorFor("recoded_sum", 4, 3), 4 / 3);
  assert.equal(prorationFactorFor("weighted_sum", 5, 2), 2.5);
  assert.equal(prorationFactorFor("subscale_sum", 2, 1), 2);
  assert.equal(prorationFactorFor("mean_of_items", 4, 3), 1);
  assert.equal(prorationFactorFor("recoded_sum", 3, 3), 1);
  assert.equal(prorationFactorFor("recoded_sum", 3, 0), 1);
});

test("response types that can never carry a numeric score are excluded", () => {
  assert.equal(isNumericallyScorable("likert"), true);
  assert.equal(isNumericallyScorable("yes_no"), true);
  assert.equal(isNumericallyScorable("numeric"), true);
  assert.equal(isNumericallyScorable("open_text"), false);
  assert.equal(isNumericallyScorable("date"), false);
});

// ------------------------------------------------------------- aggregation --

test("reverse-keyed sum uses min + max - value and reports it per item", () => {
  const items = [
    item({ itemCode: "01" }),
    item({ itemCode: "02" }),
    item({ itemCode: "03", reverseScored: true }),
    item({ itemCode: "04" }),
  ];
  const answers = [answer("01", 5), answer("02", 6), answer("03", 2), answer("04", 4)];
  const result = scoreScale(
    scale({ algorithm: algorithm({ steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03", "04"], reverseItemCodes: ["03"] }] }) }),
    items,
    answers,
    OPEN_CONTEXT,
  );

  assert.equal(result.computability, "computed");
  assert.equal(result.rawScore, 21, "5 + 6 + (1+7-2) + 4");
  assert.equal(result.algorithmVersion, "1.0.0");
  assert.equal(result.itemsExpected, 4);
  assert.equal(result.itemsUsed, 4);
  assert.equal(result.itemsMissing, 0);
  assert.equal(result.methodologicallyProvisional, false);
  assert.deepEqual(result.sourceItemIds, ["id-01", "id-02", "id-03", "id-04"]);

  const reversed = contribution(result, "03");
  assert.equal(reversed.value, 2, "the observed value is kept verbatim");
  assert.equal(reversed.reversed, true);
  assert.equal(reversed.contribution, 6);
  assert.equal(reversed.included, true);
  assert.match(reversed.note ?? "", /1 \+ 7 - 2 = 6/);
  assert.equal(contribution(result, "01").reversed, false);
  assert.equal(contribution(result, "01").contribution, 5);
  assert.equal(
    result.contributions.reduce((sum, entry) => sum + (entry.contribution ?? 0), 0),
    result.rawScore,
    "contributions must sum to the raw score",
  );
});

test("step-level reverseKey overrides item bounds and multiplyBy/addConstant applies after recoding", () => {
  const items = [item({ itemCode: "A", minValue: 0, maxValue: 4 }), item({ itemCode: "B", minValue: 0, maxValue: 4 })];
  const answers = [answer("A", 3), answer("B", 1)];
  const result = scoreScale(
    scale({
      scaleCode: "LIN",
      algorithm: algorithm({
        steps: [
          {
            kind: "recoded_sum",
            itemCodes: ["A", "B"],
            reverseItemCodes: ["B"],
            reverseKey: { min: 0, max: 4 },
            multiplyBy: 2,
            addConstant: 1,
          },
        ],
      }),
    }),
    items,
    answers,
    OPEN_CONTEXT,
  );

  assert.equal(result.rawScore, (3 + (0 + 4 - 1)) * 2 + 1, "recoded sum 6, then 2x + 1");
  assert.equal(result.rawScore, 13);
  assert.equal(contribution(result, "B").contribution, 3);
  assert.match(contribution(result, "B").note ?? "", /0 \+ 4 - 1 = 3/);
});

test("weighted_sum applies signed weights and reports inclusion", () => {
  const items = likertItems("01", "02", "03");
  const answers = [answer("01", 4), answer("02", 5), answer("03", 6)];
  const result = scoreScale(
    scale({
      scaleCode: "W",
      kind: "weighted_sum",
      algorithm: algorithm({
        steps: [
          {
            kind: "weighted_sum",
            weights: [
              { itemCode: "01", weight: 2 },
              { itemCode: "02", weight: 1 },
              { itemCode: "03", weight: -1, reverse: true },
            ],
          },
        ],
      }),
    }),
    items,
    answers,
    OPEN_CONTEXT,
  );

  assert.equal(result.rawScore, 2 * 4 + 5 + -1 * (1 + 7 - 6));
  assert.equal(result.rawScore, 11);
  assert.equal(contribution(result, "01").contribution, 8);
  assert.equal(contribution(result, "03").reversed, true);
  assert.equal(contribution(result, "03").value, 6);
  assert.equal(contribution(result, "03").contribution, -2);
});

test("mean_of_items averages reversed terms and keeps full precision", () => {
  const items = [item({ itemCode: "01" }), item({ itemCode: "02" }), item({ itemCode: "03", reverseScored: true })];
  const answers = [answer("01", 2), answer("02", 4), answer("03", 6)];
  const result = scoreScale(
    scale({
      scaleCode: "MEAN",
      kind: "mean",
      algorithm: algorithm({ steps: [{ kind: "mean_of_items", itemCodes: ["01", "02", "03"] }] }),
    }),
    items,
    answers,
    OPEN_CONTEXT,
  );

  assert.equal(result.rawScore, (2 + 4 + (1 + 7 - 6)) / 3);
  assert.equal(result.rawScore, 8 / 3);
  assert.notEqual(result.rawScore, roundForDisplay(8 / 3), "stored scores keep full precision");
  assert.equal(result.itemsUsed, 3);
});

test("subscale_sum consumes earlier scale raw scores and chains their provenance", () => {
  const spec = scale({
    scaleCode: "TOTAL",
    algorithm: algorithm({
      missingPolicy: "strict_complete",
      minItemsRequired: 2,
      steps: [{ kind: "subscale_sum", subscales: [{ scaleCode: "A" }, { scaleCode: "B" }] }],
    }),
  });
  const result = scoreScale(spec, [], [], {
    ...OPEN_CONTEXT,
    priorScales: {
      A: { rawScore: 10, sourceItemIds: ["id-01", "id-02"] },
      B: { rawScore: 5, sourceItemIds: ["id-03"] },
    },
  });

  assert.equal(result.computability, "computed");
  assert.equal(result.rawScore, 15);
  assert.equal(result.itemsExpected, 2);
  assert.equal(result.itemsUsed, 2);
  assert.deepEqual(result.sourceItemIds, ["id-01", "id-02", "id-03"]);
  assert.equal(contribution(result, "A").contribution, 10);
  assert.equal(contribution(result, "B").contribution, 5);

  const missingSubscale = scoreScale(spec, [], [], {
    ...OPEN_CONTEXT,
    priorScales: { A: { rawScore: 10, sourceItemIds: ["id-01"] } },
  });
  assert.equal(missingSubscale.computability, "not_computable");
  assert.ok(has(missingSubscale.diagnostics, "scoring.subscale_value_missing", "fail"));
  assert.match(missingSubscale.notComputableReason ?? "", /scoring\.subscale_value_missing/);
  assert.equal(missingSubscale.itemsMissing, 1);
});

test("linear_transform chains on the previous step value and can read a named scale", () => {
  const items = likertItems("01", "02");
  const answers = [answer("01", 3), answer("02", 4)];
  const chained = scoreScale(
    scale({
      scaleCode: "T",
      algorithm: algorithm({
        minItemsRequired: 2,
        steps: [
          { kind: "recoded_sum", itemCodes: ["01", "02"] },
          { kind: "linear_transform", multiplyBy: 2, addConstant: 10 },
        ],
      }),
    }),
    items,
    answers,
    OPEN_CONTEXT,
  );
  assert.equal(chained.rawScore, 7);
  assert.equal(chained.transformedScore, 24);

  const referenced = scoreScale(
    scale({
      scaleCode: "R",
      algorithm: algorithm({
        minItemsRequired: 0,
        steps: [{ kind: "linear_transform", fromRawScale: "RAW", multiplyBy: 0.5, addConstant: 0 }],
      }),
    }),
    [],
    [],
    { ...OPEN_CONTEXT, priorScales: { RAW: { rawScore: 50 } } },
  );
  assert.equal(referenced.computability, "computed");
  assert.equal(referenced.rawScore, null, "no item-level aggregate was declared");
  assert.equal(referenced.transformedScore, 25);
  assert.equal(referenced.itemsExpected, 0);

  const unknownSource = scoreScale(
    scale({
      scaleCode: "U",
      algorithm: algorithm({
        minItemsRequired: 0,
        steps: [{ kind: "linear_transform", fromRawScale: "NOPE", multiplyBy: 1, addConstant: 0 }],
      }),
    }),
    [],
    [],
    OPEN_CONTEXT,
  );
  assert.equal(unknownSource.computability, "not_computable");
  assert.ok(has(unknownSource.diagnostics, "scoring.source_scale_unknown", "fail"));
});

test("z_score standardizes the raw score and refuses sd <= 0", () => {
  const items = likertItems("01", "02", "03");
  const answers = [answer("01", 4), answer("02", 4), answer("03", 4)];
  const result = scoreScale(
    scale({
      scaleCode: "Z",
      algorithm: algorithm({
        steps: [
          { kind: "recoded_sum", itemCodes: ["01", "02", "03"] },
          { kind: "z_score", mean: 10, sd: 2 },
        ],
      }),
    }),
    items,
    answers,
    OPEN_CONTEXT,
  );
  assert.equal(result.rawScore, 12);
  assert.equal(result.standardizedScore, (12 - 10) / 2);
  assert.equal(result.standardizedScore, 1);

  const broken = scoreScale(
    scale({
      scaleCode: "ZB",
      algorithm: algorithm({
        steps: [
          { kind: "recoded_sum", itemCodes: ["01", "02", "03"] },
          { kind: "z_score", mean: 10, sd: 0 },
        ],
      }),
    }),
    items,
    answers,
    OPEN_CONTEXT,
  );
  assert.equal(broken.computability, "computed", "the valid raw score is not discarded");
  assert.equal(broken.standardizedScore, null);
  assert.ok(has(broken.diagnostics, "scoring.z_score_sd_invalid", "fail"));
});

test("percentile_lookup interpolates nothing: exact table steps or no percentile", () => {
  const items = likertItems("01", "02", "03");
  const table = [
    { atOrAbove: 0, percentile: 10 },
    { atOrAbove: 10, percentile: 50 },
    { atOrAbove: 20, percentile: 90 },
  ];
  const run = (values: [number, number, number]) =>
    scoreScale(
      scale({
        scaleCode: "P",
        algorithm: algorithm({
          steps: [
            { kind: "recoded_sum", itemCodes: ["01", "02", "03"] },
            { kind: "percentile_lookup", table },
          ],
        }),
      }),
      items,
      [answer("01", values[0]), answer("02", values[1]), answer("03", values[2])],
      OPEN_CONTEXT,
    );

  assert.equal(run([4, 4, 4]).percentile, 50, "raw 12 sits at the atOrAbove=10 step");
  assert.equal(run([1, 1, 3]).percentile, 10, "raw 5 sits at the atOrAbove=0 step");
  assert.equal(run([2, 2, 2]).percentile, 10, "raw 6 is still at the lowest step");

  const shortTable = scoreScale(
    scale({
      scaleCode: "P2",
      algorithm: algorithm({
        steps: [
          { kind: "recoded_sum", itemCodes: ["01", "02", "03"] },
          { kind: "percentile_lookup", table: [{ atOrAbove: 10, percentile: 50 }] },
        ],
      }),
    }),
    items,
    [answer("01", 2), answer("02", 2), answer("03", 2)],
    OPEN_CONTEXT,
  );
  assert.equal(shortTable.computability, "computed");
  assert.equal(shortTable.percentile, null, "no percentile is extrapolated below the table");
  assert.ok(has(shortTable.diagnostics, "scoring.percentile_below_table", "warn"));
});

test("band_lookup selects a declared band and never invents one", () => {
  const items = likertItems("01", "02", "03");
  const bands = [
    { max: 5, label: "Low" },
    { max: 10, label: "Moderate", note: "monitor" },
    { max: null, label: "High" },
  ];
  const run = (values: [number, number, number]) =>
    scoreScale(
      scale({
        scaleCode: "B",
        algorithm: algorithm({
          steps: [
            { kind: "recoded_sum", itemCodes: ["01", "02", "03"] },
            { kind: "band_lookup", bands },
          ],
        }),
      }),
      items,
      [answer("01", values[0]), answer("02", values[1]), answer("03", values[2])],
      OPEN_CONTEXT,
    );

  assert.equal(run([1, 1, 1]).bandLabel, "Low");
  assert.equal(run([1, 1, 1]).bandNote, null);
  assert.equal(run([2, 2, 3]).bandLabel, "Moderate");
  assert.equal(run([2, 2, 3]).bandNote, "monitor");
  assert.equal(run([7, 7, 7]).bandLabel, "High", "the open-ended band catches the top");

  // Research bands on a non-clinical scale are still reported; the clinical guard
  // is asserted separately below.
  const researchBand = scoreScale(
    scale({
      scaleCode: "BR",
      algorithm: algorithm({
        steps: [
          { kind: "recoded_sum", itemCodes: ["01", "02", "03"] },
          { kind: "band_lookup", bands },
        ],
      }),
    }),
    items,
    [answer("01", 1), answer("02", 1), answer("03", 1)],
    { clinicalUsePermitted: false, provisionalInstrument: false },
  );
  assert.equal(researchBand.bandLabel, "Low");

  const unmatched = scoreScale(
    scale({
      scaleCode: "BN",
      algorithm: algorithm({
        steps: [
          { kind: "recoded_sum", itemCodes: ["01", "02", "03"] },
          { kind: "band_lookup", bands: [{ max: 3, label: "Only" }] },
        ],
      }),
    }),
    items,
    [answer("01", 7), answer("02", 7), answer("03", 7)],
    OPEN_CONTEXT,
  );
  assert.equal(unmatched.bandLabel, null);
  assert.ok(has(unmatched.diagnostics, "scoring.band_not_matched", "warn"));
});

// ----------------------------------------------------------- missing policy --

const FOUR_ITEM_ALGORITHM = {
  steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03", "04"] }] as ScoreAlgorithmDefinition["steps"],
};

function fourItemRun(missingPolicy: ScoreAlgorithmDefinition["missingPolicy"], minItemsRequired: number) {
  return scoreScale(
    scale({
      scaleCode: `T-${missingPolicy}`,
      algorithm: algorithm({ ...FOUR_ITEM_ALGORITHM, missingPolicy, minItemsRequired }),
    }),
    likertItems("01", "02", "03", "04"),
    [answer("01", 5), answer("02", 6), answer("03", 4), answer("04", null, { missingReason: "not_administered" })],
    OPEN_CONTEXT,
  );
}

test("strict_complete refuses any partial data and reports the reason and counts", () => {
  const result = fourItemRun("strict_complete", 4);
  assert.equal(result.computability, "not_computable");
  assert.equal(result.rawScore, null);
  assert.equal(result.itemsExpected, 4);
  assert.equal(result.itemsUsed, 3);
  assert.equal(result.itemsMissing, 1);
  assert.match(result.notComputableReason ?? "", /strict_complete_incomplete/);
  assert.ok(has(result.diagnostics, "scoring.strict_complete_incomplete", "fail"));
  assert.ok(has(result.diagnostics, "scoring.incomplete_data", "warn"));
  assert.equal(result.contributions.length, 4, "every referenced item stays auditable");
  assert.equal(contribution(result, "01").value, 5);
  assert.equal(contribution(result, "01").included, false, "nothing enters an uncomputable score");
  assert.equal(contribution(result, "01").contribution, null);
  assert.match(contribution(result, "04").note ?? "", /not_administered/);
  assert.equal(result.methodologicallyProvisional, true, "partial data must be flagged provisional");
  assert.deepEqual(result.sourceItemIds, ["id-01", "id-02", "id-03", "id-04"]);
});

test("prorate_if_min_met spends expected/used once the minimum is met", () => {
  const result = fourItemRun("prorate_if_min_met", 3);
  assert.equal(result.computability, "computed");
  assert.equal(result.itemsUsed, 3);
  assert.equal(result.itemsMissing, 1);
  assert.equal(result.itemsExpected, 4);
  assert.equal(result.rawScore, 15 * (4 / 3), "raw sum of available items scaled by itemsExpected/itemsUsed");
  assert.equal(roundForDisplay(result.rawScore ?? 0), 20);
  assert.ok(result.methodologicallyProvisional, "a prorated score is provisional");
  assert.equal(contribution(result, "01").contribution, 5, "contributions stay unscaled so the proration is auditable");
  assert.equal(contribution(result, "03").contribution, 4);
  assert.equal(contribution(result, "04").contribution, null);
  assert.ok(has(result.diagnostics, "scoring.prorated", "warn"));
  assert.deepEqual(result.sourceItemIds, ["id-01", "id-02", "id-03", "id-04"]);
});

test("prorate_if_min_met refuses to score below minItemsRequired or with zero observations", () => {
  const belowMinimum = fourItemRun("prorate_if_min_met", 4);
  assert.equal(belowMinimum.computability, "not_computable");
  assert.match(belowMinimum.notComputableReason ?? "", /min_items_not_met/);
  assert.ok(has(belowMinimum.diagnostics, "scoring.min_items_not_met", "fail"));

  const empty = scoreScale(
    scale({ algorithm: algorithm({ ...FOUR_ITEM_ALGORITHM, missingPolicy: "prorate_if_min_met", minItemsRequired: 1 }) }),
    likertItems("01", "02", "03", "04"),
    [],
    OPEN_CONTEXT,
  );
  assert.equal(empty.computability, "not_computable");
  assert.equal(empty.rawScore, null);
  assert.equal(empty.itemsUsed, 0);
  assert.equal(empty.itemsMissing, 4);
  assert.match(empty.notComputableReason ?? "", /no_usable_items/);
  assert.equal(empty.contributions.every((entry) => entry.included === false), true);
});

test("proration leaves mean_of_items unscaled because the mean is already expectation-preserving", () => {
  const result = scoreScale(
    scale({
      scaleCode: "MP",
      kind: "mean",
      algorithm: algorithm({
        ...FOUR_ITEM_ALGORITHM,
        steps: [{ kind: "mean_of_items", itemCodes: ["01", "02", "03", "04"] }],
        missingPolicy: "prorate_if_min_met",
        minItemsRequired: 3,
      }),
    }),
    likertItems("01", "02", "03", "04"),
    [answer("01", 4), answer("02", 6), answer("03", 5), answer("04", null, { missingReason: "skipped" })],
    OPEN_CONTEXT,
  );
  assert.equal(result.computability, "computed");
  assert.equal(result.rawScore, 5, "mean of the three available items, not 5 * 4/3");
  assert.equal(result.itemsMissing, 1);
  assert.equal(result.methodologicallyProvisional, true);
  assert.ok(has(result.diagnostics, "scoring.prorated", "warn"));
  assert.match(
    result.diagnostics.find((entry) => entry.code === "scoring.prorated")?.message ?? "",
    /mean-based aggregate is not scaled/,
  );
});

test("sum_available_only sums what exists, never scales, and records the reason", () => {
  const result = fourItemRun("sum_available_only", 1);
  assert.equal(result.computability, "computed");
  assert.equal(result.rawScore, 15, "raw sum of the available items");
  assert.equal(result.itemsMissing, 1);
  assert.equal(result.methodologicallyProvisional, true);
  assert.ok(has(result.diagnostics, "scoring.partial_sum_unscaled", "warn"));
  assert.match(
    result.diagnostics.find((entry) => entry.code === "scoring.partial_sum_unscaled")?.message ?? "",
    /never scaled to the 4-item total/,
  );
  assert.equal(result.contributions.filter((entry) => entry.included).length, 3);

  const tooFew = fourItemRun("sum_available_only", 4);
  assert.equal(tooFew.computability, "not_computable");
  assert.match(tooFew.notComputableReason ?? "", /min_items_not_met/);
});

test("no_score never emits a value, even from complete data", () => {
  const complete = scoreScale(
    scale({ algorithm: algorithm({ ...FOUR_ITEM_ALGORITHM, missingPolicy: "no_score", minItemsRequired: 4 }) }),
    likertItems("01", "02", "03", "04"),
    [answer("01", 5), answer("02", 6), answer("03", 4), answer("04", 7)],
    OPEN_CONTEXT,
  );
  assert.equal(complete.computability, "not_computable");
  assert.equal(complete.rawScore, null);
  assert.equal(complete.transformedScore, null);
  assert.equal(complete.percentile, null);
  assert.equal(complete.bandLabel, null);
  assert.equal(complete.itemsUsed, 4);
  assert.equal(complete.itemsMissing, 0);
  assert.match(complete.notComputableReason ?? "", /policy_no_score/);
  assert.ok(has(complete.diagnostics, "scoring.policy_no_score", "info"));
  assert.equal(complete.contributions.every((entry) => entry.included === false), true);
  assert.equal(complete.methodologicallyProvisional, false, "a disabled policy is not a data problem");
});

// ----------------------------------------------------------- data integrity --

test("out-of-range and non-numeric values are treated as missing, never clamped", () => {
  const items = likertItems("01", "02", "03");
  const answers = [
    answer("01", 9, { isMissing: false }),
    answer("02", null, { isMissing: false, rawValueText: "not a number" }),
    answer("03", 4),
  ];
  const result = scoreScale(
    scale({ algorithm: algorithm({ missingPolicy: "sum_available_only", minItemsRequired: 1 }) }),
    items,
    answers,
    OPEN_CONTEXT,
  );

  assert.equal(result.itemsExpected, 3);
  assert.equal(result.itemsUsed, 1);
  assert.equal(result.itemsMissing, 2);
  assert.equal(result.rawScore, 4, "only the in-range observation enters the sum");
  assert.equal(contribution(result, "01").included, false);
  assert.equal(contribution(result, "01").value, 9, "the rejected observation stays visible");
  assert.equal(contribution(result, "01").contribution, null);
  assert.match(contribution(result, "01").note ?? "", /above the declared maximum 7/);
  assert.ok(has(result.diagnostics, "scoring.value_out_of_range", "warn"));
  assert.ok(has(result.diagnostics, "scoring.value_not_numeric", "warn"));

  const coverage = scoreSession(session({ items, answers, scales: [scale({ algorithm: algorithm() })] }));
  assert.equal(coverage.coverage.totalItems, 3);
  assert.equal(coverage.coverage.answeredItems, 1);
  assert.equal(coverage.coverage.missingItems, 2);
  assert.equal(coverage.coverage.missingByReason["value_out_of_range"], 1);
  assert.equal(coverage.coverage.missingByReason["value_not_numeric"], 1);
  assert.equal(roundForDisplay(coverage.coverage.completenessRatio), 0.3333);
});

test("open_text items are excluded from scoring with diagnostics but still count as collected", () => {
  const items = [...likertItems("01", "02", "03"), item({ itemCode: "Q9", responseType: "open_text", minValue: null, maxValue: null })];
  const answers = [answer("01", 5), answer("02", 6), answer("03", 4), answer("Q9", null, { isMissing: false, rawValueText: "free text" })];
  const spec = scale({
    itemCodes: ["01", "02", "03", "Q9"],
    algorithm: algorithm({ steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03", "Q9"] }], minItemsRequired: 3 }),
  });
  const result = scoreScale(spec, items, answers, OPEN_CONTEXT);

  assert.equal(result.computability, "computed");
  assert.equal(result.rawScore, 15);
  assert.equal(result.itemsExpected, 3, "an open_text item is never an expected numeric observation");
  assert.equal(result.itemsUsed, 3);
  assert.equal(result.itemsMissing, 0);
  assert.equal(result.contributions.some((entry) => entry.itemCode === "Q9"), false);
  assert.deepEqual(result.sourceItemIds, ["id-01", "id-02", "id-03"]);
  const excluded = result.diagnostics.find((entry) => entry.code === "scoring.item_not_scorable");
  assert.ok(excluded, "the exclusion must be visible as a diagnostic");
  assert.equal(excluded.itemCode, "Q9");
  assert.equal(excluded.severity, "warn");

  const collected = scoreSession(session({ items, answers, scales: [spec] }));
  assert.ok(has(collected.sessionDiagnostics, "scoring.open_text_items_excluded", "info"));
  assert.equal(
    collected.sessionDiagnostics.find((entry) => entry.code === "scoring.open_text_items_excluded")?.itemCode,
    "Q9",
  );
  assert.equal(collected.coverage.answeredItems, 4, "the free-text answer was collected");
  assert.equal(collected.coverage.missingItems, 0);
});

test("only the items an algorithm references contribute to itemsExpected/counts", () => {
  const items = likertItems("01", "02", "03", "04", "05");
  const answers = [answer("01", 2), answer("02", 3), answer("03", 4), answer("04", 99, { isMissing: false }), answer("05", null)];
  const result = scoreScale(
    scale({ algorithm: algorithm({ steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03"] }], minItemsRequired: 3 }) }),
    items,
    answers,
    OPEN_CONTEXT,
  );
  assert.equal(result.computability, "computed");
  assert.equal(result.itemsExpected, 3, "unreferenced items are not expected");
  assert.equal(result.itemsUsed, 3);
  assert.equal(result.itemsMissing, 0);
  assert.equal(result.rawScore, 9);
  assert.deepEqual(result.sourceItemIds, ["id-01", "id-02", "id-03"]);
});

test("required-item misses are surfaced separately from scale-level completeness", () => {
  const items = [item({ itemCode: "01" }), item({ itemCode: "02" }), item({ itemCode: "03", isRequired: false })];
  const result = scoreScale(
    scale({
      algorithm: algorithm({
        steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03"] }],
        missingPolicy: "prorate_if_min_met",
        minItemsRequired: 2,
      }),
    }),
    items,
    [answer("01", 4), answer("02", 4), answer("03", null, { missingReason: "skipped_optional" })],
    OPEN_CONTEXT,
  );
  assert.equal(result.computability, "computed");
  assert.equal(result.itemsMissing, 1);
  assert.equal(has(result.diagnostics, "scoring.required_item_missing"), false, "the optional item may be skipped");
  assert.ok(has(result.diagnostics, "scoring.incomplete_data", "warn"));
});

// -------------------------------------------------------------- provisional --

test("provisional instruments and partial data are flagged; complete data is not", () => {
  const items = likertItems("01", "02", "03");
  const answers = [answer("01", 4), answer("02", 5), answer("03", 6)];
  const spec = scale({ algorithm: algorithm({ missingPolicy: "prorate_if_min_met", minItemsRequired: 3 }) });

  const clean = scoreScale(spec, items, answers, OPEN_CONTEXT);
  assert.equal(clean.computability, "computed");
  assert.equal(clean.methodologicallyProvisional, false);
  assert.equal(clean.itemsMissing, 0);

  const provisionalInstrument = scoreScale(spec, items, answers, { clinicalUsePermitted: true, provisionalInstrument: true });
  assert.equal(provisionalInstrument.computability, "computed");
  assert.equal(provisionalInstrument.methodologicallyProvisional, true);
  assert.ok(has(provisionalInstrument.diagnostics, "scoring.provisional_instrument", "warn"));

  const partial = scoreScale(
    scale({ algorithm: algorithm({ missingPolicy: "prorate_if_min_met", minItemsRequired: 2 }) }),
    items,
    [answer("01", 4), answer("02", 5)],
    OPEN_CONTEXT,
  );
  assert.equal(partial.computability, "computed");
  assert.equal(partial.methodologicallyProvisional, true);
  assert.equal(partial.itemsMissing, 1);
  assert.equal(partial.rawScore, 9 * (3 / 2));
});

// --------------------------------------------------------- clinical guard --

test("a clinical scale without clinicalUsePermitted never yields a band", () => {
  const items = likertItems("01", "02", "03");
  const answers = [answer("01", 4), answer("02", 4), answer("03", 4)];
  const bands = [
    { max: 8, label: "Subclinical" },
    { max: 14, label: "Elevated", note: "clinical follow-up" },
    { max: null, label: "Severe" },
  ];
  const clinicalSpec = scale({
    scaleCode: "CLIN",
    kind: "clinical_elevation",
    algorithm: algorithm({
      steps: [
        { kind: "recoded_sum", itemCodes: ["01", "02", "03"] },
        { kind: "band_lookup", bands },
      ],
    }),
  });

  const blocked = scoreScale(clinicalSpec, items, answers, { clinicalUsePermitted: false, provisionalInstrument: false });
  assert.equal(blocked.computability, "computed", "the raw score is still reported");
  assert.equal(blocked.rawScore, 12);
  assert.equal(blocked.bandLabel, null, "a clinical band must never be produced");
  assert.equal(blocked.bandNote, null);
  assert.ok(has(blocked.diagnostics, "scoring.clinical_band_suppressed", "warn"));
  assert.ok(has(blocked.diagnostics, "scoring.clinical_interpretation_blocked", "warn"));
  assert.equal(blocked.methodologicallyProvisional, true, "not usable as a validated clinical result");
  assert.match(
    blocked.diagnostics.find((entry) => entry.code === "scoring.clinical_band_suppressed")?.message ?? "",
    /clinicalUsePermitted=false/,
  );

  const permitted = scoreScale(clinicalSpec, items, answers, { clinicalUsePermitted: true, provisionalInstrument: false });
  assert.equal(permitted.bandLabel, "Elevated");
  assert.equal(permitted.bandNote, "clinical follow-up");
  assert.equal(permitted.methodologicallyProvisional, false);

  const viaSession = scoreSession(
    session({
      items,
      answers,
      scales: [clinicalSpec],
      clinicalUsePermitted: false,
      provisionalInstrument: false,
    }),
  );
  assert.equal(viaSession.scores[0]?.bandLabel, null);
  assert.equal(viaSession.scores[0]?.computability, "computed");
});

// --------------------------------------------------------- validateAlgorithm --

test("validateAlgorithm reports unknown item codes and weights on missing items", () => {
  const items = likertItems("01", "02");
  const unknownRef = validateAlgorithm(
    algorithm({ steps: [{ kind: "recoded_sum", itemCodes: ["01", "07"] }], minItemsRequired: 2 }),
    items,
  );
  assert.ok(has(unknownRef, "scoring.unknown_item_code", "fail"));
  assert.equal(unknownRef.find((entry) => entry.code === "scoring.unknown_item_code")?.itemCode, "07");
  assert.ok(has(unknownRef, "scoring.min_items_exceeds_referenced", "fail"), "minItemsRequired 2 > 1 scorable item");

  const unknownWeight = validateAlgorithm(
    algorithm({ steps: [{ kind: "weighted_sum", weights: [{ itemCode: "01", weight: 1 }, { itemCode: "99", weight: 2 }] }] }),
    items,
  );
  assert.ok(has(unknownWeight, "scoring.unknown_item_code", "fail"));
  assert.equal(unknownWeight.find((entry) => entry.code === "scoring.unknown_item_code")?.itemCode, "99");

  const nonFiniteWeight = validateAlgorithm(
    algorithm({ steps: [{ kind: "weighted_sum", weights: [{ itemCode: "01", weight: Number.NaN }] }] }),
    items,
  );
  assert.ok(has(nonFiniteWeight, "scoring.weight_not_finite", "fail"));
});

test("validateAlgorithm reports reverse items without bounds", () => {
  const items = [item({ itemCode: "01" }), item({ itemCode: "02", minValue: null, maxValue: null, reverseScored: true })];
  const noBounds = validateAlgorithm(
    algorithm({ steps: [{ kind: "recoded_sum", itemCodes: ["01", "02"] }], minItemsRequired: 1 }),
    items,
  );
  assert.ok(has(noBounds, "scoring.reverse_bounds_missing", "fail"));
  assert.equal(noBounds.find((entry) => entry.code === "scoring.reverse_bounds_missing")?.itemCode, "02");

  const withStepKey = validateAlgorithm(
    algorithm({
      minItemsRequired: 1,
      steps: [{ kind: "recoded_sum", itemCodes: ["01", "02"], reverseItemCodes: ["02"], reverseKey: { min: 1, max: 5 } }],
    }),
    items,
  );
  assert.equal(has(withStepKey, "scoring.reverse_bounds_missing"), false, "a step reverseKey supplies the bounds");

  const badKey = validateAlgorithm(
    algorithm({ minItemsRequired: 1, steps: [{ kind: "recoded_sum", itemCodes: ["01"], reverseKey: { min: 5, max: 5 } }] }),
    items,
  );
  assert.ok(has(badKey, "scoring.reverse_key_invalid", "fail"));
});

test("validateAlgorithm reports structural problems, unknown step kinds and non-monotonic tables", () => {
  const items = likertItems("01", "02", "03");

  const unknownKind = validateAlgorithm(
    {
      algorithmVersion: "1.0.0",
      steps: [{ kind: "quantum_sum", itemCodes: ["01"] }],
      missingPolicy: "strict_complete",
      minItemsRequired: 1,
    } as unknown as ScoreAlgorithmDefinition,
    items,
  );
  assert.ok(has(unknownKind, "scoring.unknown_step_kind", "fail"));

  const empty = validateAlgorithm(algorithm({ steps: [] }), items);
  assert.ok(has(empty, "scoring.steps_empty", "fail"));

  const badVersion = validateAlgorithm(algorithm({ algorithmVersion: "  " }), items);
  assert.ok(has(badVersion, "scoring.algorithm_version_missing", "fail"));

  const badMin = validateAlgorithm(algorithm({ minItemsRequired: -1 }), items);
  assert.ok(has(badMin, "scoring.min_items_invalid", "fail"));

  const badPercentile = validateAlgorithm(
    algorithm({
      steps: [
        { kind: "recoded_sum", itemCodes: ["01"] },
        {
          kind: "percentile_lookup",
          table: [
            { atOrAbove: 20, percentile: 90 },
            { atOrAbove: 10, percentile: 50 },
          ],
        },
      ],
    }),
    items,
  );
  assert.ok(has(badPercentile, "scoring.percentile_table_not_monotonic", "fail"));

  const outOfRangePercentile = validateAlgorithm(
    algorithm({ steps: [{ kind: "percentile_lookup", table: [{ atOrAbove: 1, percentile: 140 }] }] }),
    items,
  );
  assert.ok(has(outOfRangePercentile, "scoring.percentile_out_of_range", "fail"));

  const badBands = validateAlgorithm(
    algorithm({
      steps: [
        {
          kind: "band_lookup",
          bands: [
            { max: 10, label: "A" },
            { max: 10, label: "B" },
          ],
        },
      ],
    }),
    items,
  );
  assert.ok(has(badBands, "scoring.bands_not_monotonic", "fail"));

  const openEndedNotLast = validateAlgorithm(
    algorithm({
      steps: [
        {
          kind: "band_lookup",
          bands: [
            { max: null, label: "A" },
            { max: 10, label: "B" },
          ],
        },
      ],
    }),
    items,
  );
  assert.ok(has(openEndedNotLast, "scoring.bands_not_monotonic", "fail"));

  const valid = validateAlgorithm(algorithm(), items);
  assert.deepEqual(valid, [], "a clean algorithm validates without diagnostics");
});

// ------------------------------------------------------------ parseAlgorithm --

test("parseAlgorithm accepts a well-formed algorithm and round-trips JSON", () => {
  const source = algorithm({
    documentation: "Declared sum of three items.",
    steps: [
      { kind: "recoded_sum", itemCodes: ["01", "02"], reverseItemCodes: ["02"], reverseKey: { min: 1, max: 7 }, multiplyBy: 1, addConstant: 0 },
      { kind: "band_lookup", bands: [{ max: 7, label: "Low" }, { max: null, label: "High", note: "top" }] },
    ],
  });
  const parsed = parseAlgorithm(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(parsed, source);
  assert.equal(parsed.documentation, "Declared sum of three items.");

  const weighted = parseAlgorithm({
    algorithmVersion: "2.1",
    missingPolicy: "sum_available_only",
    minItemsRequired: 1,
    steps: [{ kind: "weighted_sum", weights: [{ itemCode: "01", weight: 1.5, reverse: true }], multiplyBy: 2 }],
  });
  assert.equal(weighted.missingPolicy, "sum_available_only");
  assert.equal(weighted.steps.length, 1);
});

test("parseAlgorithm rejects malformed payloads with DomainError scoring.algorithm_invalid", () => {
  const expectInvalid = (payload: unknown, detail: string) =>
    assert.throws(
      () => parseAlgorithm(payload),
      (error: unknown) => {
        assert.ok(error instanceof DomainError, `${detail}: expected a DomainError`);
        assert.equal((error as DomainError).code, "scoring.algorithm_invalid", detail);
        assert.ok(Array.isArray((error as DomainError).detail.issues), `${detail}: issues are reported`);
        return true;
      },
      detail,
    );

  expectInvalid(null, "null payload");
  expectInvalid("algorithm", "string payload");
  expectInvalid([], "array payload");
  expectInvalid({ algorithmVersion: "1.0.0", missingPolicy: "strict_complete", minItemsRequired: 1, steps: [] }, "empty steps");
  expectInvalid({ algorithmVersion: "1.0.0", missingPolicy: "guess", minItemsRequired: 1, steps: [{ kind: "recoded_sum", itemCodes: ["01"] }] }, "unknown policy");
  expectInvalid({ algorithmVersion: "", missingPolicy: "strict_complete", minItemsRequired: 1, steps: [{ kind: "recoded_sum", itemCodes: ["01"] }] }, "missing version");
  expectInvalid({ algorithmVersion: "1.0.0", missingPolicy: "strict_complete", minItemsRequired: 1.5, steps: [{ kind: "recoded_sum", itemCodes: ["01"] }] }, "fractional minItemsRequired");
  expectInvalid({ algorithmVersion: "1.0.0", missingPolicy: "strict_complete", minItemsRequired: 1, steps: [{ kind: "nope" }] }, "unknown step kind");
  expectInvalid({ algorithmVersion: "1.0.0", missingPolicy: "strict_complete", minItemsRequired: 1, steps: [{ kind: "recoded_sum", itemCodes: [] }] }, "empty itemCodes");
  expectInvalid({ algorithmVersion: "1.0.0", missingPolicy: "strict_complete", minItemsRequired: 1, steps: [{ kind: "z_score", mean: 0, sd: -1 }] }, "negative sd");
  expectInvalid({ algorithmVersion: "1.0.0", missingPolicy: "strict_complete", minItemsRequired: 1, steps: [{ kind: "band_lookup", bands: [] }] }, "empty bands");

  const issues = (() => {
    try {
      parseAlgorithm({ algorithmVersion: "1.0.0", missingPolicy: "strict_complete", minItemsRequired: 1, steps: [{ kind: "recoded_sum" }] });
      return null;
    } catch (error) {
      return (error as DomainError).detail.issues as Array<{ path: string; code: string }>;
    }
  })();
  assert.ok(issues !== null && issues.length >= 1);
  assert.equal(issues[0]?.path, "$.steps[0].itemCodes");
  assert.equal(issues[0]?.code, "scoring.empty_item_codes");
});

// ------------------------------------------------------------- scoreSession --

test("scoreSession reports coverage, missingness by reason and session diagnostics", () => {
  const items = [...likertItems("01", "02", "03"), item({ itemCode: "09", responseType: "open_text", minValue: null, maxValue: null })];
  const answers = [
    answer("01", 5),
    answer("02", null, { missingReason: "participant_refused" }),
    answer("09", null, { isMissing: false, rawValueText: "narrative" }),
    answer("ZZ", 3),
  ];
  const spec = scale({ algorithm: algorithm({ steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03"] }], minItemsRequired: 3 }) });
  const result = scoreSession(session({ items, answers, scales: [spec] }));

  assert.equal(result.assessmentSessionId, "as-1");
  assert.equal(result.coverage.totalItems, 4);
  assert.equal(result.coverage.answeredItems, 2, "item 01 and the free-text item 09 were collected");
  assert.equal(result.coverage.missingItems, 2);
  assert.equal(result.coverage.missingByReason["participant_refused"], 1);
  assert.equal(result.coverage.missingByReason["not_collected"], 1);
  assert.equal(result.coverage.completenessRatio, 0.5);
  assert.ok(has(result.sessionDiagnostics, "scoring.answer_without_item", "warn"));
  assert.equal(
    result.sessionDiagnostics.find((entry) => entry.code === "scoring.answer_without_item")?.itemCode,
    "ZZ",
  );
  assert.equal(result.scores.length, 1);
  assert.equal(result.scores[0]?.computability, "not_computable");
  assert.equal(result.scores[0]?.itemsMissing, 2);
  assert.ok(has(result.sessionDiagnostics, "scoring.scale_algorithm_invalid", "fail"));
});

test("scoreSession scores scales in declaration order so subscale chains resolve", () => {
  const items = likertItems("01", "02", "03", "04");
  const answers = [answer("01", 2), answer("02", 3), answer("03", 4), answer("04", 5)];
  const subscaleA = scale({
    scaleCode: "A",
    algorithm: algorithm({ steps: [{ kind: "recoded_sum", itemCodes: ["01", "02"] }], minItemsRequired: 2 }),
  });
  const subscaleB = scale({
    scaleCode: "B",
    algorithm: algorithm({ steps: [{ kind: "recoded_sum", itemCodes: ["03", "04"] }], minItemsRequired: 2 }),
  });
  const total = scale({
    scaleCode: "TOTAL",
    algorithm: algorithm({
      steps: [{ kind: "subscale_sum", subscales: [{ scaleCode: "A" }, { scaleCode: "B" }] }],
      missingPolicy: "strict_complete",
      minItemsRequired: 2,
    }),
  });

  const result = scoreSession(session({ items, answers, scales: [subscaleA, subscaleB, total] }));
  assert.equal(result.scores.length, 3);
  assert.equal(result.scores[0]?.rawScore, 5);
  assert.equal(result.scores[1]?.rawScore, 9);
  assert.equal(result.scores[2]?.computability, "computed");
  assert.equal(result.scores[2]?.rawScore, 14);
  assert.deepEqual(result.scores[2]?.sourceItemIds, ["id-01", "id-02", "id-03", "id-04"]);
  assert.equal(result.sessionDiagnostics.some((entry) => entry.severity === "fail"), false);

  const duplicate = scoreSession(session({ items, answers, scales: [subscaleA, subscaleA] }));
  assert.ok(has(duplicate.sessionDiagnostics, "scoring.duplicate_scale_code", "warn"));
  assert.equal(duplicate.scores.length, 2, "both declarations are still scored independently");
});

test("scoreSession is pure, deterministic and does not mutate its input", () => {
  const items = [...likertItems("01", "02", "03"), item({ itemCode: "Q1", responseType: "open_text", minValue: null, maxValue: null })];
  const answers = [answer("01", 6), answer("02", null, { missingReason: "skipped" }), answer("03", 2), answer("Q1", null, { isMissing: false, rawValueText: "text" })];
  const scaleSpec = scale({
    kind: "clinical_elevation",
    algorithm: algorithm({
      missingPolicy: "prorate_if_min_met",
      minItemsRequired: 2,
      steps: [
        { kind: "recoded_sum", itemCodes: ["01", "02", "03"], reverseItemCodes: ["03"], multiplyBy: 1.5, addConstant: -0.25 },
        { kind: "linear_transform", multiplyBy: 2, addConstant: 1 },
        { kind: "z_score", mean: 10, sd: 3 },
        { kind: "percentile_lookup", table: [{ atOrAbove: 0, percentile: 25 }, { atOrAbove: 8, percentile: 75 }] },
        { kind: "band_lookup", bands: [{ max: 9, label: "Low" }, { max: null, label: "High" }] },
      ],
    }),
  });
  const input = session({ items, answers, scales: [scaleSpec], clinicalUsePermitted: false, provisionalInstrument: true });
  const snapshot = JSON.stringify(input);

  const first = scoreSession(input);
  const second = scoreSession(input);

  assert.equal(JSON.stringify(first), JSON.stringify(second), "identical input yields byte-identical output");
  assert.equal(JSON.stringify(input), snapshot, "scoring never mutates the caller's data");
  assert.equal(first.scores[0]?.bandLabel, null, "clinical band suppressed without permission");
  assert.equal(first.scores[0]?.algorithmVersion, "1.0.0");
  assert.equal(first.scores[0]?.methodologicallyProvisional, true);
  assert.equal(first.scores[0]?.itemsMissing, 1);
  assert.equal(first.scores[0]?.rawScore, 26.75, "12 available-scaled sum (18) then 1.5x - 0.25");
  assert.equal(first.scores[0]?.transformedScore, 54.5, "then 2x + 1");
  assert.equal(roundForDisplay(first.scores[0]?.standardizedScore ?? 0), 14.8333, "(54.5 - 10) / 3");
  assert.equal(first.scores[0]?.percentile, 75, "54.5 is above the atOrAbove=8 step");
});

test("a score is reproducible from its declared version, sources and contributions", () => {
  const items = likertItems("01", "02", "03", "04");
  const answers = [answer("01", 3), answer("02", null, { missingReason: "skipped" }), answer("03", 6), answer("04", 7)];
  const result = scoreScale(
    scale({
      scaleCode: "AUDIT",
      algorithm: algorithm({
        steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03", "04"], reverseItemCodes: ["03"] }],
        missingPolicy: "prorate_if_min_met",
        minItemsRequired: 3,
      }),
    }),
    items,
    answers,
    OPEN_CONTEXT,
  );

  assert.equal(result.algorithmVersion, "1.0.0");
  assert.equal(result.itemsExpected, 4);
  assert.equal(result.itemsUsed, 3);
  const available = result.contributions.reduce((sum, entry) => sum + (entry.contribution ?? 0), 0);
  assert.equal(available, 12, "3 + (1+7-6) + 7");
  assert.equal(result.rawScore, available * (result.itemsExpected / result.itemsUsed));
  assert.deepEqual(result.sourceItemIds, ["id-01", "id-02", "id-03", "id-04"]);
  assert.equal(result.contributions.length, 4);
});

test("an aggregate whose references are all non-scorable is not computable", () => {
  const items = [item({ itemCode: "Q1", responseType: "open_text", minValue: null, maxValue: null })];
  const result = scoreScale(
    scale({
      scaleCode: "TEXT",
      itemCodes: ["Q1"],
      algorithm: algorithm({ steps: [{ kind: "recoded_sum", itemCodes: ["Q1"] }], minItemsRequired: 1 }),
    }),
    items,
    [answer("Q1", null, { isMissing: false, rawValueText: "narrative" })],
    OPEN_CONTEXT,
  );

  assert.equal(result.computability, "not_computable");
  assert.equal(result.itemsExpected, 0);
  assert.equal(result.itemsUsed, 0);
  assert.equal(result.itemsMissing, 0);
  assert.equal(result.contributions.length, 0);
  assert.match(result.notComputableReason ?? "", /scoring\.no_primary_value/);
  assert.ok(has(result.diagnostics, "scoring.item_not_scorable", "warn"));
});

test("contributions never carry a value for an item that was never collected", () => {
  const result = scoreScale(
    scale({
      algorithm: algorithm({
        steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03"] }],
        missingPolicy: "strict_complete",
        minItemsRequired: 3,
      }),
    }),
    likertItems("01", "02", "03"),
    [answer("01", 1), answer("02", 1)],
    OPEN_CONTEXT,
  );
  const absent = contribution(result, "03");
  assert.equal(absent.value, null, "nothing is invented for an uncollected item");
  assert.equal(absent.contribution, null);
  assert.equal(absent.included, false);
  assert.equal(absent.reversed, false);
  assert.match(absent.note ?? "", /no observed answer/);
  assert.equal(result.computability, "not_computable");
  assert.equal(result.methodologicallyProvisional, true);
  assert.equal(result.itemsMissing, 1);
  assert.equal(result.itemsUsed, 2);
  assert.equal(result.itemsExpected, 3);
});

test("degenerate algorithms fail closed with diagnostics instead of guessing", () => {
  const multi = scoreScale(
    scale({
      scaleCode: "MULTI",
      algorithm: algorithm({
        minItemsRequired: 2,
        steps: [
          { kind: "recoded_sum", itemCodes: ["01", "02"] },
          { kind: "mean_of_items", itemCodes: ["01", "02"] },
        ],
      }),
    }),
    likertItems("01", "02"),
    [answer("01", 2), answer("02", 4)],
    OPEN_CONTEXT,
  );
  assert.equal(multi.rawScore, 6, "the first aggregate is the primary value");
  assert.ok(has(multi.diagnostics, "scoring.multiple_aggregate_steps", "warn"));

  const duplicated = scoreScale(
    scale({
      scaleCode: "DUP",
      algorithm: algorithm({ minItemsRequired: 1, steps: [{ kind: "recoded_sum", itemCodes: ["01", "01"] }] }),
    }),
    likertItems("01"),
    [answer("01", 3)],
    OPEN_CONTEXT,
  );
  assert.equal(duplicated.rawScore, 3, "a repeated reference is collapsed, never double-counted");
  assert.equal(duplicated.itemsExpected, 1);
  assert.equal(duplicated.contributions.length, 1);
  assert.ok(has(duplicated.diagnostics, "scoring.duplicate_step_item", "warn"));

  const notComputableSource = scoreScale(
    scale({
      scaleCode: "SRC",
      algorithm: algorithm({ minItemsRequired: 0, steps: [{ kind: "z_score", mean: 0, sd: 1, sourceRawScale: "PARENT" }] }),
    }),
    [],
    [],
    { ...OPEN_CONTEXT, priorScales: { PARENT: { rawScore: null, sourceItemIds: ["id-01"] } } },
  );
  assert.equal(notComputableSource.computability, "not_computable");
  assert.equal(notComputableSource.standardizedScore, null);
  assert.ok(has(notComputableSource.diagnostics, "scoring.source_scale_not_computable", "fail"));

  const noProvenance = scoreScale(
    scale({
      scaleCode: "SUBP",
      algorithm: algorithm({ minItemsRequired: 1, steps: [{ kind: "subscale_sum", subscales: [{ scaleCode: "A" }] }] }),
    }),
    [],
    [],
    { ...OPEN_CONTEXT, priorScales: { A: { rawScore: 4 } } },
  );
  assert.equal(noProvenance.rawScore, 4);
  assert.ok(has(noProvenance.diagnostics, "scoring.subscale_provenance_unavailable", "warn"));
  assert.deepEqual(noProvenance.sourceItemIds, [], "provenance is never invented");

  const unsorted = scoreScale(
    scale({
      scaleCode: "TBL",
      algorithm: algorithm({
        minItemsRequired: 2,
        steps: [
          { kind: "recoded_sum", itemCodes: ["01", "02"] },
          { kind: "percentile_lookup", table: [{ atOrAbove: 10, percentile: 90 }, { atOrAbove: 5, percentile: 20 }] },
        ],
      }),
    }),
    likertItems("01", "02"),
    [answer("01", 2), answer("02", 4)],
    OPEN_CONTEXT,
  );
  assert.equal(unsorted.percentile, null, "no percentile is taken from a non-monotonic table");
  assert.ok(has(unsorted.diagnostics, "scoring.percentile_table_not_monotonic", "fail"));
});
