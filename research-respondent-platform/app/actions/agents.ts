"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "../../lib/services/session.ts";
import { PERMISSIONS, assertAuthorized } from "../../lib/services/authz.ts";
import { recordAudit } from "../../lib/services/audit.ts";
import { grantCapability, registerAgent, revokeCapability, setAgentActive } from "../../lib/repo/tasks.ts";
import {
  approveTask,
  cancelTask,
  createTaskFromPreflight,
  queueTask,
  retryTask,
  runTask,
  validateTask,
} from "../../lib/services/orchestration.ts";
import { loadMappingSourceContext } from "../../lib/services/preflight-context.ts";
import { buildPreflight } from "../../lib/domain/mapping.ts";
import { listFieldMappings, listFormFields, toFieldInput, toMappingCandidate } from "../../lib/repo/forms.ts";
import { listAnswersWithItems } from "../../lib/repo/assessments.ts";
import { DomainError } from "../../lib/domain/types.ts";
import type { ActionResult } from "./studies.ts";

function failure(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, message: `${error.code}: ${error.message}`, detail: error.detail };
  }
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

export async function registerAgentAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.agentWrite);
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(120),
        provider: z.enum([
          "deepseek",
          "openai",
          "anthropic",
          "google",
          "local_deterministic",
          "human_operator",
          "mcp_generic",
          "other",
        ]),
        kind: z.enum(["ai", "human", "service"]),
        endpoint: z.string().trim().max(400).optional(),
        authSecretRef: z.string().trim().max(200).optional(),
        contact: z.string().trim().max(200).optional(),
      })
      .safeParse({
        name: formData.get("name"),
        provider: formData.get("provider"),
        kind: formData.get("kind"),
        endpoint: formData.get("endpoint") ?? "",
        authSecretRef: formData.get("authSecretRef") ?? "",
        contact: formData.get("contact") ?? "",
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    const agent = registerAgent(db, {
      organizationId: actor.organizationId,
      name: parsed.data.name,
      provider: parsed.data.provider,
      kind: parsed.data.kind,
      endpoint: parsed.data.endpoint || null,
      authSecretRef: parsed.data.authSecretRef || null,
      contact: parsed.data.contact || null,
      registeredBy: actor.id,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "agent.register",
      entityType: "agent",
      entityId: agent.id,
      outcome: "success",
      severity: "notice",
      detail: {
        name: agent.name,
        provider: agent.provider,
        kind: agent.kind,
        authSecretRef: agent.auth_secret_ref,
        note: "authSecretRef stores the name of an environment variable, never a credential value.",
      },
    });
    revalidatePath("/agents");
    return { ok: true, message: `Agent "${agent.name}" registered. Grant capabilities explicitly.` };
  } catch (error) {
    return failure(error);
  }
}

export async function grantCapabilityAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.agentWrite);
    const agentId = String(formData.get("agentId") ?? "");
    const capability = String(formData.get("capability") ?? "");
    const parsed = z
      .enum([
        "read_field_map",
        "read_permitted_answers",
        "preflight_only",
        "submit_external_response",
        "attach_execution_evidence",
        "request_human_review",
      ])
      .safeParse(capability);
    if (!parsed.success) {
      return { ok: false, message: "Unknown capability." };
    }
    const maxPerDayRaw = String(formData.get("maxSubmissionsPerDay") ?? "").trim();
    const maxPerDay = maxPerDayRaw ? Number.parseInt(maxPerDayRaw, 10) : null;
    const row = grantCapability(db, {
      agentId,
      capability: parsed.data,
      scope: { studyIds: String(formData.get("studyScope") ?? "").split(",").map((value) => value.trim()).filter(Boolean) },
      maxSubmissionsPerDay: Number.isFinite(maxPerDay) ? maxPerDay : null,
      grantedBy: actor.id,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "agent.capability.grant",
      entityType: "agent_capability",
      entityId: row.id,
      outcome: "success",
      severity: parsed.data === "submit_external_response" ? "warning" : "notice",
      detail: {
        agentId,
        capability: parsed.data,
        maxSubmissionsPerDay: row.max_submissions_per_day,
        note:
          parsed.data === "submit_external_response"
            ? "Granting submission capability does not create a verified submission path; tasks still fail closed without one."
            : undefined,
      },
    });
    revalidatePath("/agents");
    return { ok: true, message: `Capability ${parsed.data} granted.` };
  } catch (error) {
    return failure(error);
  }
}

export async function revokeCapabilityAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.agentWrite);
    const capabilityId = String(formData.get("capabilityId") ?? "");
    const agentId = String(formData.get("agentId") ?? "");
    const revoked = revokeCapability(db, capabilityId);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "agent.capability.revoke",
      entityType: "agent_capability",
      entityId: capabilityId,
      outcome: revoked ? "success" : "failure",
      severity: "warning",
      detail: { agentId },
    });
    revalidatePath("/agents");
    return { ok: revoked, message: revoked ? "Capability revoked." : "Capability not found or already revoked." };
  } catch (error) {
    return failure(error);
  }
}

export async function toggleAgentAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.agentWrite);
    const agentId = String(formData.get("agentId") ?? "");
    const active = String(formData.get("active") ?? "false") === "true";
    setAgentActive(db, agentId, active);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: active ? "agent.activate" : "agent.deactivate",
      entityType: "agent",
      entityId: agentId,
      outcome: "success",
      severity: "notice",
      detail: { active },
    });
    revalidatePath("/agents");
    return { ok: true, message: active ? "Agent activated." : "Agent deactivated; queued tasks will not run." };
  } catch (error) {
    return failure(error);
  }
}

