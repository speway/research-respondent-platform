/**
 * Multi-agent task orchestration service.
 *
 * Responsibilities:
 *   - build a bounded, pseudonymous JSON contract from stored mappings and
 *     documented answers;
 *   - validate it before any work is queued;
 *   - enforce human approval for consequential work;
 *   - execute through a registered adapter, capturing attempts and evidence;
 *   - retry only when the adapter declares the failure retryable, respecting
 *     the attempt budget and the idempotency key.
 *
 * The service never contacts an external provider directly: providers are
 * reached exclusively through `TaskAdapter` implementations.
 */
import type { Db } from "../../db/index.ts";
import { DomainError } from "../domain/types.ts";
import type {
  Actor,
  AgentTaskContract,
  PreflightReport,
  TaskExecutionRequest,
  TaskExecutionResult,
  TaskState,
} from "../domain/types.ts";
import { hashJson, newId, nowIso, sha256Hex } from "../util/ids.ts";
import {
  activeCapabilities,
  createAgentTask,
  finishAttempt,
  getAgentTask,
  listEvidence,
  recordEvidence,
  startAttempt,
  updateTaskState,
  type AgentTaskRow,
} from "../repo/tasks.ts";
import { buildIdempotencyKey, hashContract, retryPolicy, validateContract } from "../domain/task-flow.ts";
import { resolveAdapter } from "../domain/adapters/index.ts";
import { recordAudit } from "./audit.ts";
import { assertOwned } from "./ownership.ts";
import { assertAuthorized, PERMISSIONS } from "./authz.ts";

export interface BuildContractInput {
  db: Db;
  actor: Actor;
  studyId: string;
  participantId: string;
  externalFormVersionId: string | null;
  taskKind: AgentTaskContract["taskKind"];
  preflight: PreflightReport;
  permittedAnswers: AgentTaskContract["permittedAnswers"];
  expiresInHours?: number;
  notes?: string[];
}

export function buildTaskContract(input: BuildContractInput): AgentTaskContract {
  assertOwned(input.db, input.actor, "study", input.studyId);
  assertOwned(input.db, input.actor, "participant", input.participantId);
  if (input.externalFormVersionId) assertOwned(input.db, input.actor, "formVersion", input.externalFormVersionId);
  const taskId = newId("ctr");
  const expiresAt = new Date(Date.now() + (input.expiresInHours ?? 72) * 3600_000).toISOString();
  const study = input.db.prepare("SELECT code FROM study WHERE id = ?").get(input.studyId) as { code: string } | undefined;
  if (!study) {
    throw new DomainError("task.unknown_study", `Study ${input.studyId} not found.`);
  }
  const pseudonym = input.db.prepare("SELECT pseudonym FROM participant WHERE id = ?").get(input.participantId) as
    | { pseudonym: string }
    | undefined;
  if (!pseudonym) {
    throw new DomainError("task.unknown_participant", `Participant ${input.participantId} not found.`);
  }
  const formTitle = input.externalFormVersionId
    ? ((input.db
        .prepare(
          `SELECT f.title FROM external_form_version v JOIN external_form f ON f.id = v.external_form_id WHERE v.id = ?`,
        )
        .get(input.externalFormVersionId) as { title: string } | undefined)?.title ?? null)
    : null;

  const maySubmit = input.taskKind === "submit_external_response" && input.preflight.authorization.submissionAllowedByPlatform;

  return {
    contractVersion: "1.0",
    taskId,
    taskKind: input.taskKind,
    studyId: input.studyId,
    studyCode: study.code,
    participantPseudonym: pseudonym.pseudonym,
    externalFormVersionId: input.externalFormVersionId,
    externalFormTitle: formTitle,
    fieldMap: input.preflight.fields.map((field) => ({
      fieldId: field.fieldId,
      fieldTitle: field.fieldTitle,
      fieldType:
        (input.db.prepare("SELECT field_type FROM external_form_field WHERE field_id = ? LIMIT 1").get(field.fieldId) as
          | { field_type: string }
          | undefined)?.field_type as AgentTaskContract["fieldMap"][number]["fieldType"] ?? "unknown",
      required: false,
      value: field.resolvedValue ?? null,
      valueKind: field.valueKind,
      provenance: field.issues.length > 0 ? field.issues.map((issue) => issue.code).join("; ") : "documented source",
    })),
    permittedAnswers: input.permittedAnswers,
    permissions: {
      mayReadPermittedAnswers: true,
      maySubmitExternalResponse: maySubmit,
      mayAttachEvidence: true,
      mayRequestHumanReview: true,
      forbiddenScopes: [
        "participant_private_identity",
        "other_studies",
        "audit_event_write",
        "export_creation",
      ],
    },
    expiresAt,
    idempotencyKey: buildIdempotencyKey({
      studyId: input.studyId,
      participantId: input.participantId,
      externalFormVersionId: input.externalFormVersionId,
      taskKind: input.taskKind,
      contractVersion: "1.0",
    }),
    callback: { mode: "none", url: null },
    notes: [
      "Contract contains pseudonymous identifiers only.",
      "Values are copied from documented participant answers; missing answers are never filled.",
      ...(input.notes ?? []),
    ],
  };
}

