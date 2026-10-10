/**
 * Export runner.
 *
 * Builds the export content for an approved job. Two hard rules:
 *   1. an analytic export can never contain identity fields;
 *   2. participants without an active granted consent are excluded and reported
 *      in the audit detail, never silently dropped.
 */
import type { Db } from "../../db/index.ts";
import type { Actor } from "../domain/types.ts";
import { DomainError } from "../domain/types.ts";
import { requireActiveConsent } from "./authz.ts";
import { assertAuthorized, PERMISSIONS } from "./authz.ts";
import { recordAudit } from "./audit.ts";
import { completeExport, getExportJob, toExportCsv, type ExportScope } from "../repo/exports.ts";

export const ASSESS_SCOPE_NOTE =
  "Analytic exports are de-identified: pseudonym, instrument version, item code, raw value, missingness, collection " +
  "time and source locator only. Identity data is never included.";

export interface ExportRunResult {
  jobId: string;
  scope: ExportScope;
  rowCount: number;
  outputSha256: string | null;
  content: string;
  consentExcluded: Array<{ pseudonym: string; reason: string }>;
}

export function runExportJob(db: Db, actor: Actor, jobId: string): ExportRunResult {
  const job = getExportJob(db, jobId);
  if (!job) {
    throw new DomainError("export.not_found", `Export job ${jobId} not found.`);
  }
  if (job.organization_id !== actor.organizationId) {
    throw new DomainError("export.wrong_organization", "Export job belongs to another organization.");
  }
  if (job.status !== "approved") {
    throw new DomainError("export.not_approved", `Export must be approved before it runs (current status ${job.status}).`);
  }
  if (job.scope === "identity_restricted") {
    assertAuthorized(actor, PERMISSIONS.identityRead, { studyId: job.study_id });
  } else {
    assertAuthorized(actor, PERMISSIONS.exportCreate, { studyId: job.study_id });
  }

  const organizationId = actor.organizationId;
  const excluded = new Map<string, { pseudonym: string; reason: string }>();
  function allowParticipant(participantId: string, studyId: string | null): boolean {
    const participant = db.prepare("SELECT pseudonym FROM participant WHERE id = ? AND organization_id = ?")
      .get(participantId, organizationId) as { pseudonym: string } | undefined;
    if (!participant) return false;
    const decision = participantConsentDecision(db, participantId, studyId);
    if (!decision.allowed) excluded.set(participantId, { pseudonym: participant.pseudonym, reason: decision.reason });
    return decision.allowed;
  }

  const built = buildContent(db, organizationId, job.study_id, job.scope as ExportScope);
  const columns = built.columns;
  const rows = built.rows.filter((row) => {
    if (job.scope === "identity_restricted") return true;
    if (job.scope === "provenance_audit") {
      // A shared source is omitted in full if any linked participant has no consent.
      const linked = db.prepare(`SELECT DISTINCT participant_id, study_id FROM assessment_session
        WHERE documented_source_id = ?`)
        .all(row.documented_source_id) as Array<{ participant_id: string; study_id: string | null }>;
      return linked.length > 0 && (!job.study_id || linked.every((link) => link.study_id === job.study_id)) && linked.map((link) => allowParticipant(link.participant_id, link.study_id)).every(Boolean);
    }
    return allowParticipant(String(row._participant_id), row._study_id as string | null);
  }).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
  const content = job.format === "csv" ? toExportCsv(rows, columns)
    : job.format === "jsonl" ? rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "")
    : `${JSON.stringify(rows, null, 2)}\n`;
  const consentExcluded = [...excluded.values()];
  const completed = completeExport(db, jobId, { content, rowCount: rows.length });

  recordAudit(db, {
    organizationId,
    actor,
    action: "export.run",
    entityType: "export_job",
    entityId: jobId,
    studyId: job.study_id,
    outcome: "success",
    severity: job.contains_identity === 1 ? "critical" : "notice",
    detail: {
      scope: job.scope,
      format: job.format,
      rowCount: rows.length,
      outputSha256: completed.output_sha256,
      consentExcludedCount: consentExcluded.length,
      consentExcludedDetail: consentExcluded.slice(0, 25),
      note: ASSESS_SCOPE_NOTE,
    },
  });

  return {
    jobId,
    scope: job.scope as ExportScope,
    rowCount: rows.length,
    outputSha256: completed.output_sha256,
    content,
    consentExcluded,
  };
}

