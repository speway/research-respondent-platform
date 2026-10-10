/**
 * Cohort repository: saved segments, rule snapshots and eligibility decisions.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, safeJsonParse, hashJson } from "../util/ids.ts";
import type { CohortRule, ParticipantFact } from "../domain/types.ts";
import { DomainError } from "../domain/types.ts";

export interface SegmentRow {
  id: string;
  organization_id: string;
  study_id: string | null;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SegmentRuleRow {
  id: string;
  segment_id: string;
  order_index: number;
  kind: "include" | "exclude";
  rule_json: string;
  label: string;
}

export interface SegmentSnapshotRow {
  id: string;
  segment_id: string;
  revision: number;
  rules_sha256: string;
  evaluated_at: string;
  denominator: number;
  included_count: number;
  excluded_count: number;
  indeterminate_count: number;
  result_json: string;
  evaluated_by: string | null;
}

export function createSegment(
  db: Db,
  input: {
    organizationId: string;
    studyId?: string | null;
    name: string;
    description?: string | null;
    createdBy?: string | null;
    rules?: Array<{ kind: "include" | "exclude"; rule: CohortRule; label: string }>;
  },
): SegmentRow {
  const timestamp = nowIso();
  const row: SegmentRow = {
    id: newId("seg"),
    organization_id: input.organizationId,
    study_id: input.studyId ?? null,
    name: input.name.trim(),
    description: input.description ?? null,
    created_by: input.createdBy ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO segment (id, organization_id, study_id, name, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.organization_id,
      row.study_id,
      row.name,
      row.description,
      row.created_by,
      row.created_at,
      row.updated_at,
    );
    (input.rules ?? []).forEach((entry, index) => {
      db.prepare(
        `INSERT INTO segment_rule (id, segment_id, order_index, kind, rule_json, label)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newId("srl"), row.id, index, entry.kind, JSON.stringify(entry.rule), entry.label);
    });
  });
  tx();
  return row;
}

export function getSegment(db: Db, segmentId: string): SegmentRow | undefined {
  return db.prepare("SELECT * FROM segment WHERE id = ?").get(segmentId) as SegmentRow | undefined;
}

export function listSegments(db: Db, organizationId: string): Array<SegmentRow & { rule_count: number; snapshot_count: number }> {
  return db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM segment_rule r WHERE r.segment_id = s.id) AS rule_count,
        (SELECT COUNT(*) FROM segment_snapshot n WHERE n.segment_id = s.id) AS snapshot_count
       FROM segment s WHERE s.organization_id = ? ORDER BY s.created_at DESC`,
    )
    .all(organizationId) as Array<SegmentRow & { rule_count: number; snapshot_count: number }>;
}

export function listSegmentRules(db: Db, segmentId: string): SegmentRuleRow[] {
  return db
    .prepare("SELECT * FROM segment_rule WHERE segment_id = ? ORDER BY order_index")
    .all(segmentId) as SegmentRuleRow[];
}

export function replaceSegmentRules(
  db: Db,
  segmentId: string,
  rules: Array<{ kind: "include" | "exclude"; rule: CohortRule; label: string }>,
): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM segment_rule WHERE segment_id = ?").run(segmentId);
    rules.forEach((entry, index) => {
      db.prepare(
        `INSERT INTO segment_rule (id, segment_id, order_index, kind, rule_json, label)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newId("srl"), segmentId, index, entry.kind, JSON.stringify(entry.rule), entry.label);
    });
    db.prepare("UPDATE segment SET updated_at = ? WHERE id = ?").run(nowIso(), segmentId);
  });
  tx();
}

export function parseSegmentRule(row: SegmentRuleRow): CohortRule {
  return safeJsonParse<CohortRule>(row.rule_json, {
    id: row.id,
    subject: "participant_attribute",
    operator: "is_present",
  });
}

export function saveSegmentSnapshot(
  db: Db,
  input: {
    segmentId: string;
    rules: Array<{ kind: "include" | "exclude"; rule: CohortRule; label: string }>;
    denominator: number;
    included: number;
    excluded: number;
    indeterminate: number;
    result: unknown;
    evaluatedBy?: string | null;
  },
): SegmentSnapshotRow {
  const previous = db
    .prepare("SELECT MAX(revision) AS revision FROM segment_snapshot WHERE segment_id = ?")
    .get(input.segmentId) as { revision: number | null };
  const revision = (previous.revision ?? 0) + 1;
  const row: SegmentSnapshotRow = {
    id: newId("snp"),
    segment_id: input.segmentId,
    revision,
    rules_sha256: hashJson(input.rules.map((entry) => ({ kind: entry.kind, label: entry.label, rule: entry.rule }))),
    evaluated_at: nowIso(),
    denominator: input.denominator,
    included_count: input.included,
    excluded_count: input.excluded,
    indeterminate_count: input.indeterminate,
    result_json: JSON.stringify(input.result),
    evaluated_by: input.evaluatedBy ?? null,
  };
  db.prepare(
    `INSERT INTO segment_snapshot (id, segment_id, revision, rules_sha256, evaluated_at, denominator, included_count,
       excluded_count, indeterminate_count, result_json, evaluated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.segment_id,
    row.revision,
    row.rules_sha256,
    row.evaluated_at,
    row.denominator,
    row.included_count,
    row.excluded_count,
    row.indeterminate_count,
    row.result_json,
    row.evaluated_by,
  );
  return row;
}

export function listSegmentSnapshots(db: Db, segmentId: string): SegmentSnapshotRow[] {
  return db
    .prepare("SELECT * FROM segment_snapshot WHERE segment_id = ? ORDER BY revision DESC")
    .all(segmentId) as SegmentSnapshotRow[];
}

export function getSegmentSnapshot(db: Db, snapshotId: string): SegmentSnapshotRow | undefined {
  return db.prepare("SELECT * FROM segment_snapshot WHERE id = ?").get(snapshotId) as SegmentSnapshotRow | undefined;
}

export function recordEligibilityDecisions(
  db: Db,
  input: {
    studyId: string;
    segmentSnapshotId?: string | null;
    decisions: Array<{ participantId: string; decision: "eligible" | "ineligible" | "indeterminate"; explanation: unknown }>;
    decidedBy?: string | null;
  },
): number {
  const timestamp = nowIso();
  const insert = db.prepare(
    `INSERT INTO eligibility_decision (id, study_id, participant_id, segment_snapshot_id, decision, explanation_json,
       decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const decision of input.decisions) {
      insert.run(
        newId("eld"),
        input.studyId,
        decision.participantId,
        input.segmentSnapshotId ?? null,
        decision.decision,
        JSON.stringify(decision.explanation),
        timestamp,
        input.decidedBy ?? null,
      );
      count += 1;
    }
  });
  tx();
  return count;
}

export function listEligibilityDecisions(
  db: Db,
  studyId: string,
  limit = 200,
): Array<{ id: string; participant_id: string; pseudonym: string; decision: string; decided_at: string; explanation_json: string }> {
  return db
    .prepare(
      `SELECT ed.id, ed.participant_id, p.pseudonym, ed.decision, ed.decided_at, ed.explanation_json
       FROM eligibility_decision ed JOIN participant p ON p.id = ed.participant_id
       WHERE ed.study_id = ? ORDER BY ed.decided_at DESC LIMIT ?`,
    )
    .all(studyId, Math.min(limit, 1000)) as Array<{
    id: string;
    participant_id: string;
    pseudonym: string;
    decision: string;
    decided_at: string;
    explanation_json: string;
  }>;
}

/**
 * Assembles the participant fact set the cohort engine evaluates.
 *
 * Only documented values are read: counts come from recorded answers and
 * scores; nothing is inferred or defaulted.
 */