export interface CreateTaskInput {
  db: Db;
  actor: Actor;
  studyId: string;
  participantId: string;
  externalFormVersionId: string | null;
  assignedAgentId: string | null;
  taskKind: AgentTaskContract["taskKind"];
  preflight: PreflightReport;
  permittedAnswers: AgentTaskContract["permittedAnswers"];
  priority?: number;
  expiresInHours?: number;
}

export function createTaskFromPreflight(input: CreateTaskInput): AgentTaskRow {
  const { db, actor } = input;
  assertAuthorized(actor, PERMISSIONS.agentWrite, { studyId: input.studyId });
  const contract = buildTaskContract({
    db,
    actor,
    studyId: input.studyId,
    participantId: input.participantId,
    externalFormVersionId: input.externalFormVersionId,
    taskKind: input.taskKind,
    preflight: input.preflight,
    permittedAnswers: input.permittedAnswers,
    expiresInHours: input.expiresInHours,
  });
  const validation = validateContract(contract, nowIso());
  if (!validation.ok) {
    throw new DomainError("task.contract_invalid", "The generated contract failed validation.", {
      issues: validation.issues,
    });
  }
  const contractSha = hashContract(contract);

  const existing = db
    .prepare("SELECT * FROM agent_task WHERE idempotency_key = ?")
    .get(contract.idempotencyKey) as AgentTaskRow | undefined;
  if (existing) {
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "task.create.idempotent_replay",
      entityType: "agent_task",
      entityId: existing.id,
      studyId: input.studyId,
      participantId: input.participantId,
      outcome: "partial",
      severity: "notice",
      detail: { idempotencyKey: contract.idempotencyKey, existingState: existing.state },
    });
    return existing;
  }

  const task = createAgentTask(db, {
    organizationId: actor.organizationId,
    studyId: input.studyId,
    participantId: input.participantId,
    externalFormVersionId: input.externalFormVersionId,
    assignedAgentId: input.assignedAgentId,
    kind: input.taskKind,
    contract,
    contractSha256: contractSha,
    idempotencyKey: contract.idempotencyKey,
    priority: input.priority ?? 100,
    requiresApproval: true,
    expiresAt: contract.expiresAt,
    createdBy: actor.id,
  });

  recordAudit(db, {
    organizationId: actor.organizationId,
    actor,
    action: "task.create",
    entityType: "agent_task",
    entityId: task.id,
    studyId: input.studyId,
    participantId: input.participantId,
    outcome: "success",
    detail: {
      taskKind: input.taskKind,
      idempotencyKey: task.idempotency_key,
      contractSha256: contractSha,
      requiresApproval: true,
      blockingReasons: input.preflight.blockingReasons,
    },
  });
  return task;
}