export function consentGate(
  db: Db,
  organizationId: string,
  studyId: string | null,
): Array<{ pseudonym: string; reason: string }> {
  const participants = db
    .prepare("SELECT id, pseudonym FROM participant WHERE organization_id = ? ORDER BY pseudonym")
    .all(organizationId) as Array<{ id: string; pseudonym: string }>;
  const consentRows = db
    .prepare(
      `SELECT participant_id, status, study_id, consent_version, withdrawn_at, expires_at FROM consent_record cr
       WHERE EXISTS (SELECT 1 FROM participant p WHERE p.id = cr.participant_id AND p.organization_id = ?)
       ORDER BY cr.recorded_at DESC, cr.rowid DESC`,
    )
    .all(organizationId) as Array<{
    participant_id: string;
    status: string;
    study_id: string | null;
    consent_version: string;
    withdrawn_at: string | null;
    expires_at: string | null;
  }>;
  const byParticipant = new Map<string, typeof consentRows>();
  for (const row of consentRows) {
    const list = byParticipant.get(row.participant_id);
    if (list) {
      list.push(row);
    } else {
      byParticipant.set(row.participant_id, [row]);
    }
  }
  const now = new Date().toISOString();
  const excluded: Array<{ pseudonym: string; reason: string }> = [];
  for (const participant of participants) {
    const decision = requireActiveConsent(
      (byParticipant.get(participant.id) ?? []).map((row) => ({
        status: row.status,
        studyId: row.study_id,
        withdrawnAt: row.withdrawn_at,
        expiresAt: row.expires_at,
        version: row.consent_version,
      })),
      studyId,
      now,
    );
    if (!decision.allowed) {
      excluded.push({ pseudonym: participant.pseudonym, reason: decision.reason });
    }
  }
  return excluded;
}

