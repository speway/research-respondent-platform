/**
 * Export jobs and retention policy.
 *
 * Exports are separated by scope: an analytic (de-identified) export can never
 * contain identity fields, and an identity export requires its own approval.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, sha256Hex, toCsv } from "../util/ids.ts";
import { DomainError } from "../domain/types.ts";

export interface ExportJobRow {
  id: string;
  organization_id: string;
  study_id: string | null;
  segment_snapshot_id: string | null;
  format: "csv" | "json" | "jsonl";
  scope: "analytic_deidentified" | "provenance_audit" | "cohort_manifest" | "task_execution_report" | "identity_restricted";
  status: "pending" | "approved" | "running" | "completed" | "failed" | "cancelled";
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  requested_at: string;
  completed_at: string | null;
  row_count: number | null;
  filters_json: string;
  output_sha256: string | null;
  output_path: string | null;
  contains_identity: number;
  denial_reason: string | null;
}

export const EXPORT_SCOPES = [
  "analytic_deidentified",
  "provenance_audit",
  "cohort_manifest",
  "task_execution_report",
  "identity_restricted",
] as const;

export type ExportScope = (typeof EXPORT_SCOPES)[number];

export function requestExport(
  db: Db,
  input: {
    organizationId: string;
    studyId?: string | null;
    segmentSnapshotId?: string | null;
    format: "csv" | "json" | "jsonl";
    scope: (typeof EXPORT_SCOPES)[number];
    requestedBy?: string | null;
    filters?: Record<string, unknown>;
    containsIdentity?: boolean;
  },
): ExportJobRow {
  if (!EXPORT_SCOPES.includes(input.scope)) {
    throw new DomainError("export.unknown_scope", `Unknown export scope "${input.scope}".`, { allowed: EXPORT_SCOPES });
  }
  const row: ExportJobRow = {
    id: newId("exp"),
    organization_id: input.organizationId,
    study_id: input.studyId ?? null,
    segment_snapshot_id: input.segmentSnapshotId ?? null,
    format: input.format,
    scope: input.scope,
    status: "pending",
    requested_by: input.requestedBy ?? null,
    approved_by: null,
    approved_at: null,
    requested_at: nowIso(),
    completed_at: null,
    row_count: null,
    filters_json: JSON.stringify(input.filters ?? {}),
    output_sha256: null,
    output_path: null,
    contains_identity: input.containsIdentity ? 1 : 0,
    denial_reason: null,
  };
  db.prepare(
    `INSERT INTO export_job (id, organization_id, study_id, segment_snapshot_id, format, scope, status, requested_by,
       approved_by, approved_at, requested_at, completed_at, row_count, filters_json, output_sha256, output_path,
       contains_identity, denial_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, NULL, NULL, ?, NULL)`,
  ).run(
    row.id,
    row.organization_id,
    row.study_id,
    row.segment_snapshot_id,
    row.format,
    row.scope,
    row.status,
    row.requested_by,
    row.requested_at,
    row.filters_json,
    row.contains_identity,
  );
  return row;
}

export function getExportJob(db: Db, id: string): ExportJobRow | undefined {
  return db.prepare("SELECT * FROM export_job WHERE id = ?").get(id) as ExportJobRow | undefined;
}

export function listExportJobs(db: Db, organizationId: string, limit = 100): ExportJobRow[] {
  return db
    .prepare("SELECT * FROM export_job WHERE organization_id = ? ORDER BY requested_at DESC LIMIT ?")
    .all(organizationId, Math.min(limit, 500)) as ExportJobRow[];
}

export function approveExport(db: Db, jobId: string, approvedBy: string | null): ExportJobRow {
  const job = getExportJob(db, jobId);
  if (!job) {
    throw new DomainError("export.not_found", `Export job ${jobId} not found.`);
  }
  if (job.status !== "pending") {
    throw new DomainError("export.not_pending", `Export job is ${job.status}; only pending jobs can be approved.`);
  }
  if (job.scope === "identity_restricted" && job.contains_identity !== 1) {
    throw new DomainError("export.identity_flag_required", "Identity exports must set contains_identity.");
  }
  db.prepare("UPDATE export_job SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(
    approvedBy,
    nowIso(),
    jobId,
  );
  return { ...job, status: "approved", approved_by: approvedBy, approved_at: nowIso() };
}

export function completeExport(
  db: Db,
  jobId: string,
  output: { content: string; rowCount: number; outputPath?: string | null },
): ExportJobRow {
  const job = getExportJob(db, jobId);
  if (!job) {
    throw new DomainError("export.not_found", `Export job ${jobId} not found.`);
  }
  const checksum = sha256Hex(output.content);
  db.prepare(
    `UPDATE export_job SET status = 'completed', completed_at = ?, row_count = ?, output_sha256 = ?, output_path = ? WHERE id = ?`,
  ).run(nowIso(), output.rowCount, checksum, output.outputPath ?? null, jobId);
  return {
    ...job,
    status: "completed",
    completed_at: nowIso(),
    row_count: output.rowCount,
    output_sha256: checksum,
    output_path: output.outputPath ?? null,
  };
}

export function denyExport(db: Db, jobId: string, reason: string): boolean {
  return (
    db.prepare("UPDATE export_job SET status = 'cancelled', denial_reason = ? WHERE id = ?").run(reason, jobId)
      .changes > 0
  );
}

export interface RetentionPolicyRow {
  id: string;
  organization_id: string;
  entity_type: string;
  retention_months: number | null;
  action_on_expiry: "anonymize" | "delete" | "review";
  lawful_basis: string | null;
  updated_by: string | null;
  updated_at: string;
}

export function upsertRetentionPolicy(
  db: Db,
  input: {
    organizationId: string;
    entityType: "participant_private_identity" | "observed_answer" | "audit_event" | "export_job" | "execution_evidence" | "documented_source";
    retentionMonths: number | null;
    actionOnExpiry: "anonymize" | "delete" | "review";
    lawfulBasis?: string | null;
    updatedBy?: string | null;
  },
): RetentionPolicyRow {
  const timestamp = nowIso();
  const existing = db
    .prepare("SELECT * FROM retention_policy WHERE organization_id = ? AND entity_type = ?")
    .get(input.organizationId, input.entityType) as RetentionPolicyRow | undefined;
  if (existing) {
    db.prepare(
      "UPDATE retention_policy SET retention_months = ?, action_on_expiry = ?, lawful_basis = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    ).run(
      input.retentionMonths,
      input.actionOnExpiry,
      input.lawfulBasis ?? null,
      input.updatedBy ?? null,
      timestamp,
      existing.id,
    );
    return {
      ...existing,
      retention_months: input.retentionMonths,
      action_on_expiry: input.actionOnExpiry,
      lawful_basis: input.lawfulBasis ?? null,
      updated_by: input.updatedBy ?? null,
      updated_at: timestamp,
    };
  }
  const row: RetentionPolicyRow = {
    id: newId("rtp"),
    organization_id: input.organizationId,
    entity_type: input.entityType,
    retention_months: input.retentionMonths,
    action_on_expiry: input.actionOnExpiry,
    lawful_basis: input.lawfulBasis ?? null,
    updated_by: input.updatedBy ?? null,
    updated_at: timestamp,
  };
  db.prepare(
    `INSERT INTO retention_policy (id, organization_id, entity_type, retention_months, action_on_expiry, lawful_basis, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.organization_id,
    row.entity_type,
    row.retention_months,
    row.action_on_expiry,
    row.lawful_basis,
    row.updated_by,
    row.updated_at,
  );
  return row;
}

export function listRetentionPolicies(db: Db, organizationId: string): RetentionPolicyRow[] {
  return db
    .prepare("SELECT * FROM retention_policy WHERE organization_id = ? ORDER BY entity_type")
    .all(organizationId) as RetentionPolicyRow[];
}

export interface RetentionAssessment {
  entityType: string;
  policy: RetentionPolicyRow | null;
  eligibleCount: number;
  oldestRecord: string | null;
  action: string;
  note: string;
}

/**
 * Reports - but never executes - retention actions, so that deletion or
 * anonymisation remains an explicit, audited human decision.
 */