export function validateTask(db: Db, actor: Actor, taskId: string): AgentTaskRow {
  assertOwned(db, actor, "task", taskId);
  const task = requireTask(db, taskId);
  assertAuthorized(actor, PERMISSIONS.taskExecute, { studyId: task.study_id });
  const contract = JSON.parse(task.contract_json) as AgentTaskContract;
  const validation = validateContract(contract, nowIso());
  if (!validation.ok) {
    updateTaskState(db, taskId, { state: "failed", lastError: "contract validation failed" });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "task.validate",
      entityType: "agent_task",
      entityId: taskId,
      studyId: task.study_id,
      participantId: task.participant_id,
      outcome: "failure",
      severity: "warning",
      detail: { issues: validation.issues },
    });
    throw new DomainError("task.contract_invalid", "Contract validation failed.", { issues: validation.issues });
  }
  if (hashContract(validation.contract) !== task.contract_sha256) {
    throw new DomainError(
      "task.contract_tampered",
      "The stored contract does not match its recorded hash; refusing to continue.",
      { taskId },
    );
  }
  const next = updateTaskState(db, taskId, { state: "validated" });
  recordAudit(db, {
    organizationId: actor.organizationId,
    actor,
    action: "task.validate",
    entityType: "agent_task",
    entityId: taskId,
    studyId: task.study_id,
    participantId: task.participant_id,
    outcome: "success",
    detail: { contractSha256: task.contract_sha256 },
  });
  return next;
}

export function approveTask(db: Db, actor: Actor, taskId: string, note: string): AgentTaskRow {
  assertOwned(db, actor, "task", taskId);
  const task = requireTask(db, taskId);
  assertAuthorized(actor, PERMISSIONS.taskApprove, { studyId: task.study_id });
  if (!note.trim()) {
    throw new DomainError("task.approval_note_required", "An approval note is required and is recorded in the audit trail.");
  }
  if (task.state !== "validated" && task.state !== "draft") {
    throw new DomainError("task.not_approvable", `Only draft or validated tasks can be approved (current state: ${task.state}).`);
  }
  const next = updateTaskState(db, taskId, {
    state: "approved",
    approvedBy: actor.id,
    approvedAt: nowIso(),
    approvalNote: note,
  });
  recordAudit(db, {
    organizationId: actor.organizationId,
    actor,
    action: "task.approve",
    entityType: "agent_task",
    entityId: taskId,
    studyId: task.study_id,
    participantId: task.participant_id,
    outcome: "success",
    severity: "notice",
    detail: { note, taskKind: task.kind, idempotencyKey: task.idempotency_key },
  });
  return next;
}

export function queueTask(db: Db, actor: Actor, taskId: string): AgentTaskRow {
  assertOwned(db, actor, "task", taskId);
  const task = requireTask(db, taskId);
  assertAuthorized(actor, PERMISSIONS.taskExecute, { studyId: task.study_id });
  if (task.requires_approval === 1 && task.approved_at === null) {
    throw new DomainError("task.approval_required", "This task requires recorded human approval before it can be queued.");
  }
  if (task.expires_at && Date.parse(task.expires_at) < Date.now() && task.state !== "succeeded") {
    const expired = updateTaskState(db, taskId, { state: "expired", lastError: "contract expired before execution" });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "task.expire",
      entityType: "agent_task",
      entityId: taskId,
      studyId: task.study_id,
      participantId: task.participant_id,
      outcome: "failure",
      severity: "warning",
      detail: { expiresAt: task.expires_at },
    });
    return expired;
  }
  const next = updateTaskState(db, taskId, { state: "queued", queuedAt: nowIso() });
  recordAudit(db, {
    organizationId: actor.organizationId,
    actor,
    action: "task.queue",
    entityType: "agent_task",
    entityId: taskId,
    studyId: task.study_id,
    participantId: task.participant_id,
    outcome: "success",
    detail: { attemptCount: task.attempt_count, maxAttempts: task.max_attempts },
  });
  return next;
}

export interface RunTaskInput {
  db: Db;
  actor: Actor;
  taskId: string;
  adapterId: string;
  adapterConfig?: unknown;
  /** Overrides the adapter's provider-neutral preset (used for dry runs). */
  adapterOptions?: Record<string, unknown>;
}

export interface RunTaskOutcome {
  task: AgentTaskRow;
  result: TaskExecutionResult;
  retry: { shouldRetry: boolean; delaySeconds: number; reason: string };
  attemptId: string;
  evidenceIds: string[];
}

