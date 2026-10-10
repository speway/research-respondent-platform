/**
 * Cohort service: turns stored criteria into an explainable eligibility preview
 * and persists snapshots + per-participant decisions.
 *
 * The heavy lifting is the pure rule engine in lib/domain/cohort.ts. This module
 * only supplies it with facts that were actually recorded.
 */
import type { Db } from "../../db/index.ts";
import type { Actor, CohortPreview, CohortRule } from "../domain/types.ts";
import { evaluateCohort, parseRule } from "../domain/cohort.ts";
import {
  listSegmentRules,
  listSegmentSnapshots,
  listSegments,
  loadParticipantFacts,
  parseSegmentRule,
  recordEligibilityDecisions,
  saveSegmentSnapshot,
  createSegment,
  replaceSegmentRules,
  type SegmentRow,
} from "../repo/cohorts.ts";
import { listCriteria } from "../repo/studies.ts";
import { recordAudit } from "./audit.ts";
import { assertOwned } from "./ownership.ts";
import { assertAuthorized, PERMISSIONS } from "./authz.ts";

export interface CohortRuleBundle {
  rules: CohortRule[];
  /** Distinguishes inclusion from exclusion rules for the UI. */
  labelled: Array<{ rule: CohortRule; kind: "include" | "exclude"; label: string }>;
}

/** Study criteria: inclusion rules plus exclusion rules, evaluated together. */
export function studyRuleBundle(db: Db, studyId: string): CohortRuleBundle {
  const criteria = listCriteria(db, studyId);
  const labelled = criteria.map((criterion) => ({
    rule: { ...parseCriterionRuleSafe(criterion.rule_json, criterion.id), id: criterion.id },
    kind: criterion.kind === "exclusion" ? ("exclude" as const) : ("include" as const),
    label: criterion.label,
  }));
  return { rules: labelled.map((entry) => entry.rule), labelled };
}

export function segmentRuleBundle(db: Db, segmentId: string): CohortRuleBundle {
  const rows = listSegmentRules(db, segmentId);
  const labelled = rows.map((row) => ({
    rule: { ...parseSegmentRule(row), id: row.id },
    kind: row.kind,
    label: row.label,
  }));
  return { rules: labelled.map((entry) => entry.rule), labelled };
}

/**
 * Cohort evaluation for a study. Rules from `exclusion` criteria are marked so
 * the engine treats a match as an exclusion rather than a failed requirement.
 */
export function getStudyCohortPreview(
  db: Db,
  studyId: string,
  actor?: Actor,
  options: { includeRules?: CohortRule[] } = {},
): CohortPreview {
  if (actor) { assertOwned(db, actor, "study", studyId); assertAuthorized(actor, PERMISSIONS.cohortRead, { studyId }); }
  const bundle = studyRuleBundle(db, studyId);
  const rules = options.includeRules ? [...options.includeRules, ...bundle.rules] : bundle.rules;
  const facts = loadParticipantFacts(db, studyOrganizationId(db, studyId), studyId);
  return evaluateCohort(rules, facts);
}

/**
 * Evaluation used when a study has no saved segment: applies the study's own
 * recruitment criteria exactly as the cohort builder would.
 */
export function getStudyCriteriaPreview(db: Db, studyId: string): CohortPreview {
  return getStudyCohortPreview(db, studyId);
}

export function getSegmentCohortPreview(db: Db, segmentId: string): CohortPreview {
  const segment = db.prepare("SELECT * FROM segment WHERE id = ?").get(segmentId) as SegmentRow | undefined;
  if (!segment) {
    throw new Error(`Segment ${segmentId} not found.`);
  }
  const bundle = segmentRuleBundle(db, segmentId);
  const facts = loadParticipantFacts(db, segment.organization_id, segment.study_id);
  return evaluateCohort(bundle.rules, facts);
}

export function createStudySegment(
  db: Db,
  actor: Actor,
  input: {
    studyId: string;
    name: string;
    description?: string | null;
    rules: Array<{ kind: "include" | "exclude"; rule: CohortRule; label: string }>;
  },
): SegmentRow {
  assertOwned(db, actor, "study", input.studyId);
  assertAuthorized(actor, PERMISSIONS.cohortWrite, { studyId: input.studyId });
  const organizationId = studyOrganizationId(db, input.studyId);
  const segment = createSegment(db, {
    organizationId,
    studyId: input.studyId,
    name: input.name,
    description: input.description ?? null,
    createdBy: actor.id,
    rules: input.rules,
  });
  recordAudit(db, {
    organizationId,
    actor,
    action: "cohort.segment.create",
    entityType: "segment",
    entityId: segment.id,
    studyId: input.studyId,
    outcome: "success",
    detail: { name: segment.name, ruleCount: input.rules.length },
  });
  return segment;
}

