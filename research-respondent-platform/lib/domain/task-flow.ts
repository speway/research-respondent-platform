/**
 * Agent task state machine, contract validation, idempotency and retry policy.
 *
 * Pure domain code: no database, no network, no React and no `Date.now()` — the
 * clock is injected by the caller, so a transition, a hash or an adapter run is
 * reproducible from the audit trail alone.
 */
import { createHash } from "node:crypto";
import { DomainError } from "./types.ts";
import type {
  AgentTaskContract,
  IsoTimestamp,
  RuleIssue,
  TaskExecutionRequest,
  TaskKind,
  TaskState,
  TaskTransitionResult,
} from "./types.ts";

// ------------------------------------------------------------ state machine --

export const TASK_STATES: readonly TaskState[] = [
  "draft",
  "validated",
  "approved",
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_review",
  "cancelled",
  "expired",
];

/**
 * Legal edges. Terminal states (`succeeded`, `cancelled`, `expired`) have no
 * outgoing edge: a finished task is never reopened, it is superseded by a new
 * task with a new contract.
 *
 *   draft ──▶ validated ──▶ approved ──▶ queued ──▶ running ──┬─▶ succeeded
 *     │            │            │           │          │      ├─▶ failed ─────┐
 *     │            │            │           │          │      └─▶ needs_review ┤
 *     │            │            │           │          └─▶ cancelled           │
 *     │            │            │           └─▶ expired          requeue ◀─────┘
 *     └────────────┴────────────┴───────────────▶ expired   (queued, budget-limited)
 *   draft ──▶ approved is the documented human-approval shortcut for a task
 *   whose contract was validated at build time.
 */
export const ALLOWED_TRANSITIONS: Record<TaskState, TaskState[]> = {
  draft: ["validated", "approved", "cancelled", "expired"],
  validated: ["approved", "needs_review", "cancelled", "expired"],
  approved: ["queued", "cancelled", "expired"],
  queued: ["running", "cancelled", "expired"],
  running: ["succeeded", "failed", "needs_review", "cancelled"],
  succeeded: [],
  failed: ["queued", "cancelled", "expired"],
  needs_review: ["queued", "cancelled", "expired"],
  cancelled: [],
  expired: [],
};

/** Roles that may move a task into `approved`. */
export const APPROVER_ROLES: readonly string[] = ["principal_investigator", "reviewer"];

/**
 * Targets that schedule or start new work. After `expiresAt` these are refused,
 * so an expired contract can never dispatch work; recording an outcome that
 * already happened (succeeded / failed / needs_review / cancelled) stays legal
 * so real evidence is never discarded.
 */
const WORK_STARTING_TARGETS: readonly TaskState[] = ["approved", "queued", "running"];
/** States from which `queued` is a retry of earlier attempts, not a first run. */
const REQUEUE_SOURCES: readonly TaskState[] = ["failed", "needs_review"];

export interface TransitionContext {
  actorRoles: string[];
  taskRequiresApproval: boolean;
  attemptCount: number;
  maxAttempts: number;
  /** Injected clock; the deadline is only enforced when this and `expiresAt` are set. */
  now?: IsoTimestamp;
  expiresAt?: string | null;
}

