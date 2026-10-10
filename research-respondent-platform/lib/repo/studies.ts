/**
 * Study and protocol repository.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, safeJsonParse } from "../util/ids.ts";
import type { CohortRule } from "../domain/types.ts";

export interface StudyRow {
  id: string;
  organization_id: string;
  code: string;
  title: string;
  research_question: string;
  principal_email: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProtocolRow {
  id: string;
  study_id: string;
  version_label: string;
  supersedes_id: string | null;
  effective_from: string;
  design_summary: string | null;
  inclusion_criteria: string | null;
  exclusion_criteria: string | null;
  ethical_approval: string | null;
  consent_template: string | null;
  data_access_notes: string | null;
  approved_by: string | null;
  created_at: string;
}

export interface CriterionRow {
  id: string;
  study_id: string;
  protocol_version_id: string | null;
  kind: "inclusion" | "exclusion";
  label: string;
  rule_json: string;
  rationale: string | null;
  created_at: string;
}

export interface StudyParticipantRow {
  id: string;
  study_id: string;
  participant_id: string;
  enrolled_at: string;
  enrolment_source: string;
  status: string;
  withdrawn_at: string | null;
  withdrawal_reason: string | null;
}

export function createStudy(
  db: Db,
  input: {
    organizationId: string;
    code: string;
    title: string;
    researchQuestion: string;
    principalEmail?: string | null;
    createdBy?: string | null;
    status?: "draft" | "active" | "paused" | "closed" | "archived";
  },
): StudyRow {
  const code = input.code.trim().toUpperCase();
  const existing = db.prepare("SELECT * FROM study WHERE code = ?").get(code) as StudyRow | undefined;
  if (existing) {
    throw new Error(`Study code ${code} already exists.`);
  }
  const timestamp = nowIso();
  const row: StudyRow = {
    id: newId("std"),
    organization_id: input.organizationId,
    code,
    title: input.title.trim(),
    research_question: input.researchQuestion.trim(),
    principal_email: input.principalEmail ?? null,
    status: input.status ?? "draft",
    created_by: input.createdBy ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  db.prepare(
    `INSERT INTO study (id, organization_id, code, title, research_question, principal_email, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.organization_id,
    row.code,
    row.title,
    row.research_question,
    row.principal_email,
    row.status,
    row.created_by,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function updateStudy(
  db: Db,
  studyId: string,
  patch: Partial<Pick<StudyRow, "title" | "research_question" | "principal_email" | "status">>,
): StudyRow {
  const current = getStudy(db, studyId);
  if (!current) {
    throw new Error(`Study ${studyId} not found.`);
  }
  const next: StudyRow = {
    ...current,
    title: patch.title ?? current.title,
    research_question: patch.research_question ?? current.research_question,
    principal_email: patch.principal_email === undefined ? current.principal_email : patch.principal_email,
    status: patch.status ?? current.status,
    updated_at: nowIso(),
  };
  db.prepare(
    "UPDATE study SET title = ?, research_question = ?, principal_email = ?, status = ?, updated_at = ? WHERE id = ?",
  ).run(next.title, next.research_question, next.principal_email, next.status, next.updated_at, studyId);
  return next;
}

export function getStudy(db: Db, studyId: string): StudyRow | undefined {
  return db.prepare("SELECT * FROM study WHERE id = ?").get(studyId) as StudyRow | undefined;
}

export function getStudyByCode(db: Db, code: string): StudyRow | undefined {
  return db.prepare("SELECT * FROM study WHERE code = ?").get(code.toUpperCase()) as StudyRow | undefined;
}

export function listStudies(db: Db, organizationId: string): Array<StudyRow & { participant_count: number; protocol_count: number }> {
  return db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM study_participant sp WHERE sp.study_id = s.id) AS participant_count,
        (SELECT COUNT(*) FROM study_protocol_version pv WHERE pv.study_id = s.id) AS protocol_count
       FROM study s WHERE s.organization_id = ? ORDER BY s.created_at DESC`,
    )
    .all(organizationId) as Array<StudyRow & { participant_count: number; protocol_count: number }>;
}

export function createProtocolVersion(
  db: Db,
  input: {
    studyId: string;
    versionLabel: string;
    designSummary?: string | null;
    inclusionCriteria?: string | null;
    exclusionCriteria?: string | null;
    ethicalApproval?: string | null;
    consentTemplate?: string | null;
    dataAccessNotes?: string | null;
    approvedBy?: string | null;
    effectiveFrom?: string;
  },
): ProtocolRow {
  const previous = db
    .prepare("SELECT * FROM study_protocol_version WHERE study_id = ? ORDER BY effective_from DESC LIMIT 1")
    .get(input.studyId) as ProtocolRow | undefined;
  const row: ProtocolRow = {
    id: newId("prt"),
    study_id: input.studyId,
    version_label: input.versionLabel.trim(),
    supersedes_id: previous?.id ?? null,
    effective_from: input.effectiveFrom ?? nowIso(),
    design_summary: input.designSummary ?? null,
    inclusion_criteria: input.inclusionCriteria ?? null,
    exclusion_criteria: input.exclusionCriteria ?? null,
    ethical_approval: input.ethicalApproval ?? null,
    consent_template: input.consentTemplate ?? null,
    data_access_notes: input.dataAccessNotes ?? null,
    approved_by: input.approvedBy ?? null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO study_protocol_version (
       id, study_id, version_label, supersedes_id, effective_from, design_summary, inclusion_criteria,
       exclusion_criteria, ethical_approval, consent_template, data_access_notes, approved_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.study_id,
    row.version_label,
    row.supersedes_id,
    row.effective_from,
    row.design_summary,
    row.inclusion_criteria,
    row.exclusion_criteria,
    row.ethical_approval,
    row.consent_template,
    row.data_access_notes,
    row.approved_by,
    row.created_at,
  );
  return row;
}

export function listProtocolVersions(db: Db, studyId: string): ProtocolRow[] {
  return db
    .prepare("SELECT * FROM study_protocol_version WHERE study_id = ? ORDER BY effective_from DESC")
    .all(studyId) as ProtocolRow[];
}

export function getLatestProtocol(db: Db, studyId: string): ProtocolRow | undefined {
  return db
    .prepare("SELECT * FROM study_protocol_version WHERE study_id = ? ORDER BY effective_from DESC LIMIT 1")
    .get(studyId) as ProtocolRow | undefined;
}

export function createCriterion(
  db: Db,
  input: {
    studyId: string;
    protocolVersionId?: string | null;
    kind: "inclusion" | "exclusion";
    label: string;
    rule: CohortRule;
    rationale?: string | null;
  },
): CriterionRow {
  const row: CriterionRow = {
    id: newId("crt"),
    study_id: input.studyId,
    protocol_version_id: input.protocolVersionId ?? null,
    kind: input.kind,
    label: input.label.trim(),
    rule_json: JSON.stringify(input.rule),
    rationale: input.rationale ?? null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO recruitment_criterion (id, study_id, protocol_version_id, kind, label, rule_json, rationale, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.study_id,
    row.protocol_version_id,
    row.kind,
    row.label,
    row.rule_json,
    row.rationale,
    row.created_at,
  );
  return row;
}

export function listCriteria(db: Db, studyId: string): CriterionRow[] {
  return db
    .prepare("SELECT * FROM recruitment_criterion WHERE study_id = ? ORDER BY kind, created_at")
    .all(studyId) as CriterionRow[];
}

export function deleteCriterion(db: Db, criterionId: string): boolean {
  return db.prepare("DELETE FROM recruitment_criterion WHERE id = ?").run(criterionId).changes > 0;
}

export function parseCriterionRule(row: CriterionRow): CohortRule {
  return safeJsonParse<CohortRule>(row.rule_json, {
    id: row.id,
    subject: "participant_attribute",
    operator: "is_present",
  });
}

export function enrolParticipant(
  db: Db,
  input: {
    studyId: string;
    participantId: string;
    enrolmentSource: string;
    status?: "invited" | "enrolled" | "active" | "completed" | "withdrawn" | "excluded";
    enrolledAt?: string;
  },
): StudyParticipantRow {
  const existing = db
    .prepare("SELECT * FROM study_participant WHERE study_id = ? AND participant_id = ?")
    .get(input.studyId, input.participantId) as StudyParticipantRow | undefined;
  if (existing) {
    return existing;
  }
  const row: StudyParticipantRow = {
    id: newId("spr"),
    study_id: input.studyId,
    participant_id: input.participantId,
    enrolled_at: input.enrolledAt ?? nowIso(),
    enrolment_source: input.enrolmentSource,
    status: input.status ?? "enrolled",
    withdrawn_at: null,
    withdrawal_reason: null,
  };
  db.prepare(
    `INSERT INTO study_participant (id, study_id, participant_id, enrolled_at, enrolment_source, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.study_id, row.participant_id, row.enrolled_at, row.enrolment_source, row.status);
  return row;
}

export function setEnrolmentStatus(
  db: Db,
  studyId: string,
  participantId: string,
  status: "invited" | "enrolled" | "active" | "completed" | "withdrawn" | "excluded",
  reason?: string | null,
): boolean {
  const withdrawnAt = status === "withdrawn" ? nowIso() : null;
  const result = db
    .prepare(
      "UPDATE study_participant SET status = ?, withdrawn_at = ?, withdrawal_reason = ? WHERE study_id = ? AND participant_id = ?",
    )
    .run(status, withdrawnAt, reason ?? null, studyId, participantId);
  return result.changes > 0;
}

export function listStudyParticipants(
  db: Db,
  studyId: string,
): Array<StudyParticipantRow & { pseudonym: string }> {
  return db
    .prepare(
      `SELECT sp.*, p.pseudonym FROM study_participant sp
       JOIN participant p ON p.id = sp.participant_id
       WHERE sp.study_id = ? ORDER BY p.pseudonym`,
    )
    .all(studyId) as Array<StudyParticipantRow & { pseudonym: string }>;
}

export function studyOverviewCounts(db: Db, studyId: string) {
  const participants = db
    .prepare("SELECT COUNT(*) AS total FROM study_participant WHERE study_id = ?")
    .get(studyId) as { total: number };
  const sessions = db
    .prepare("SELECT COUNT(*) AS total FROM assessment_session WHERE study_id = ?")
    .get(studyId) as { total: number };
  const answers = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN oa.is_missing = 1 THEN 1 ELSE 0 END) AS missing
       FROM observed_answer oa JOIN assessment_session s ON s.id = oa.assessment_session_id
       WHERE s.study_id = ?`,
    )
    .get(studyId) as { total: number; missing: number | null };
  const scores = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN ds.computability = 'computed' THEN 1 ELSE 0 END) AS computed
       FROM derived_score ds JOIN assessment_session s ON s.id = ds.assessment_session_id
       WHERE s.study_id = ?`,
    )
    .get(studyId) as { total: number; computed: number | null };
  const tasks = db
    .prepare(
      `SELECT state, COUNT(*) AS total FROM agent_task WHERE study_id = ? GROUP BY state`,
    )
    .all(studyId) as Array<{ state: string; total: number }>;
  const consents = db
    .prepare(
      `SELECT status, COUNT(*) AS total FROM consent_record WHERE study_id = ? GROUP BY status`,
    )
    .all(studyId) as Array<{ status: string; total: number }>;
  return {
    participants: participants.total,
    sessions: sessions.total,
    answers: answers.total,
    missingAnswers: answers.missing ?? 0,
    scores: scores.total,
    computedScores: scores.computed ?? 0,
    tasks: Object.fromEntries(tasks.map((row) => [row.state, row.total])),
    consents: Object.fromEntries(consents.map((row) => [row.status, row.total])),
  };
}
