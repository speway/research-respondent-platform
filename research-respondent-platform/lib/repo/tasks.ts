/**
 * Agent and multi-agent task repository: registration, capability grants,
 * bounded JSON task contracts, approvals, attempts, evidence and retries.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, safeJsonParse } from "../util/ids.ts";
import { DomainError } from "../domain/types.ts";
import type { AgentTaskContract, TaskState } from "../domain/types.ts";

export interface AgentRow {
  id: string;
  organization_id: string;
  name: string;
  provider: string;
  kind: "ai" | "human" | "service";
  endpoint: string | null;
  auth_secret_ref: string | null;
  is_active: number;
  contact: string | null;
  registered_by: string | null;
  created_at: string;
}

export interface CapabilityRow {
  id: string;
  agent_id: string;
  capability: string;
  scope_json: string;
  max_submissions_per_day: number | null;
  granted_by: string | null;
  granted_at: string;
  revoked_at: string | null;
}

export interface AgentTaskRow {
  id: string;
  organization_id: string;
  study_id: string;
  participant_id: string;
  external_form_version_id: string | null;
  assigned_agent_id: string | null;
  kind: string;
  state: TaskState;
  contract_json: string;
  contract_sha256: string;
  idempotency_key: string;
  priority: number;
  requires_approval: number;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  attempt_count: number;
  max_attempts: number;
  expires_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  agent_task_id: string;
  attempt_number: number;
  state_from: string;
  state_to: string;
  started_at: string;
  finished_at: string | null;
  adapter: string;
  request_json: string;
  response_json: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
}

export interface EvidenceRow {
  id: string;
  agent_task_id: string;
  task_attempt_id: string | null;
  evidence_type: string;
  body_json: string;
  body_sha256: string;
  recorded_at: string;
}

export const AGENT_PROVIDERS = [
  "deepseek",
  "openai",
  "anthropic",
  "google",
  "local_deterministic",
  "human_operator",
  "mcp_generic",
  "other",
] as const;

export const AGENT_CAPABILITIES = [
  "read_field_map",
  "read_permitted_answers",
  "preflight_only",
  "submit_external_response",
  "attach_execution_evidence",
  "request_human_review",
] as const;

export function registerAgent(
  db: Db,
  input: {
    organizationId: string;
    name: string;
    provider: (typeof AGENT_PROVIDERS)[number];
    kind: "ai" | "human" | "service";
    endpoint?: string | null;
    /** Name of the environment variable holding the secret - never the secret. */
    authSecretRef?: string | null;
    contact?: string | null;
    registeredBy?: string | null;
  },
): AgentRow {
  if (!AGENT_PROVIDERS.includes(input.provider)) {
    throw new DomainError("agent.unknown_provider", `Unknown provider "${input.provider}".`, {
      allowed: AGENT_PROVIDERS,
    });
  }
  if (input.authSecretRef && /^(sk-|ghp_|Bearer\s)/i.test(input.authSecretRef)) {
    throw new DomainError(
      "agent.secret_inline",
      "authSecretRef must name an environment variable, not contain a live credential.",
    );
  }
  const existing = db
    .prepare("SELECT * FROM agent WHERE organization_id = ? AND name = ?")
    .get(input.organizationId, input.name.trim()) as AgentRow | undefined;
  if (existing) {
    return existing;
  }
  const row: AgentRow = {
    id: newId("agt"),
    organization_id: input.organizationId,
    name: input.name.trim(),
    provider: input.provider,
    kind: input.kind,
    endpoint: input.endpoint ?? null,
    auth_secret_ref: input.authSecretRef ?? null,
    is_active: 1,
    contact: input.contact ?? null,
    registered_by: input.registeredBy ?? null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO agent (id, organization_id, name, provider, kind, endpoint, auth_secret_ref, is_active, contact,
       registered_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.organization_id,
    row.name,
    row.provider,
    row.kind,
    row.endpoint,
    row.auth_secret_ref,
    row.is_active,
    row.contact,
    row.registered_by,
    row.created_at,
  );
  return row;
}

export function setAgentActive(db: Db, agentId: string, active: boolean): boolean {
  return db.prepare("UPDATE agent SET is_active = ? WHERE id = ?").run(active ? 1 : 0, agentId).changes > 0;
}

export function listAgents(db: Db, organizationId: string): Array<AgentRow & { capabilities: string[]; task_count: number }> {
  const agents = db
    .prepare(
      `SELECT a.*, (SELECT COUNT(*) FROM agent_task t WHERE t.assigned_agent_id = a.id) AS task_count
       FROM agent a WHERE a.organization_id = ? ORDER BY a.name`,
    )
    .all(organizationId) as Array<AgentRow & { task_count: number }>;
  const capabilities = db
    .prepare("SELECT agent_id, capability FROM agent_capability WHERE revoked_at IS NULL")
    .all() as Array<{ agent_id: string; capability: string }>;
  return agents.map((agent) => ({
    ...agent,
    capabilities: capabilities.filter((row) => row.agent_id === agent.id).map((row) => row.capability),
  }));
}

export function getAgent(db: Db, agentId: string): AgentRow | undefined {
  return db.prepare("SELECT * FROM agent WHERE id = ?").get(agentId) as AgentRow | undefined;
}

export function grantCapability(
  db: Db,
  input: {
    agentId: string;
    capability: (typeof AGENT_CAPABILITIES)[number];
    scope?: Record<string, unknown>;
    maxSubmissionsPerDay?: number | null;
    grantedBy?: string | null;
  },
): CapabilityRow {
  if (!AGENT_CAPABILITIES.includes(input.capability)) {
    throw new DomainError("agent.unknown_capability", `Unknown capability "${input.capability}".`, {
      allowed: AGENT_CAPABILITIES,
    });
  }
  const existing = db
    .prepare("SELECT * FROM agent_capability WHERE agent_id = ? AND capability = ?")
    .get(input.agentId, input.capability) as CapabilityRow | undefined;
  const timestamp = nowIso();
  if (existing) {
    db.prepare(
      "UPDATE agent_capability SET scope_json = ?, max_submissions_per_day = ?, granted_by = ?, granted_at = ?, revoked_at = NULL WHERE id = ?",
    ).run(
      JSON.stringify(input.scope ?? {}),
      input.maxSubmissionsPerDay ?? null,
      input.grantedBy ?? null,
      timestamp,
      existing.id,
    );
    return {
      ...existing,
      scope_json: JSON.stringify(input.scope ?? {}),
      max_submissions_per_day: input.maxSubmissionsPerDay ?? null,
      granted_by: input.grantedBy ?? null,
      granted_at: timestamp,
      revoked_at: null,
    };
  }
  const row: CapabilityRow = {
    id: newId("acp"),
    agent_id: input.agentId,
    capability: input.capability,
    scope_json: JSON.stringify(input.scope ?? {}),
    max_submissions_per_day: input.maxSubmissionsPerDay ?? null,
    granted_by: input.grantedBy ?? null,
    granted_at: timestamp,
    revoked_at: null,
  };
  db.prepare(
    `INSERT INTO agent_capability (id, agent_id, capability, scope_json, max_submissions_per_day, granted_by, granted_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    row.id,
    row.agent_id,
    row.capability,
    row.scope_json,
    row.max_submissions_per_day,
    row.granted_by,
    row.granted_at,
  );
  return row;
}

export function revokeCapability(db: Db, capabilityId: string): boolean {
  return db
    .prepare("UPDATE agent_capability SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(nowIso(), capabilityId).changes > 0;
}

export function listCapabilities(db: Db, agentId: string): CapabilityRow[] {
  return db.prepare("SELECT * FROM agent_capability WHERE agent_id = ? ORDER BY capability").all(agentId) as CapabilityRow[];
}

export function activeCapabilities(db: Db, agentId: string): string[] {
  return (
    db
      .prepare("SELECT capability FROM agent_capability WHERE agent_id = ? AND revoked_at IS NULL")
      .all(agentId) as Array<{ capability: string }>
  ).map((row) => row.capability);
}

// ------------------------------------------------------------------- tasks --

export function createAgentTask(
  db: Db,
  input: {
    organizationId: string;
    studyId: string;
    participantId: string;
    externalFormVersionId?: string | null;
    assignedAgentId?: string | null;
    kind: "preflight_mapping" | "compose_form_payload" | "submit_external_response" | "verify_submission" | "collect_documented_answers";
    contract: AgentTaskContract;
    contractSha256: string;
    idempotencyKey: string;
    priority?: number;
    requiresApproval?: boolean;
    maxAttempts?: number;
    expiresAt?: string | null;
    createdBy?: string | null;
  },
): AgentTaskRow {
  const existing = db
    .prepare("SELECT * FROM agent_task WHERE idempotency_key = ?")
    .get(input.idempotencyKey) as AgentTaskRow | undefined;
  if (existing) {
    return existing;
  }
  const timestamp = nowIso();
  const row: AgentTaskRow = {
    id: newId("tsk"),
    organization_id: input.organizationId,
    study_id: input.studyId,
    participant_id: input.participantId,
    external_form_version_id: input.externalFormVersionId ?? null,
    assigned_agent_id: input.assignedAgentId ?? null,
    kind: input.kind,
    state: "draft",
    contract_json: JSON.stringify(input.contract),
    contract_sha256: input.contractSha256,
    idempotency_key: input.idempotencyKey,
    priority: input.priority ?? 100,
    requires_approval: input.requiresApproval === false ? 0 : 1,
    approved_by: null,
    approved_at: null,
    approval_note: null,
    queued_at: null,
    started_at: null,
    finished_at: null,
    attempt_count: 0,
    max_attempts: input.maxAttempts ?? 3,
    expires_at: input.expiresAt ?? null,
    last_error: null,
    created_by: input.createdBy ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  db.prepare(
    `INSERT INTO agent_task (id, organization_id, study_id, participant_id, external_form_version_id, assigned_agent_id,
       kind, state, contract_json, contract_sha256, idempotency_key, priority, requires_approval, approved_by,
       approved_at, approval_note, queued_at, started_at, finished_at, attempt_count, max_attempts, expires_at,
       last_error, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    row.id,
    row.organization_id,
    row.study_id,
    row.participant_id,
    row.external_form_version_id,
    row.assigned_agent_id,
    row.kind,
    row.state,
    row.contract_json,
    row.contract_sha256,
    row.idempotency_key,
    row.priority,
    row.requires_approval,
    row.max_attempts,
    row.expires_at,
    row.created_by,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function getAgentTask(db: Db, taskId: string): AgentTaskRow | undefined {
  return db.prepare("SELECT * FROM agent_task WHERE id = ?").get(taskId) as AgentTaskRow | undefined;
}

export function getAgentTaskByIdempotencyKey(db: Db, key: string): AgentTaskRow | undefined {
  return db.prepare("SELECT * FROM agent_task WHERE idempotency_key = ?").get(key) as AgentTaskRow | undefined;
}

export function listAgentTasks(
  db: Db,
  filter: { organizationId: string; studyId?: string; state?: string; kind?: string; assignedAgentId?: string; limit?: number; offset?: number },
): Array<AgentTaskRow & { pseudonym: string; study_code: string; agent_name: string | null }> {
  const clauses = ["t.organization_id = ?"];
  const params: unknown[] = [filter.organizationId];
  if (filter.studyId) {
    clauses.push("t.study_id = ?");
    params.push(filter.studyId);
  }
  if (filter.state) {
    clauses.push("t.state = ?");
    params.push(filter.state);
  }
  if (filter.kind) {
    clauses.push("t.kind = ?");
    params.push(filter.kind);
  }
  if (filter.assignedAgentId) {
    clauses.push("t.assigned_agent_id = ?");
    params.push(filter.assignedAgentId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  return db
    .prepare(
      `SELECT t.*, p.pseudonym, s.code AS study_code, a.name AS agent_name
       FROM agent_task t
       JOIN participant p ON p.id = t.participant_id
       JOIN study s ON s.id = t.study_id
       LEFT JOIN agent a ON a.id = t.assigned_agent_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY CASE t.state WHEN 'needs_review' THEN 0 WHEN 'approved' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
                t.priority, t.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<
    AgentTaskRow & { pseudonym: string; study_code: string; agent_name: string | null }
  >;
}

export function countAgentTasks(db: Db, organizationId: string): Record<string, number> {
  const rows = db
    .prepare("SELECT state, COUNT(*) AS total FROM agent_task WHERE organization_id = ? GROUP BY state")
    .all(organizationId) as Array<{ state: string; total: number }>;
  return Object.fromEntries(rows.map((row) => [row.state, row.total]));
}

export function updateTaskState(
  db: Db,
  taskId: string,
  patch: {
    state?: TaskState;
    approvedBy?: string | null;
    approvedAt?: string | null;
    approvalNote?: string | null;
    queuedAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    attemptCount?: number;
    lastError?: string | null;
    assignedAgentId?: string | null;
  },
): AgentTaskRow {
  const current = getAgentTask(db, taskId);
  if (!current) {
    throw new DomainError("task.not_found", `Task ${taskId} not found.`);
  }
  const next: AgentTaskRow = {
    ...current,
    state: patch.state ?? current.state,
    approved_by: patch.approvedBy === undefined ? current.approved_by : patch.approvedBy,
    approved_at: patch.approvedAt === undefined ? current.approved_at : patch.approvedAt,
    approval_note: patch.approvalNote === undefined ? current.approval_note : patch.approvalNote,
    queued_at: patch.queuedAt === undefined ? current.queued_at : patch.queuedAt,
    started_at: patch.startedAt === undefined ? current.started_at : patch.startedAt,
    finished_at: patch.finishedAt === undefined ? current.finished_at : patch.finishedAt,
    attempt_count: patch.attemptCount ?? current.attempt_count,
    last_error: patch.lastError === undefined ? current.last_error : patch.lastError,
    assigned_agent_id: patch.assignedAgentId === undefined ? current.assigned_agent_id : patch.assignedAgentId,
    updated_at: nowIso(),
  };
  db.prepare(
    `UPDATE agent_task SET state = ?, approved_by = ?, approved_at = ?, approval_note = ?, queued_at = ?, started_at = ?,
       finished_at = ?, attempt_count = ?, last_error = ?, assigned_agent_id = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.state,
    next.approved_by,
    next.approved_at,
    next.approval_note,
    next.queued_at,
    next.started_at,
    next.finished_at,
    next.attempt_count,
    next.last_error,
    next.assigned_agent_id,
    next.updated_at,
    taskId,
  );
  return next;
}

export function parseContract(row: AgentTaskRow): AgentTaskContract {
  return safeJsonParse<AgentTaskContract>(row.contract_json, {} as AgentTaskContract);
}

export function startAttempt(
  db: Db,
  input: { taskId: string; stateFrom: TaskState; stateTo: TaskState; adapter: string; request: unknown },
): { attemptId: string; attemptNumber: number } {
  const task = getAgentTask(db, input.taskId);
  if (!task) {
    throw new DomainError("task.not_found", `Task ${input.taskId} not found.`);
  }
  const attemptNumber = task.attempt_count + 1;
  const attemptId = newId("att");
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO task_attempt (id, agent_task_id, attempt_number, state_from, state_to, started_at, finished_at,
         adapter, request_json, response_json, error_code, error_message, retryable)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
    ).run(
      attemptId,
      input.taskId,
      attemptNumber,
      input.stateFrom,
      input.stateTo,
      nowIso(),
      input.adapter,
      JSON.stringify(input.request),
    );
    db.prepare("UPDATE agent_task SET attempt_count = ?, updated_at = ? WHERE id = ?").run(
      attemptNumber,
      nowIso(),
      input.taskId,
    );
  });
  tx();
  return { attemptId, attemptNumber };
}

export function finishAttempt(
  db: Db,
  input: {
    attemptId: string;
    response: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryable?: boolean | null;
  },
): void {
  db.prepare(
    `UPDATE task_attempt SET finished_at = ?, response_json = ?, error_code = ?, error_message = ?, retryable = ?
     WHERE id = ?`,
  ).run(
    nowIso(),
    JSON.stringify(input.response ?? null),
    input.errorCode ?? null,
    input.errorMessage ?? null,
    input.retryable === null || input.retryable === undefined ? null : input.retryable ? 1 : 0,
    input.attemptId,
  );
}

export function recordEvidence(
  db: Db,
  input: {
    agentTaskId: string;
    taskAttemptId?: string | null;
    evidenceType: string;
    body: unknown;
    bodySha256: string;
  },
): string {
  const id = newId("evd");
  db.prepare(
    `INSERT INTO execution_evidence (id, agent_task_id, task_attempt_id, evidence_type, body_json, body_sha256, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.agentTaskId,
    input.taskAttemptId ?? null,
    input.evidenceType,
    JSON.stringify(input.body),
    input.bodySha256,
    nowIso(),
  );
  return id;
}

export function listAttempts(db: Db, taskId: string): AttemptRow[] {
  return db
    .prepare("SELECT * FROM task_attempt WHERE agent_task_id = ? ORDER BY attempt_number")
    .all(taskId) as AttemptRow[];
}

export function listEvidence(db: Db, taskId: string): EvidenceRow[] {
  return db
    .prepare("SELECT * FROM execution_evidence WHERE agent_task_id = ? ORDER BY recorded_at")
    .all(taskId) as EvidenceRow[];
}

export function taskQueueSummary(db: Db, organizationId: string) {
  const byState = db
    .prepare("SELECT state, COUNT(*) AS total FROM agent_task WHERE organization_id = ? GROUP BY state")
    .all(organizationId) as Array<{ state: string; total: number }>;
  const requiresApproval = db
    .prepare("SELECT COUNT(*) AS total FROM agent_task WHERE organization_id = ? AND requires_approval = 1 AND state = 'validated'")
    .get(organizationId) as { total: number };
  const submissions = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN t.state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN t.state IN ('failed','needs_review') THEN 1 ELSE 0 END) AS problematic
       FROM agent_task t WHERE t.organization_id = ? AND t.kind = 'submit_external_response'`,
    )
    .get(organizationId) as { total: number; succeeded: number | null; problematic: number | null };
  return {
    byState: Object.fromEntries(byState.map((row) => [row.state, row.total])),
    awaitingApproval: requiresApproval.total,
    externalSubmissions: {
      total: submissions.total,
      succeeded: submissions.succeeded ?? 0,
      problematic: submissions.problematic ?? 0,
    },
  };
}