export function canTransition(from: TaskState, to: TaskState, context: TransitionContext): TaskTransitionResult {
  const base = { from, to };
  if (!TASK_STATES.includes(from) || !TASK_STATES.includes(to)) {
    return { ...base, allowed: false, reason: `unknown task state '${String(from)}' -> '${String(to)}'` };
  }
  if (isDeadlinePassed(context.expiresAt, context.now) && to !== "expired" && WORK_STARTING_TARGETS.includes(to)) {
    return {
      ...base,
      allowed: false,
      reason: `task expired at ${String(context.expiresAt)}: work-starting transition to '${to}' denied, record the outcome or move to 'expired'`,
    };
  }
  const permitted = ALLOWED_TRANSITIONS[from];
  if (!permitted.includes(to)) {
    return { ...base, allowed: false, reason: `transition ${from} -> ${to} is not part of the task state machine` };
  }
  if (to === "approved" && context.taskRequiresApproval && !context.actorRoles.some((role) => APPROVER_ROLES.includes(role))) {
    return {
      ...base,
      allowed: false,
      requiresActorRole: APPROVER_ROLES.join(" | "),
      reason: `approval requires one of the roles ${APPROVER_ROLES.join(", ")}; actor roles: ${context.actorRoles.join(", ") || "(none)"}`,
    };
  }
  if (to === "queued" && REQUEUE_SOURCES.includes(from) && context.attemptCount >= context.maxAttempts) {
    return {
      ...base,
      allowed: false,
      reason: `retry budget exhausted: ${context.attemptCount} of ${context.maxAttempts} attempts already used`,
    };
  }
  return { ...base, allowed: true, reason: `transition ${from} -> ${to} permitted` };
}

export function assertTransition(from: TaskState, to: TaskState, context: TransitionContext): TaskTransitionResult {
  const result = canTransition(from, to, context);
  if (!result.allowed) {
    throw new DomainError("task.transition_denied", `${from} -> ${to} denied: ${result.reason}`, {
      from,
      to,
      reason: result.reason,
      ...(result.requiresActorRole === undefined ? {} : { requiresActorRole: result.requiresActorRole }),
    });
  }
  return result;
}

function isDeadlinePassed(expiresAt: string | null | undefined, now: string | undefined): boolean {
  if (typeof expiresAt !== "string" || typeof now !== "string") return false;
  const deadline = Date.parse(expiresAt);
  const reference = Date.parse(now);
  if (Number.isNaN(deadline) || Number.isNaN(reference)) return false;
  return deadline <= reference;
}

/** Row shape of `agent_task`; the machine only ever produces a new frozen copy. */
export interface AgentTaskRecord {
  id: string;
  organizationId: string;
  studyId: string;
  participantId: string;
  externalFormVersionId: string | null;
  assignedAgentId: string | null;
  kind: TaskKind;
  state: TaskState;
  contract: AgentTaskContract;
  contractSha256: string;
  idempotencyKey: string;
  priority: number;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: IsoTimestamp | null;
  approvalNote: string | null;
  queuedAt: IsoTimestamp | null;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  attemptCount: number;
  maxAttempts: number;
  expiresAt: IsoTimestamp | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ApplyTransitionInput {
  now: IsoTimestamp;
  actorRoles?: string[];
  taskRequiresApproval?: boolean;
  attemptCount?: number;
  maxAttempts?: number;
  expiresAt?: string | null;
  /** Approving actor id, recorded as `approvedBy`. */
  actorId?: string | null;
  approvalNote?: string | null;
  /** Failure/review note, recorded as `lastError`. */
  errorNote?: string | null;
}

/**
 * Validates the edge and returns a new frozen task record. `attemptCount` is
 * owned by the attempt ledger (`task_attempt`) and is deliberately not rewritten
 * here, otherwise a retry could be double-counted.
 */
export function applyTransition(
  task: Readonly<AgentTaskRecord>,
  to: TaskState,
  input: ApplyTransitionInput,
): AgentTaskRecord {
  assertTransition(task.state, to, {
    actorRoles: input.actorRoles ?? [],
    taskRequiresApproval: input.taskRequiresApproval ?? task.requiresApproval,
    attemptCount: input.attemptCount ?? task.attemptCount,
    maxAttempts: input.maxAttempts ?? task.maxAttempts,
    now: input.now,
    expiresAt: input.expiresAt === undefined ? task.expiresAt : input.expiresAt,
  });
  const next: AgentTaskRecord = { ...task, state: to, updatedAt: input.now };
  if (to === "approved") {
    next.approvedAt = input.now;
    next.approvedBy = input.actorId ?? task.approvedBy;
    next.approvalNote = input.approvalNote ?? task.approvalNote;
  }
  if (to === "queued") next.queuedAt = input.now;
  if (to === "running") next.startedAt = input.now;
  if (to === "succeeded" || to === "failed" || to === "needs_review") next.finishedAt = input.now;
  if (to === "failed" || to === "needs_review") next.lastError = input.errorNote ?? task.lastError;
  if (to === "succeeded") next.lastError = null;
  Object.freeze(next);
  return next;
}

// ------------------------------------------------------- canonical hashing ---

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** JSON with object keys sorted at every depth; array order is preserved. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet<object>());
}

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DomainError("task.canonical_json_unsupported", "non-finite numbers cannot be hashed");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new DomainError("task.canonical_json_unsupported", "cyclic structure cannot be hashed");
    seen.add(value);
    const body = value.map((entry) => canonicalize(entry, seen)).join(",");
    seen.delete(value);
    return `[${body}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (seen.has(record)) throw new DomainError("task.canonical_json_unsupported", "cyclic structure cannot be hashed");
    seen.add(record);
    const body = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`)
      .join(",");
    seen.delete(record);
    return `{${body}}`;
  }
  throw new DomainError("task.canonical_json_unsupported", `value of type ${typeof value} cannot be hashed`);
}