export function updateSegmentRules(
  db: Db,
  actor: Actor,
  segmentId: string,
  rules: Array<{ kind: "include" | "exclude"; rule: CohortRule; label: string }>,
): void {
  const segment = db.prepare("SELECT * FROM segment WHERE id = ?").get(segmentId) as SegmentRow | undefined;
  if (!segment) {
    throw new Error(`Segment ${segmentId} not found.`);
  }
  assertOwned(db, actor, "segment", segmentId);
  assertAuthorized(actor, PERMISSIONS.cohortWrite, { studyId: segment.study_id });
  replaceSegmentRules(db, segmentId, rules);
  recordAudit(db, {
    organizationId: segment.organization_id,
    actor,
    action: "cohort.segment.rules",
    entityType: "segment",
    entityId: segmentId,
    studyId: segment.study_id,
    outcome: "success",
    detail: { ruleCount: rules.length, rules: rules.map((entry) => entry.label) },
  });
}

export function snapshotSegment(db: Db, actor: Actor, segmentId: string) {
  const segment = db.prepare("SELECT * FROM segment WHERE id = ?").get(segmentId) as SegmentRow | undefined;
  if (!segment) {
    throw new Error(`Segment ${segmentId} not found.`);
  }
  assertOwned(db, actor, "segment", segmentId);
  assertAuthorized(actor, PERMISSIONS.cohortWrite, { studyId: segment.study_id });
  const bundle = segmentRuleBundle(db, segmentId);
  const facts = loadParticipantFacts(db, segment.organization_id, segment.study_id);
  const preview = evaluateCohort(bundle.rules, facts);
  const snapshot = saveSegmentSnapshot(db, {
    segmentId,
    rules: bundle.labelled,
    denominator: preview.denominator,
    included: preview.included,
    excluded: preview.excluded,
    indeterminate: preview.indeterminate,
    result: {
      evaluations: preview.evaluations.map((evaluation) => ({
        participantId: evaluation.participantId,
        pseudonym: evaluation.pseudonym,
        decision: evaluation.decision,
        traces: evaluation.traces,
      })),
      ruleSummary: preview.ruleSummary,
      missingnessSummary: preview.missingnessSummary,
      warnings: preview.warnings,
    },
    evaluatedBy: actor.id,
  });
  recordAudit(db, {
    organizationId: segment.organization_id,
    actor,
    action: "cohort.snapshot.create",
    entityType: "segment_snapshot",
    entityId: snapshot.id,
    studyId: segment.study_id,
    outcome: "success",
    severity: "notice",
    detail: {
      revision: snapshot.revision,
      denominator: snapshot.denominator,
      included: snapshot.included_count,
      excluded: snapshot.excluded_count,
      indeterminate: snapshot.indeterminate_count,
      rulesSha256: snapshot.rules_sha256,
    },
  });
  if (segment.study_id) {
    recordEligibilityDecisions(db, {
      studyId: segment.study_id,
      segmentSnapshotId: snapshot.id,
      decisions: preview.evaluations.map((evaluation) => ({
        participantId: evaluation.participantId,
        decision:
          evaluation.decision === "included"
            ? ("eligible" as const)
            : evaluation.decision === "excluded"
              ? ("ineligible" as const)
              : ("indeterminate" as const),
        explanation: { traces: evaluation.traces, snapshotRevision: snapshot.revision },
      })),
      decidedBy: actor.id,
    });
  }
  return { snapshot, preview };
}

export function listStudySegments(db: Db, studyId: string) {
  const organizationId = studyOrganizationId(db, studyId);
  return listSegments(db, organizationId).filter((segment) => segment.study_id === studyId);
}

export function segmentSnapshots(db: Db, segmentId: string) {
  return listSegmentSnapshots(db, segmentId);
}

export function studyOrganizationId(db: Db, studyId: string): string {
  const row = db.prepare("SELECT organization_id FROM study WHERE id = ?").get(studyId) as
    | { organization_id: string }
    | undefined;
  if (!row) {
    throw new Error(`Study ${studyId} not found.`);
  }
  return row.organization_id;
}

function parseCriterionRuleSafe(json: string, id: string): CohortRule {
  try {
    return parseRule(JSON.parse(json));
  } catch {
    return { id, subject: "participant_attribute", operator: "is_present" };
  }
}

/** Aggregate coverage figures used by the cohort screens. */
export function cohortDataQuality(db: Db, organizationId: string) {
  const missingness = db
    .prepare(
      `SELECT p.id, p.attribute_missingness_json FROM participant p WHERE p.organization_id = ?`,
    )
    .all(organizationId) as Array<{ id: string; attribute_missingness_json: string }>;
  const counts: Record<string, number> = {};
  for (const row of missingness) {
    let parsed: Record<string, string> = {};
    try {
      parsed = JSON.parse(row.attribute_missingness_json) as Record<string, string>;
    } catch {
      parsed = {};
    }
    for (const key of Object.keys(parsed)) {
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return {
    participants: missingness.length,
    missingByAttribute: Object.entries(counts)
      .map(([attribute, count]) => ({ attribute, count }))
      .sort((a, b) => b.count - a.count),
  };
}