export function loadParticipantFacts(db: Db, organizationId: string, studyId?: string | null): ParticipantFact[] {
  const participants = db
    .prepare("SELECT id, pseudonym, birth_year, age_at_enrolment, self_described_gender, preferred_language, education_level, region, recruitment_channel FROM participant WHERE organization_id = ? ORDER BY pseudonym")
    .all(organizationId) as Array<{
    id: string;
    pseudonym: string;
    birth_year: number | null;
    age_at_enrolment: number | null;
    self_described_gender: string | null;
    preferred_language: string | null;
    education_level: string | null;
    region: string | null;
    recruitment_channel: string | null;
  }>;

  const consents = db
    .prepare("SELECT participant_id, status, study_id, consent_version, granted_at, withdrawn_at, expires_at FROM consent_record")
    .all() as Array<{
    participant_id: string;
    status: string;
    study_id: string | null;
    consent_version: string;
    granted_at: string | null;
    withdrawn_at: string | null;
    expires_at: string | null;
  }>;
  const enrolments = db
    .prepare("SELECT participant_id, study_id, status, enrolled_at, withdrawn_at FROM study_participant")
    .all() as Array<{
    participant_id: string;
    study_id: string;
    status: string;
    enrolled_at: string;
    withdrawn_at: string | null;
  }>;
  const sessions = db
    .prepare(
      `SELECT s.id AS session_id, s.participant_id, s.study_id, s.instrument_version_id, s.timepoint_label,
              s.completed_at, s.created_at,
              (SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.is_missing = 0) AS answered,
              (SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.is_missing = 1) AS missing,
              (SELECT COUNT(*) FROM item_definition it WHERE it.instrument_version_id = s.instrument_version_id) AS total
       FROM assessment_session s`,
    )
    .all() as Array<{
    session_id: string;
    participant_id: string;
    study_id: string | null;
    instrument_version_id: string;
    timepoint_label: string;
    completed_at: string | null;
    created_at: string;
    answered: number;
    missing: number;
    total: number;
  }>;
  const scores = db
    .prepare(
      `SELECT ds.assessment_session_id, ds.participant_id, sd.scale_code, ses.instrument_version_id,
              ds.raw_score, ds.transformed_score, ds.standardized_score, ds.percentile, ds.computability,
              ds.algorithm_version, ds.computed_at
       FROM derived_score ds
       JOIN assessment_session ses ON ses.id = ds.assessment_session_id
       JOIN scale_definition sd ON sd.id = ds.scale_definition_id
       WHERE ds.superseded_by_id IS NULL`,
    )
    .all() as Array<{
    assessment_session_id: string;
    participant_id: string;
    scale_code: string;
    instrument_version_id: string;
    raw_score: number | null;
    transformed_score: number | null;
    standardized_score: number | null;
    percentile: number | null;
    computability: string;
    algorithm_version: string;
    computed_at: string;
  }>;

  const byParticipantConsent = groupBy(consents, (row) => row.participant_id);
  const byParticipantEnrolment = groupBy(enrolments, (row) => row.participant_id);
  const byParticipantSession = groupBy(sessions, (row) => row.participant_id);
  const byParticipantScore = groupBy(scores, (row) => row.participant_id);

  return participants.map((participant) => ({
    participantId: participant.id,
    pseudonym: participant.pseudonym,
    attributes: {
      birth_year: participant.birth_year,
      age_at_enrolment: participant.age_at_enrolment,
      self_described_gender: participant.self_described_gender,
      preferred_language: participant.preferred_language,
      education_level: participant.education_level,
      region: participant.region,
      recruitment_channel: participant.recruitment_channel,
    },
    consents: (byParticipantConsent.get(participant.id) ?? []).map((row) => ({
      status: row.status as "granted" | "declined" | "withdrawn" | "expired",
      studyId: row.study_id,
      version: row.consent_version,
      grantedAt: row.granted_at,
      withdrawnAt: row.withdrawn_at,
      expiresAt: row.expires_at,
    })),
    enrolments: (byParticipantEnrolment.get(participant.id) ?? [])
      .filter((row) => (studyId ? row.study_id === studyId : true))
      .map((row) => ({
        studyId: row.study_id,
        status: row.status as "invited" | "enrolled" | "active" | "completed" | "withdrawn" | "excluded",
        enrolledAt: row.enrolled_at,
        withdrawnAt: row.withdrawn_at,
      })),
    assessments: (byParticipantSession.get(participant.id) ?? [])
      .filter((row) => (studyId ? row.study_id === studyId : true))
      .map((row) => ({
        sessionId: row.session_id,
        studyId: row.study_id,
        instrumentVersionId: row.instrument_version_id,
        timepointLabel: row.timepoint_label,
        completedAt: row.completed_at,
        recordedAt: row.created_at,
        answeredItems: row.answered,
        totalItems: row.total,
        missingItems: row.missing,
      })),
    scores: (byParticipantScore.get(participant.id) ?? [])
      .filter((row) => (studyId ? (byParticipantSession.get(participant.id) ?? []).some((s) => s.session_id === row.assessment_session_id && s.study_id === studyId) : true))
      .map((row) => ({
        scaleCode: row.scale_code,
        instrumentVersionId: row.instrument_version_id,
        rawScore: row.raw_score,
        transformedScore: row.transformed_score,
        standardizedScore: row.standardized_score,
        percentile: row.percentile,
        computability: row.computability as "computed" | "not_computable",
        algorithmVersion: row.algorithm_version,
        assessmentSessionId: row.assessment_session_id,
        computedAt: row.computed_at,
      })),
  }));
}

export function deleteSegment(db: Db, segmentId: string): void {
  const exists = getSegment(db, segmentId);
  if (!exists) {
    throw new DomainError("segment.not_found", `Segment ${segmentId} not found.`);
  }
  db.prepare("DELETE FROM segment WHERE id = ?").run(segmentId);
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const list = map.get(value);
    if (list) {
      list.push(row);
    } else {
      map.set(value, [row]);
    }
  }
  return map;
}