/** Stable content hash of a contract: key order never changes the result. */
export function hashContract(contract: AgentTaskContract): string {
  return sha256Hex(canonicalJson(contract));
}

export interface IdempotencyKeyInput {
  studyId: string;
  participantId: string;
  externalFormVersionId: string | null;
  taskKind: TaskKind;
  contractVersion: string;
}

/**
 * One logical unit of work (study + participant + form version + kind +
 * contract version) always yields the same key, and any change to those
 * components yields a different key, so a retry can never create a duplicate
 * external entry.
 */
export function buildIdempotencyKey(input: IdempotencyKeyInput): string {
  return sha256Hex(
    canonicalJson({
      contractVersion: requiredComponent(input.contractVersion, "contractVersion"),
      externalFormVersionId: input.externalFormVersionId,
      participantId: requiredComponent(input.participantId, "participantId"),
      studyId: requiredComponent(input.studyId, "studyId"),
      taskKind: requiredComponent(input.taskKind, "taskKind"),
    }),
  );
}

function requiredComponent(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("task.idempotency_input_invalid", `idempotency component '${name}' must be a non-empty string`, {
      component: name,
    });
  }
  return value;
}

/**
 * A request may only execute the contract it names, with the same idempotency
 * key; anything else could record a retry against, or duplicate, other work.
 */
export function checkRequestBinding(request: TaskExecutionRequest): RuleIssue | null {
  if (request.contract.taskId !== request.taskId) {
    return {
      code: "request.task_id_mismatch",
      severity: "fail",
      message: `request.taskId '${request.taskId}' does not match contract.taskId '${request.contract.taskId}'`,
      detail: { requestTaskId: request.taskId, contractTaskId: request.contract.taskId },
    };
  }
  if (request.contract.idempotencyKey !== request.idempotencyKey) {
    return {
      code: "request.idempotency_key_mismatch",
      severity: "fail",
      message: "request.idempotencyKey does not match contract.idempotencyKey; a retry could duplicate external work",
      detail: { requestIdempotencyKey: request.idempotencyKey, contractIdempotencyKey: request.contract.idempotencyKey },
    };
  }
  return null;
}

// -------------------------------------------------------- contract validation --

export type ContractValidation =
  | { ok: true; contract: AgentTaskContract; issues: RuleIssue[] }
  | { ok: false; issues: RuleIssue[] };

const TASK_KINDS: readonly string[] = [
  "preflight_mapping",
  "compose_form_payload",
  "submit_external_response",
  "verify_submission",
  "collect_documented_answers",
];
const FIELD_TYPES: readonly string[] = [
  "short_text",
  "paragraph",
  "multiple_choice",
  "checkbox",
  "dropdown",
  "linear_scale",
  "date",
  "time",
  "grid",
  "file_upload",
  "section_header",
  "unknown",
];
const VALUE_KINDS: readonly string[] = ["text", "numeric", "option", "date", "none"];
const CALLBACK_MODES: readonly string[] = ["none", "poll", "webhook"];
/** Identity keys that must never enter the pseudonymous agent boundary. */
const FORBIDDEN_IDENTITY_KEYS: readonly string[] = ["fullname", "contactemail", "contactphone"];
/** Credential keys: only secret *references* (env var names) are allowed. */
const FORBIDDEN_CREDENTIAL_KEYS: readonly string[] = ["token", "secret", "password", "apikey"];
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates an untrusted contract before any adapter may touch it. When `now` is
 * supplied the deadline is enforced; without a clock no time comparison is made
 * (the module never reads the wall clock itself).
 */