export function buildContent(
  db: Db,
  organizationId: string,
  studyId: string | null,
  scope: ExportScope,
): { columns: string[]; rows: Array<Record<string, unknown>> } {
  if (scope === "analytic_deidentified") {
    const columns = [
      "pseudonym",
      "study_code",
      "instrument",
      "instrument_version",
      "timepoint",
      "item_code",
      "raw_value_text",
      "value_numeric",
      "is_missing",
      "missing_reason",
      "collected_at",
      "documented_source_id",
      "source_locator",
    ];
    const rows = db
      .prepare(
        `SELECT p.id AS _participant_id, ses.study_id AS _study_id, p.pseudonym, s.code AS study_code, i.title AS instrument, iv.version_label AS instrument_version,
                ses.timepoint_label AS timepoint, oa.item_code, oa.raw_value_text, oa.value_numeric, oa.is_missing,
                oa.missing_reason, oa.collected_at,
                oa.source_documented_source_id AS documented_source_id, oa.source_locator
         FROM observed_answer oa
         JOIN participant p ON p.id = oa.participant_id
         JOIN assessment_session ses ON ses.id = oa.assessment_session_id
         JOIN instrument_version iv ON iv.id = ses.instrument_version_id
         JOIN instrument i ON i.id = iv.instrument_id
         LEFT JOIN study s ON s.id = ses.study_id
         WHERE p.organization_id = ? AND (? IS NULL OR ses.study_id = ?)
         ORDER BY p.pseudonym, ses.timepoint_label, oa.item_code`,
      )
      .all(organizationId, studyId, studyId) as Array<Record<string, unknown>>;
    return { columns, rows };
  }
  if (scope === "provenance_audit") {
    const columns = [
      "documented_source_id",
      "origin_type",
      "title",
      "reference",
      "collected_at",
      "received_at",
      "content_sha256",
      "answers",
      "sessions",
    ];
    const rows = db
      .prepare(
        `SELECT ds.id AS documented_source_id, ds.origin_type, ds.title, ds.reference, ds.collected_at, ds.received_at,
                ds.content_sha256,
                (SELECT COUNT(*) FROM observed_answer oa WHERE oa.source_documented_source_id = ds.id) AS answers,
                (SELECT COUNT(*) FROM assessment_session s WHERE s.documented_source_id = ds.id) AS sessions
         FROM documented_source ds WHERE ds.organization_id = ? AND (? IS NULL OR EXISTS (SELECT 1 FROM assessment_session ses WHERE ses.documented_source_id = ds.id AND ses.study_id = ?)) ORDER BY ds.received_at`,
      )
      .all(organizationId, studyId, studyId) as Array<Record<string, unknown>>;
    return { columns, rows };
  }
  if (scope === "cohort_manifest") {
    const columns = ["pseudonym", "study_code", "decision", "decided_at", "explanation_json"];
    const rows = db
      .prepare(
        `SELECT p.id AS _participant_id, ed.study_id AS _study_id, p.pseudonym, s.code AS study_code, ed.decision, ed.decided_at, ed.explanation_json
         FROM eligibility_decision ed
         JOIN participant p ON p.id = ed.participant_id
         JOIN study s ON s.id = ed.study_id
         WHERE p.organization_id = ? AND (? IS NULL OR ed.study_id = ?)
         ORDER BY ed.decided_at DESC`,
      )
      .all(organizationId, studyId, studyId) as Array<Record<string, unknown>>;
    return { columns, rows };
  }
  if (scope === "task_execution_report") {
    const columns = [
      "task_id",
      "kind",
      "state",
      "study_code",
      "pseudonym",
      "adapter",
      "attempts",
      "idempotency_key",
      "created_at",
      "finished_at",
      "last_error",
    ];
    const rows = db
      .prepare(
        `SELECT p.id AS _participant_id, t.study_id AS _study_id, t.id AS task_id, t.kind, t.state, s.code AS study_code, p.pseudonym,
                (SELECT a.adapter FROM task_attempt a WHERE a.agent_task_id = t.id ORDER BY a.attempt_number DESC LIMIT 1) AS adapter,
                t.attempt_count AS attempts, t.idempotency_key, t.created_at, t.finished_at, t.last_error
         FROM agent_task t
         JOIN study s ON s.id = t.study_id
         JOIN participant p ON p.id = t.participant_id
         WHERE t.organization_id = ? AND (? IS NULL OR t.study_id = ?)
         ORDER BY t.created_at DESC`,
      )
      .all(organizationId, studyId, studyId) as Array<Record<string, unknown>>;
    return { columns, rows };
  }
  const columns = ["pseudonym", "full_name", "contact_email", "contact_phone", "lawful_basis", "retention_until", "recorded_at"];
  const rows = db
    .prepare(
      `SELECT p.pseudonym, i.full_name, i.contact_email, i.contact_phone, i.lawful_basis, i.retention_until, i.recorded_at
       FROM participant_private_identity i JOIN participant p ON p.id = i.participant_id
       WHERE p.organization_id = ? AND (? IS NULL OR EXISTS (SELECT 1 FROM study_participant sp WHERE sp.participant_id = p.id AND sp.study_id = ?)) ORDER BY p.pseudonym`,
    )
    .all(organizationId, studyId, studyId) as Array<Record<string, unknown>>;
  return { columns, rows };
}

export function participantConsentDecision(db: Db, participantId: string, studyId: string | null) {
  const rows = db.prepare(`SELECT status, study_id, withdrawn_at, expires_at, consent_version
    FROM consent_record WHERE participant_id = ? ORDER BY recorded_at DESC, rowid DESC`).all(participantId) as Array<{
    status: string; study_id: string | null; withdrawn_at: string | null; expires_at: string | null; consent_version: string;
  }>;
  return requireActiveConsent(rows.map((row) => ({ status: row.status, studyId: row.study_id,
    withdrawnAt: row.withdrawn_at, expiresAt: row.expires_at, version: row.consent_version })), studyId, new Date().toISOString());
}