export async function runTask(input: RunTaskInput): Promise<RunTaskOutcome> {
  const { db, actor } = input;
  assertOwned(db, actor, "task", input.taskId);
  const task = requireTask(db, input.taskId);
  assertAuthorized(actor, PERMISSIONS.taskExecute, { studyId: task.study_id });

  if (task.state === "succeeded") {
    throw new DomainError(
      "task.already_succeeded",
      "This task already succeeded. A duplicate delivery would create a second external entry, so it is refused.",
      { idempotencyKey: task.idempotency_key },
    );
  }
  if (task.state !== "queued" && task.state !== "approved") {
    throw new DomainError("task.not_runnable", `Task is ${task.state}; queue or approve it before running.`);
  }
  if (task.expires_at && Date.parse(task.expires_at) < Date.now()) {
    updateTaskState(db, task.id, { state: "expired", lastError: "expired before execution" });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "task.run",
      entityType: "agent_task",
      entityId: task.id,
      studyId: task.study_id,
      participantId: task.participant_id,
      outcome: "denied",
      severity: "warning",
      detail: { reason: "contract expired" },
    });
    throw new DomainError("task.expired", "The contract expired before execution.", { taskId: task.id });
  }

  const contract = JSON.parse(task.contract_json) as AgentTaskContract;
  const validation = validateContract(contract, nowIso());
  if (!validation.ok) {
    throw new DomainError("task.contract_invalid", "Stored contract failed validation.", { issues: validation.issues });
  }

  let adapter;
  try {
    adapter = resolveAdapter(input.adapterId, input.adapterConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DomainError("task.adapter_unavailable", message, { adapterId: input.adapterId });
  }

  const request: TaskExecutionRequest = {
    taskId: task.id,
    contract,
    attemptNumber: task.attempt_count + 1,
    idempotencyKey: task.idempotency_key,
    adapterOptions: input.adapterOptions,
  };

  const { attemptId, attemptNumber } = startAttempt(db, {
    taskId: task.id,
    stateFrom: task.state,
    stateTo: "running",
    adapter: adapter.id,
    request: { taskKind: task.kind, idempotencyKey: task.idempotency_key },
  });
  updateTaskState(db, task.id, { state: "running", startedAt: nowIso() });

  let result: TaskExecutionResult;
  try {
    result =
      task.kind === "preflight_mapping"
        ? await adapter.preflight(request)
        : await adapter.execute(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      outcome: "failed",
      message: `Adapter threw an unexpected error: ${message}`,
      retryable: false,
      errorCode: "adapter.threw",
      evidence: [{ evidenceType: "error_trace", body: { message, adapter: adapter.id } }],
    };
  }

  finishAttempt(db, {
    attemptId,
    response: {
      outcome: result.outcome,
      message: result.message,
      blockedByPolicy: result.blockedByPolicy ?? false,
      externalReceipt: result.externalReceipt ?? null,
    },
    errorCode: result.errorCode ?? null,
    errorMessage: result.outcome === "succeeded" ? null : result.message,
    retryable: result.retryable,
  });

  const evidenceIds: string[] = [];
  for (const evidence of result.evidence) {
    evidenceIds.push(
      recordEvidence(db, {
        agentTaskId: task.id,
        taskAttemptId: attemptId,
        evidenceType: evidence.evidenceType,
        body: evidence.body,
        bodySha256: sha256Hex(JSON.stringify(evidence.body)),
      }),
    );
  }

  const nextState: TaskState =
    result.outcome === "succeeded" ? "succeeded" : result.outcome === "needs_review" ? "needs_review" : "failed";
  const finished = updateTaskState(db, task.id, {
    state: nextState,
    finishedAt: nowIso(),
    lastError: result.outcome === "succeeded" ? null : result.message,
  });

  const retry = retryPolicy(nextState === "failed" ? task.attempt_count + 1 : task.attempt_count, task.max_attempts, {
    retryable: result.retryable,
  });

  recordAudit(db, {
    organizationId: actor.organizationId,
    actor,
    action: "task.run",
    entityType: "agent_task",
    entityId: task.id,
    studyId: task.study_id,
    participantId: task.participant_id,
    outcome: result.outcome === "succeeded" ? "success" : result.outcome === "needs_review" ? "partial" : "failure",
    severity: result.outcome === "succeeded" ? "notice" : "warning",
    detail: {
      adapter: adapter.id,
      attemptNumber,
      outcome: result.outcome,
      message: result.message,
      blockedByPolicy: result.blockedByPolicy ?? false,
      retryable: result.retryable,
      evidenceIds,
      externalReceipt: result.externalReceipt ?? null,
    },
  });

  return { task: finished, result, retry, attemptId, evidenceIds };
}