export function validateContract(contract: unknown, now?: IsoTimestamp): ContractValidation {
  const issues: RuleIssue[] = [];
  if (!isPlainObject(contract)) {
    return { ok: false, issues: [fail("contract.not_object", "task contract must be a JSON object")] };
  }
  scanForbiddenKeys(contract, "", issues);

  const contractVersion = requireNonEmptyString(contract, "contractVersion", issues);
  if (contractVersion !== undefined && contractVersion !== "1.0") {
    issues.push(fail("contract.version_unsupported", `unsupported contractVersion '${contractVersion}'`, { contractVersion }));
  }
  requireNonEmptyString(contract, "taskId", issues);
  requireNonEmptyString(contract, "studyId", issues);
  requireNonEmptyString(contract, "studyCode", issues);
  const pseudonym = requireNonEmptyString(contract, "participantPseudonym", issues);
  if (pseudonym !== undefined && EMAIL_LIKE.test(pseudonym)) {
    // The offending value is never echoed: evidence and audit bodies must stay
    // free of identity data, even when rejecting the contract that carried it.
    issues.push(
      fail("contract.identity_in_pseudonym", "participantPseudonym looks like an e-mail address; contracts are pseudonymous only", {
        pseudonymShape: "email_like",
      }),
    );
  }
  const taskKind = requireNonEmptyString(contract, "taskKind", issues);
  if (taskKind !== undefined && !TASK_KINDS.includes(taskKind)) {
    issues.push(fail("contract.task_kind_unknown", `unknown taskKind '${taskKind}'`, { taskKind }));
  }
  if (requireNonEmptyString(contract, "idempotencyKey", issues) === undefined) {
    issues.push(fail("contract.idempotency_key_missing", "a contract without an idempotencyKey cannot be retried safely"));
  }
  const expiresAt = requireNonEmptyString(contract, "expiresAt", issues);
  if (expiresAt !== undefined) {
    const deadline = Date.parse(expiresAt);
    if (Number.isNaN(deadline)) {
      issues.push(fail("contract.expires_at_invalid", `expiresAt '${expiresAt}' is not a parsable ISO timestamp`));
    } else if (typeof now === "string" && !Number.isNaN(Date.parse(now)) && deadline <= Date.parse(now)) {
      issues.push(fail("contract.expired", `contract expired at ${expiresAt}, which is not after the injected now (${now})`));
    }
  }
  const externalFormVersionId = contract["externalFormVersionId"];
  if (externalFormVersionId !== null && typeof externalFormVersionId !== "string") {
    issues.push(fail("contract.external_form_version_invalid", "externalFormVersionId must be a string or null"));
  }

  const permissions = isPlainObject(contract["permissions"]) ? contract["permissions"] : null;
  if (permissions === null) {
    issues.push(fail("contract.permissions_missing", "permissions block is required"));
  }
  const callback = isPlainObject(contract["callback"]) ? contract["callback"] : null;
  if (callback === null) {
    issues.push(fail("contract.callback_missing", "callback block is required"));
  }

  if (permissions !== null) {
    for (const flag of [
      "mayReadPermittedAnswers",
      "maySubmitExternalResponse",
      "mayAttachEvidence",
      "mayRequestHumanReview",
    ]) {
      if (typeof permissions[flag] !== "boolean") {
        issues.push(fail("contract.permission_flag_invalid", `permissions.${flag} must be a boolean`, { flag }));
      }
    }
    if (!Array.isArray(permissions["forbiddenScopes"])) {
      issues.push(fail("contract.forbidden_scopes_missing", "permissions.forbiddenScopes must be an array of record ids"));
    }
    if (permissions["maySubmitExternalResponse"] === true) {
      if (callback !== null && callback["mode"] === "none") {
        issues.push(
          fail(
            "contract.external_submission_without_authorization_path",
            "permissions.maySubmitExternalResponse is true while callback.mode is 'none': there is no authorized path to record the submission",
          ),
        );
      }
      if (externalFormVersionId === null) {
        issues.push(
          fail("contract.external_submission_without_form_version", "permissions.maySubmitExternalResponse is true but externalFormVersionId is null"),
        );
      }
    }
    if (permissions["mayReadPermittedAnswers"] !== true && Array.isArray(contract["permittedAnswers"]) && contract["permittedAnswers"].length > 0) {
      issues.push(
        fail("contract.permitted_answers_without_permission", "permittedAnswers are present while permissions.mayReadPermittedAnswers is not true"),
      );
    }
  }

  if (callback !== null) {
    const mode = callback["mode"];
    if (typeof mode !== "string" || !CALLBACK_MODES.includes(mode)) {
      issues.push(fail("contract.callback_mode_invalid", `callback.mode must be one of ${CALLBACK_MODES.join(", ")}`));
    } else if (mode !== "none") {
      const url = callback["url"];
      if (typeof url !== "string" || !url.startsWith("https://")) {
        issues.push(fail("contract.callback_url_missing", `callback.mode '${mode}' requires an https callback.url`));
      }
    }
  }

  validateFieldMap(contract["fieldMap"], issues);
  validatePermittedAnswers(contract["permittedAnswers"], issues);
  if (!Array.isArray(contract["notes"])) {
    issues.push(fail("contract.notes_missing", "notes must be an array of strings"));
  }

  const failures = issues.filter((issue) => issue.severity === "fail");
  if (failures.length > 0) return { ok: false, issues };
  return { ok: true, contract: contract as unknown as AgentTaskContract, issues };
}

