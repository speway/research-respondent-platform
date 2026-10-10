"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertOwned } from "../../lib/services/ownership.ts";
import { requireAuth } from "../../lib/services/session.ts";
import { PERMISSIONS, assertAuthorized } from "../../lib/services/authz.ts";
import { recordAudit } from "../../lib/services/audit.ts";
import {
  approveExport,
  denyExport,
  getExportJob,
  listExportJobs,
  requestExport,
  upsertRetentionPolicy,
  type ExportScope,
} from "../../lib/repo/exports.ts";
import { ASSESS_SCOPE_NOTE, runExportJob } from "../../lib/services/exports-runner.ts";
import { DomainError } from "../../lib/domain/types.ts";
import type { ActionResult } from "./studies.ts";

function failure(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, message: `${error.code}: ${error.message}`, detail: error.detail };
  }
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

export async function requestExportAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const parsed = z
      .object({
        scope: z.enum([
          "analytic_deidentified",
          "provenance_audit",
          "cohort_manifest",
          "task_execution_report",
          "identity_restricted",
        ]),
        format: z.enum(["csv", "json", "jsonl"]),
        studyId: z.string().trim().optional(),
      })
      .safeParse({
        scope: formData.get("scope"),
        format: formData.get("format"),
        studyId: formData.get("studyId") ?? "",
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    assertAuthorized(actor, PERMISSIONS.exportCreate, { studyId: parsed.data.studyId || null });
    if (parsed.data.scope === "identity_restricted") {
      assertAuthorized(actor, PERMISSIONS.identityRead);
    }
    if (parsed.data.studyId) assertOwned(db, actor, "study", parsed.data.studyId);
    const job = requestExport(db, {
      organizationId: actor.organizationId,
      studyId: parsed.data.studyId || null,
      format: parsed.data.format,
      scope: parsed.data.scope as ExportScope,
      requestedBy: actor.id,
      containsIdentity: parsed.data.scope === "identity_restricted",
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "export.request",
      entityType: "export_job",
      entityId: job.id,
      studyId: job.study_id,
      outcome: "success",
      severity: parsed.data.scope === "identity_restricted" ? "warning" : "notice",
      detail: {
        scope: job.scope,
        format: job.format,
        containsIdentity: job.contains_identity === 1,
        note: ASSESS_SCOPE_NOTE,
      },
    });
    revalidatePath("/audit");
    return { ok: true, message: `Export job queued (${job.scope}, ${job.format}). An approver must approve it before it runs.` };
  } catch (error) {
    return failure(error);
  }
}

export async function approveExportAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const jobId = String(formData.get("jobId") ?? "");
    assertOwned(db, actor, "export", jobId);
    assertAuthorized(actor, PERMISSIONS.exportApprove, { studyId: getExportJob(db, jobId)?.study_id });
    const job = approveExport(db, jobId, actor.id);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "export.approve",
      entityType: "export_job",
      entityId: jobId,
      studyId: job.study_id,
      outcome: "success",
      severity: job.contains_identity === 1 ? "warning" : "notice",
      detail: { scope: job.scope, format: job.format },
    });
    revalidatePath("/audit");
    return { ok: true, message: "Export approved." };
  } catch (error) {
    return failure(error);
  }
}

export async function runExportAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const jobId = String(formData.get("jobId") ?? "");
    assertOwned(db, actor, "export", jobId);
    const result = runExportJob(db, actor, jobId);
    revalidatePath("/audit");
    return {
      ok: true,
      message: `Export produced ${result.rowCount} row(s); sha256 ${result.outputSha256?.slice(0, 16) ?? "n/a"}…. ${result.consentExcluded.length} participant(s) excluded by the consent gate and recorded in the audit detail.`,
      detail: { excluded: result.consentExcluded.slice(0, 10) },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function denyExportAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const jobId = String(formData.get("jobId") ?? "");
    assertOwned(db, actor, "export", jobId);
    const reason = String(formData.get("reason") ?? "").trim() || "denied by reviewer";
    assertAuthorized(actor, PERMISSIONS.exportApprove, { studyId: getExportJob(db, jobId)?.study_id });
    const denied = denyExport(db, jobId, reason);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "export.deny",
      entityType: "export_job",
      entityId: jobId,
      outcome: denied ? "success" : "failure",
      severity: "warning",
      detail: { reason },
    });
    revalidatePath("/audit");
    return { ok: denied, message: denied ? "Export denied and recorded." : "Export job not found." };
  } catch (error) {
    return failure(error);
  }
}

export async function upsertRetentionPolicyAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.settingsWrite);
    const monthsRaw = String(formData.get("retentionMonths") ?? "").trim();
    const parsed = z
      .object({
        entityType: z.enum([
          "participant_private_identity",
          "observed_answer",
          "audit_event",
          "export_job",
          "execution_evidence",
          "documented_source",
        ]),
        actionOnExpiry: z.enum(["anonymize", "delete", "review"]),
        lawfulBasis: z.string().trim().max(500).optional(),
      })
      .safeParse({
        entityType: formData.get("entityType"),
        actionOnExpiry: formData.get("actionOnExpiry"),
        lawfulBasis: formData.get("lawfulBasis") ?? "",
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    let months: number | null = null;
    if (monthsRaw.length > 0) {
      const value = Number.parseInt(monthsRaw, 10);
      if (!Number.isFinite(value) || value < 1 || value > 1200) {
        return { ok: false, message: "Retention months must be between 1 and 1200, or left empty to retain indefinitely." };
      }
      months = value;
    }
    const policy = upsertRetentionPolicy(db, {
      organizationId: actor.organizationId,
      entityType: parsed.data.entityType,
      retentionMonths: months,
      actionOnExpiry: parsed.data.actionOnExpiry,
      lawfulBasis: parsed.data.lawfulBasis || null,
      updatedBy: actor.id,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "retention.policy.upsert",
      entityType: "retention_policy",
      entityId: policy.id,
      outcome: "success",
      severity: "notice",
      detail: {
        entityType: policy.entity_type,
        retentionMonths: policy.retention_months,
        actionOnExpiry: policy.action_on_expiry,
      },
    });
    revalidatePath("/audit");
    return { ok: true, message: `Retention policy for ${policy.entity_type} saved.` };
  } catch (error) {
    return failure(error);
  }
}

export async function downloadExportAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const jobId = String(formData.get("jobId") ?? "");
    assertOwned(db, actor, "export", jobId);
    const job = getExportJob(db, jobId);
    assertAuthorized(actor, job?.scope === "identity_restricted" ? PERMISSIONS.identityRead : PERMISSIONS.exportCreate, { studyId: job?.study_id });
    if (!job) {
      return { ok: false, message: "Export job not found." };
    }
    if (job.status !== "completed") {
      return { ok: false, message: `Export is ${job.status}; only completed exports can be re-read.` };
    }
    const jobs = listExportJobs(db, actor.organizationId, 200);
    return {
      ok: true,
      message: `Export ${jobId} completed with ${job.row_count ?? 0} rows and sha256 ${job.output_sha256 ?? "unrecorded"}. ${jobs.length} job(s) recorded for this organization.`,
    };
  } catch (error) {
    return failure(error);
  }
}