export function assessRetention(db: Db, organizationId: string): RetentionAssessment[] {
  const policies = listRetentionPolicies(db, organizationId);
  return policies.map((policy) => {
    if (policy.retention_months === null) {
      return {
        entityType: policy.entity_type,
        policy,
        eligibleCount: 0,
        oldestRecord: null,
        action: "none",
        note: "No retention period configured; records are retained until a policy is set.",
      };
    }
    const cutoff = new Date(Date.now() - policy.retention_months * 30.44 * 24 * 3600 * 1000).toISOString();
    let eligibleCount = 0;
    let oldestRecord: string | null = null;
    if (policy.entity_type === "participant_private_identity") {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total, MIN(i.recorded_at) AS oldest FROM participant_private_identity i
           JOIN participant p ON p.id = i.participant_id
           WHERE p.organization_id = ? AND i.recorded_at < ?`,
        )
        .get(organizationId, cutoff) as { total: number; oldest: string | null };
      eligibleCount = row.total;
      oldestRecord = row.oldest;
    } else if (policy.entity_type === "observed_answer") {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total, MIN(oa.imported_at) AS oldest FROM observed_answer oa
           JOIN participant p ON p.id = oa.participant_id WHERE p.organization_id = ? AND oa.imported_at < ?`,
        )
        .get(organizationId, cutoff) as { total: number; oldest: string | null };
      eligibleCount = row.total;
      oldestRecord = row.oldest;
    } else if (policy.entity_type === "audit_event") {
      const row = db
        .prepare("SELECT COUNT(*) AS total, MIN(occurred_at) AS oldest FROM audit_event WHERE organization_id = ? AND occurred_at < ?")
        .get(organizationId, cutoff) as { total: number; oldest: string | null };
      eligibleCount = row.total;
      oldestRecord = row.oldest;
    } else if (policy.entity_type === "export_job") {
      const row = db
        .prepare("SELECT COUNT(*) AS total FROM export_job WHERE organization_id = ? AND requested_at < ?")
        .get(organizationId, cutoff) as { total: number };
      eligibleCount = row.total;
    } else if (policy.entity_type === "execution_evidence") {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total FROM execution_evidence ee
           JOIN agent_task t ON t.id = ee.agent_task_id WHERE t.organization_id = ? AND ee.recorded_at < ?`,
        )
        .get(organizationId, cutoff) as { total: number };
      eligibleCount = row.total;
    } else if (policy.entity_type === "documented_source") {
      const row = db
        .prepare("SELECT COUNT(*) AS total FROM documented_source WHERE organization_id = ? AND received_at < ?")
        .get(organizationId, cutoff) as { total: number };
      eligibleCount = row.total;
    }
    return {
      entityType: policy.entity_type,
      policy,
      eligibleCount,
      oldestRecord,
      action: eligibleCount > 0 ? policy.action_on_expiry : "none",
      note:
        eligibleCount > 0
          ? `${eligibleCount} record(s) older than ${policy.retention_months} months. Proposed action: ${policy.action_on_expiry}. Requires explicit approval and is recorded in the audit log.`
          : "No records exceed the configured retention period.",
    };
  });
}

export function toExportCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  return toCsv(rows, columns);
}