function validateFieldMap(value: unknown, issues: RuleIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(fail("contract.field_map_missing", "fieldMap must be an array of mapped external fields"));
    return;
  }
  if (value.length === 0) {
    issues.push({ code: "contract.field_map_empty", severity: "warn", message: "fieldMap is empty: the payload would contain no fields" });
  }
  value.forEach((entry, index) => {
    const path = `fieldMap[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(fail("contract.field_map_entry_invalid", `${path} must be an object`, { path }));
      return;
    }
    for (const key of ["fieldId", "fieldTitle", "fieldType", "valueKind", "provenance"]) {
      if (typeof entry[key] !== "string" || entry[key] === "") {
        issues.push(fail("contract.field_map_entry_invalid", `${path}.${key} is required and must be a non-empty string`, { path, key }));
      }
    }
    if (typeof entry["fieldType"] === "string" && !FIELD_TYPES.includes(entry["fieldType"])) {
      issues.push(fail("contract.field_type_unknown", `${path}.fieldType '${entry["fieldType"]}' is not a known external field type`, { path }));
    }
    if (typeof entry["valueKind"] === "string" && !VALUE_KINDS.includes(entry["valueKind"])) {
      issues.push(fail("contract.value_kind_unknown", `${path}.valueKind '${entry["valueKind"]}' is not a known value kind`, { path }));
    }
    if (typeof entry["required"] !== "boolean") {
      issues.push(fail("contract.field_map_entry_invalid", `${path}.required must be a boolean`, { path }));
    }
    if (entry["value"] !== null && typeof entry["value"] !== "string") {
      issues.push(fail("contract.field_value_invalid", `${path}.value must be a string or null`, { path }));
    }
    if (entry["value"] === null && entry["valueKind"] !== "none") {
      issues.push(fail("contract.field_value_missing", `${path} declares valueKind '${String(entry["valueKind"])}' but carries no value`, { path }));
    }
    if (entry["value"] === null && entry["valueKind"] === "none" && entry["required"] === true) {
      issues.push({
        code: "contract.required_field_without_source",
        severity: "warn",
        message: `${path} is required but has no documented source; the dry run will block`,
        detail: { path },
      });
    }
  });
}

function validatePermittedAnswers(value: unknown, issues: RuleIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(fail("contract.permitted_answers_invalid", "permittedAnswers must be an array"));
    return;
  }
  value.forEach((entry, index) => {
    const path = `permittedAnswers[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(fail("contract.permitted_answers_invalid", `${path} must be an object`, { path }));
      return;
    }
    for (const key of ["itemCode", "questionText", "value", "documentedSourceId", "sourceLocator"]) {
      if (typeof entry[key] !== "string" || entry[key] === "") {
        issues.push(fail("contract.permitted_answers_invalid", `${path}.${key} is required and must be a non-empty string`, { path, key }));
      }
    }
  });
}