export function retryTask(db: Db, actor: Actor, taskId: string): AgentTaskRow {
  assertOwned(db, actor, "task", taskId);
  const task = requireTask(db, taskId);
  assertAuthorized(actor, PERMISSIONS.taskExecute, { studyId: task.study_id });
  if (task.state !== "failed" && task.state !== "needs_review") {
    throw new DomainError("task.not_retryable_state", `Task in state ${task.state} cannot be retried.`);
  }
  if (task.attempt_count >= task.max_attempts) {
    throw new DomainError(
      "task.retry_budget_exhausted",
      `Attempt budget exhausted (${task.attempt_count}/${task.max_attempts}). Record a review decision instead.`,
    );
  }
  const next = updateTaskState(db, taskId, { state: "queued", queuedAt: nowIso(), lastError: task.last_error });
  recordAudit(db, {
    organizationId: actor.organizationId,
    actor,
    action: "task.retry",
    entityType: "agent_task",
    entityId: taskId,
    studyId: task.study_id,
    participantId: task.participant_id,
    outcome: "success",
    severity: "notice",
    detail: {
      attemptCount: task.attempt_count,
      maxAttempts: task.max_attempts,
      idempotencyKey: task.idempotency_key,
      previousError: task.last_error,
    },
  });
  return next;
}

export function cancelTask(db: Db, actor: Actor, taskId: string, reason: string): AgentTaskRow {
  assertOwned(db, actor, "task", taskId);
  const task = requireTask(db, taskId);
  assertAuthorized(actor, PERMISSIONS.taskExecute, { studyId: task.study_id });
  const next = updateTaskState(db, taskId, { state: "cancelled", finishedAt: nowIso(), lastError: reason });
  recordAudit(db, {
    organizationId: actor.organizationId,
    actor,
    action: "task.cancel",
    entityType: "agent_task",
    entityId: taskId,
    studyId: task.study_id,
    participantId: task.participant_id,
    outcome: "success",
    severity: "notice",
    detail: { reason },
  });
  return next;
}

export function taskDetail(db: Db, taskId: string) {
  const task = requireTask(db, taskId);
  const attempts = db
    .prepare("SELECT * FROM task_attempt WHERE agent_task_id = ? ORDER BY attempt_number")
    .all(taskId) as Array<Record<string, unknown>>;
  const evidence = listEvidence(db, taskId);
  const audit = db
    .prepare("SELECT id, occurred_at, actor_label, action, outcome, severity, detail_json FROM audit_event WHERE entity_type = 'agent_task' AND entity_id = ? ORDER BY occurred_at")
    .all(taskId) as Array<Record<string, unknown>>;
  const pseudonym = db.prepare("SELECT pseudonym FROM participant WHERE id = ?").get(task.participant_id) as
    | { pseudonym: string }
    | undefined;
  const study = db.prepare("SELECT code, title FROM study WHERE id = ?").get(task.study_id) as
    | { code: string; title: string }
    | undefined;
  return {
    task,
    contract: JSON.parse(task.contract_json) as AgentTaskContract,
    attempts,
    evidence,
    audit,
    pseudonym: pseudonym?.pseudonym ?? "unknown",
    study: study ?? { code: "unknown", title: "unknown" },
  };
}

export function requireTask(db: Db, taskId: string): AgentTaskRow {
  const task = getAgentTask(db, taskId);
  if (!task) {
    throw new DomainError("task.not_found", `Task ${taskId} not found.`);
  }
  return task;
}

/**
 * Local dry-run of the full pipeline without any external contact. Used by the
 * evaluation/verification flow and by the UI's "preflight only" action.
 */
export async function dryRunTask(input: RunTaskInput): Promise<RunTaskOutcome> {
  return runTask({ ...input, adapterId: input.adapterId || "local-deterministic" });
}

export function contractHash(contract: AgentTaskContract): string {
  return hashJson(contract);
}

export function adapterCapabilities(adapterId: string, config?: unknown) {
  const adapter = resolveAdapter(adapterId, config);
  return { id: adapter.id, description: adapter.description, capabilities: adapter.capabilities };
}

export function agentCapabilitySummary(db: Db, agentId: string): string[] {
  return activeCapabilities(db, agentId);
}