export async function createTaskAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    const participantId = String(formData.get("participantId") ?? "");
    const externalFormVersionId = String(formData.get("externalFormVersionId") ?? "");
    const assignedAgentId = String(formData.get("assignedAgentId") ?? "") || null;
    const taskKind = String(formData.get("taskKind") ?? "preflight_mapping");
    assertAuthorized(actor, PERMISSIONS.agentWrite, { studyId });
    const parsedKind = z
      .enum(["preflight_mapping", "compose_form_payload", "submit_external_response", "verify_submission", "collect_documented_answers"])
      .safeParse(taskKind);
    if (!parsedKind.success) {
      return { ok: false, message: "Unknown task kind." };
    }
    const fields = listFormFields(db, externalFormVersionId);
    if (fields.length === 0) {
      return { ok: false, message: "Capture the form structure version before creating a task." };
    }
    const mappings = listFieldMappings(db, studyId, externalFormVersionId);
    const context = loadMappingSourceContext(db, { participantId, studyId });
    const consent = db
      .prepare(
        `SELECT status, consent_version, withdrawn_at FROM consent_record
         WHERE participant_id = ? AND (study_id = ? OR study_id IS NULL)
         ORDER BY recorded_at DESC LIMIT 1`,
      )
      .get(participantId, studyId) as { status: string; consent_version: string; withdrawn_at: string | null } | undefined;

    const preflight = buildPreflight({
      studyId,
      participantId,
      externalFormVersionId,
      fields: fields.map(toFieldInput),
      mappings: mappings.map(toMappingCandidate),
      context,
      consent: {
        status: consent?.status ?? "none",
        version: consent?.consent_version ?? null,
        withdrawnAt: consent?.withdrawn_at ?? null,
      },
      platformSubmissionAuthorized: false,
      generatedAt: new Date().toISOString(),
    });

    const answers = listAnswersWithItems(db, context.answers[0]?.sessionId ?? "");
    const permittedAnswers = answers
      .filter((answer) => answer.is_missing === 0 && answer.value_numeric !== null)
      .slice(0, 100)
      .map((answer) => ({
        itemCode: answer.item_code,
        questionText: answer.question_text,
        value: String(answer.value_coded ?? answer.value_numeric ?? answer.raw_value_text),
        collectedAt: answer.collected_at,
        documentedSourceId: answer.source_documented_source_id,
        sourceLocator: answer.source_locator,
      }));

    const task = createTaskFromPreflight({
      db,
      actor,
      studyId,
      participantId,
      externalFormVersionId,
      assignedAgentId,
      taskKind: parsedKind.data,
      preflight,
      permittedAnswers,
    });
    revalidatePath("/agents");
    return {
      ok: true,
      message: `Task created in state ${task.state}. Idempotency key ${task.idempotency_key.slice(0, 16)}…; approval required before it can be queued.`,
      detail: { taskId: task.id, blockingReasons: preflight.blockingReasons },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function validateTaskAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const taskId = String(formData.get("taskId") ?? "");
    const task = validateTask(db, actor, taskId);
    revalidatePath("/agents");
    return { ok: true, message: `Task validated (state ${task.state}).` };
  } catch (error) {
    return failure(error);
  }
}

export async function approveTaskAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const taskId = String(formData.get("taskId") ?? "");
    const note = String(formData.get("note") ?? "").trim();
    const task = approveTask(db, actor, taskId, note);
    revalidatePath("/agents");
    return { ok: true, message: `Task approved by ${actor.label} (state ${task.state}).` };
  } catch (error) {
    return failure(error);
  }
}

export async function queueTaskAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const taskId = String(formData.get("taskId") ?? "");
    const task = queueTask(db, actor, taskId);
    revalidatePath("/agents");
    return { ok: true, message: `Task state: ${task.state}.` };
  } catch (error) {
    return failure(error);
  }
}

export async function runTaskAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const taskId = String(formData.get("taskId") ?? "");
    const adapterId = String(formData.get("adapterId") ?? "local-deterministic");
    const outcome = await runTask({ db, actor, taskId, adapterId });
    revalidatePath("/agents");
    return {
      ok: outcome.result.outcome !== "failed",
      message: `${outcome.result.outcome}: ${outcome.result.message}${
        outcome.result.blockedByPolicy ? " (blocked by policy: no authorized external submission path)" : ""
      }`,
      detail: {
        retry: outcome.retry,
        evidenceIds: outcome.evidenceIds,
        externalReceipt: outcome.result.externalReceipt,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function retryTaskAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const taskId = String(formData.get("taskId") ?? "");
    const task = retryTask(db, actor, taskId);
    revalidatePath("/agents");
    return { ok: true, message: `Task requeued for attempt ${task.attempt_count + 1} of ${task.max_attempts}.` };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelTaskAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const taskId = String(formData.get("taskId") ?? "");
    const reason = String(formData.get("reason") ?? "").trim() || "cancelled by operator";
    const task = cancelTask(db, actor, taskId, reason);
    revalidatePath("/agents");
    return { ok: true, message: `Task cancelled (state ${task.state}).` };
  } catch (error) {
    return failure(error);
  }
}