function scanForbiddenKeys(value: unknown, path: string, issues: RuleIssue[], seen: WeakSet<object> = new WeakSet()): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    value.forEach((entry, index) => scanForbiddenKeys(entry, `${path}[${index}]`, issues, seen));
    return;
  }
  if (!isPlainObject(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const childPath = path === "" ? key : `${path}.${key}`;
    if (FORBIDDEN_IDENTITY_KEYS.includes(normalized)) {
      issues.push(
        fail("contract.identity_field_present", `identity field '${key}' must never appear in a task contract`, { path: childPath }),
      );
    }
    if (FORBIDDEN_CREDENTIAL_KEYS.includes(normalized)) {
      issues.push(
        fail(
          "contract.credential_key_present",
          `credential key '${key}' must never appear in a task contract; reference the secret by environment variable name instead`,
          { path: childPath },
        ),
      );
    }
    scanForbiddenKeys(child, childPath, issues, seen);
  }
}

function requireNonEmptyString(source: Record<string, unknown>, key: string, issues: RuleIssue[]): string | undefined {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(fail("contract.field_required", `contract.${key} is required and must be a non-empty string`, { key }));
    return undefined;
  }
  return value;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): RuleIssue {
  return detail === undefined ? { code, severity: "fail", message } : { code, severity: "fail", message, detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------- retry policy --

/** Documented backoff: 15s, 30s, 60s … capped at 15 minutes. No jitter. */
export const RETRY_BASE_DELAY_SECONDS = 15;
export const RETRY_BACKOFF_FACTOR = 2;
export const RETRY_MAX_DELAY_SECONDS = 900;

export interface RetryDecision {
  shouldRetry: boolean;
  delaySeconds: number;
  reason: string;
}

/**
 * `attemptCount` is the number of attempts already made. `maxAttempts` is the
 * total budget; the transition into `queued` enforces exactly the same limit.
 */
export function retryPolicy(attemptCount: number, maxAttempts: number, result: { retryable: boolean }): RetryDecision {
  if (!result.retryable) {
    return { shouldRetry: false, delaySeconds: 0, reason: "adapter reported a non-retryable failure" };
  }
  if (maxAttempts <= 0) {
    return { shouldRetry: false, delaySeconds: 0, reason: "retry budget is disabled (maxAttempts <= 0)" };
  }
  if (attemptCount >= maxAttempts) {
    return {
      shouldRetry: false,
      delaySeconds: 0,
      reason: `retry budget exhausted: ${attemptCount} of ${maxAttempts} attempts already used`,
    };
  }
  const exponent = Math.max(0, attemptCount - 1);
  const delaySeconds = Math.min(RETRY_MAX_DELAY_SECONDS, RETRY_BASE_DELAY_SECONDS * RETRY_BACKOFF_FACTOR ** exponent);
  return {
    shouldRetry: true,
    delaySeconds,
    reason: `attempt ${attemptCount + 1} of ${maxAttempts} scheduled in ${delaySeconds}s (deterministic backoff, cap ${RETRY_MAX_DELAY_SECONDS}s, no jitter)`,
  };
}
