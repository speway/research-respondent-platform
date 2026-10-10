/**
 * Agent task state machine, contract validation, idempotency and adapter tests.
 *
 * Everything runs against injected clocks: a failure here means a task could be
 * dispatched, retried or reported as submitted when the research rules forbid it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALLOWED_TRANSITIONS,
  APPROVER_ROLES,
  RETRY_BASE_DELAY_SECONDS,
  RETRY_MAX_DELAY_SECONDS,
  TASK_STATES,
  applyTransition,
  assertTransition,
  buildIdempotencyKey,
  canonicalJson,
  canTransition,
  checkRequestBinding,
  hashContract,
  retryPolicy,
  validateContract,
} from "../../lib/domain/task-flow.ts";
import type { AgentTaskRecord, ContractValidation, TransitionContext } from "../../lib/domain/task-flow.ts";
import { DomainError } from "../../lib/domain/types.ts";
import type { AgentTaskContract, TaskExecutionRequest, TaskExecutionResult, TaskState } from "../../lib/domain/types.ts";
import { createLocalDeterministicAdapter } from "../../lib/domain/adapters/local-deterministic.ts";
import { createGoogleFormsAdapter, GOOGLE_FORMS_SECRET_REF } from "../../lib/domain/adapters/google-forms.ts";
import type { GoogleFormsSubmission } from "../../lib/domain/adapters/google-forms.ts";
import { ADAPTER_REGISTRY, resolveAdapter } from "../../lib/domain/adapters/index.ts";

const NOW = "2026-03-01T12:00:00.000Z";
const LATER = "2026-03-01T13:30:00.000Z";
const PAST = "2026-02-01T00:00:00.000Z";
const FIXED_CLOCK = () => NOW;

function baseContract(): AgentTaskContract {
  return {
    contractVersion: "1.0",
    taskId: "task-1",
    taskKind: "preflight_mapping",
    studyId: "study-1",
    studyCode: "ST-1",
    participantPseudonym: "P-0001",
    externalFormVersionId: "formv-1",
    externalFormTitle: "Wave 1 form",
    fieldMap: [
      {
        fieldId: "f1",
        fieldTitle: "Age at enrolment",
        fieldType: "short_text",
        required: true,
        value: "34",
        valueKind: "numeric",
        provenance: "observed_answer:age_at_enrolment@session-1",
      },
      {
        fieldId: "f2",
        fieldTitle: "Interviewer notes",
        fieldType: "paragraph",
        required: false,
        value: null,
        valueKind: "none",
        provenance: "unmapped: no documented source on the external form",
      },
    ],
    permittedAnswers: [
      {
        itemCode: "01",
        questionText: "I feel rested",
        value: "4",
        collectedAt: NOW,
        documentedSourceId: "src-1",
        sourceLocator: "sheet1!B2",
      },
    ],
    permissions: {
      mayReadPermittedAnswers: true,
      maySubmitExternalResponse: false,
      mayAttachEvidence: true,
      mayRequestHumanReview: true,
      forbiddenScopes: ["participant_private_identity"],
    },
    expiresAt: "2026-04-01T00:00:00.000Z",
    idempotencyKey: "key-aaa",
    callback: { mode: "none", url: null },
    notes: [],
  };
}

/** Same shape, arbitrary extra or replaced properties: the validator takes `unknown`. */
function variant(overrides: Record<string, unknown>): unknown {
  return { ...baseContract(), ...overrides };
}

function submitContract(): AgentTaskContract {
  return {
    ...baseContract(),
    taskKind: "submit_external_response",
    permissions: { ...baseContract().permissions, maySubmitExternalResponse: true },
    callback: { mode: "webhook", url: "https://example.org/hooks/task" },
  };
}

function taskRecord(state: TaskState = "draft", overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  const contract = baseContract();
  return {
    id: "task-1",
    organizationId: "org-1",
    studyId: "study-1",
    participantId: "part-1",
    externalFormVersionId: "formv-1",
    assignedAgentId: "agent-1",
    kind: "preflight_mapping",
    state,
    contract,
    contractSha256: hashContract(contract),
    idempotencyKey: "key-aaa",
    priority: 100,
    requiresApproval: true,
    approvedBy: null,
    approvedAt: null,
    approvalNote: null,
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    attemptCount: 0,
    maxAttempts: 3,
    expiresAt: contract.expiresAt,
    lastError: null,
    createdBy: "user-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function context(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    actorRoles: ["principal_investigator"],
    taskRequiresApproval: false,
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

function request(contract: AgentTaskContract = baseContract(), overrides: Partial<TaskExecutionRequest> = {}): TaskExecutionRequest {
  return { taskId: contract.taskId, contract, attemptNumber: 1, idempotencyKey: contract.idempotencyKey, ...overrides };
}

function evidenceBody(result: TaskExecutionResult, index = 0): Record<string, unknown> {
  const entry = result.evidence[index];
  assert.ok(entry, `expected evidence at index ${index}`);
  return entry.body;
}

function payloadOf(body: Record<string, unknown>): Record<string, string> {
  const payload = body["payload"];
  assert.ok(payload !== null && typeof payload === "object", "evidence body must carry a payload object");
  return payload as Record<string, string>;
}

function fieldsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const fields = body["fields"];
  assert.ok(Array.isArray(fields), "evidence body must carry a fields array");
  return fields as Array<Record<string, unknown>>;
}

function isDomainError(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

// ------------------------------------------------------------- state machine --

test("every declared transition is allowed and well formed", () => {
  for (const state of TASK_STATES) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[state]), `missing transition table entry for ${state}`);
  }
  for (const from of TASK_STATES) {
    const targets = ALLOWED_TRANSITIONS[from];
    assert.ok(!targets.includes(from), `${from} must not transition to itself`);
    for (const to of targets) {
      assert.ok(TASK_STATES.includes(to), `${from} -> ${to} points at an unknown state`);
      const result = canTransition(from, to, context());
      assert.equal(result.allowed, true, `${from} -> ${to} should be allowed: ${result.reason}`);
      assert.equal(result.from, from);
      assert.equal(result.to, to);
    }
  }
  for (const terminal of ["succeeded", "cancelled", "expired"] as TaskState[]) {
    assert.equal(ALLOWED_TRANSITIONS[terminal].length, 0, `${terminal} must be terminal`);
  }
});

test("illegal transitions are denied with an explanatory reason", () => {
  const illegal: Array<[TaskState, TaskState]> = [
    ["draft", "running"],
    ["draft", "succeeded"],
    ["succeeded", "running"],
    ["succeeded", "approved"],
    ["cancelled", "queued"],
    ["expired", "queued"],
    ["validated", "running"],
    ["queued", "approved"],
    ["running", "queued"],
    ["failed", "running"],
  ];
  for (const [from, to] of illegal) {
    const result = canTransition(from, to, context());
    assert.equal(result.allowed, false, `${from} -> ${to} must be denied`);
    assert.ok(result.reason.length > 0, "denial must explain itself");
  }
  assert.match(canTransition("draft", "running", context()).reason, /not part of the task state machine/);
  assert.match(canTransition("cancelled", "queued", context()).reason, /not part of the task state machine/);
});

test("assertTransition throws DomainError task.transition_denied and returns the allowed edge", () => {
  assert.throws(
    () => assertTransition("draft", "running", context()),
    (error: unknown) => isDomainError(error, "task.transition_denied") && /draft -> running denied/.test((error as Error).message),
  );
  assert.throws(
    () => assertTransition("expired", "queued", context()),
    (error: unknown) => isDomainError(error, "task.transition_denied") && typeof (error as DomainError).detail["reason"] === "string",
  );
  const allowed = assertTransition("draft", "validated", context());
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.to, "validated");
});

test("approval gating requires a PI or reviewer role", () => {
  assert.deepEqual([...APPROVER_ROLES], ["principal_investigator", "reviewer"]);

  const noRole = canTransition("draft", "approved", context({ taskRequiresApproval: true, actorRoles: [] }));
  assert.equal(noRole.allowed, false);
  assert.equal(noRole.requiresActorRole, "principal_investigator | reviewer");
  assert.match(noRole.reason, /approval requires one of the roles/);

  assert.equal(canTransition("draft", "approved", context({ taskRequiresApproval: true, actorRoles: ["research_assistant"] })).allowed, false);
  assert.equal(canTransition("draft", "approved", context({ taskRequiresApproval: true, actorRoles: ["principal_investigator"] })).allowed, true);
  assert.equal(canTransition("draft", "approved", context({ taskRequiresApproval: true, actorRoles: ["reviewer", "research_assistant"] })).allowed, true);
  assert.equal(canTransition("validated", "approved", context({ taskRequiresApproval: true, actorRoles: [] })).allowed, false);
  assert.equal(canTransition("validated", "approved", context({ taskRequiresApproval: true, actorRoles: ["reviewer"] })).allowed, true);
  // A task that does not require approval is not role-gated.
  assert.equal(canTransition("validated", "approved", context({ taskRequiresApproval: false, actorRoles: [] })).allowed, true);
  assert.equal(canTransition("validated", "approved", context({ taskRequiresApproval: false, actorRoles: [] })).requiresActorRole, undefined);
});

test("requeue respects the attempt budget but a first queue does not", () => {
  const exhausted = context({ attemptCount: 3, maxAttempts: 3 });
  const failedRequeue = canTransition("failed", "queued", exhausted);
  assert.equal(failedRequeue.allowed, false);
  assert.match(failedRequeue.reason, /retry budget exhausted/);

  assert.equal(canTransition("needs_review", "queued", exhausted).allowed, false);
  assert.equal(canTransition("failed", "queued", context({ attemptCount: 2, maxAttempts: 3 })).allowed, true);
  assert.equal(canTransition("needs_review", "queued", context({ attemptCount: 2, maxAttempts: 3 })).allowed, true);
  // approved -> queued is the first dispatch, not a retry.
  assert.equal(canTransition("approved", "queued", exhausted).allowed, true);
  // Recording an outcome or cancelling is never budget-limited.
  assert.equal(canTransition("failed", "cancelled", exhausted).allowed, true);
});

test("an expired contract cannot start or schedule work but keeps recording outcomes", () => {
  const expired = context({ now: NOW, expiresAt: PAST });
  for (const [from, to] of [
    ["validated", "approved"],
    ["approved", "queued"],
    ["queued", "running"],
    ["failed", "queued"],
    ["needs_review", "queued"],
  ] as Array<[TaskState, TaskState]>) {
    const result = canTransition(from, to, expired);
    assert.equal(result.allowed, false, `${from} -> ${to} must be denied after expiry`);
    assert.match(result.reason, /task expired/);
  }
  assert.equal(canTransition("queued", "expired", expired).allowed, true);
  assert.equal(canTransition("queued", "cancelled", expired).allowed, true);
  assert.equal(canTransition("running", "succeeded", expired).allowed, true);
  assert.equal(canTransition("running", "needs_review", expired).allowed, true);
  // Without an injected clock no time comparison is made.
  assert.equal(canTransition("queued", "running", context({ expiresAt: PAST, now: undefined })).allowed, true);
  assert.equal(canTransition("queued", "running", context({ now: NOW, expiresAt: undefined })).allowed, true);
});

test("applyTransition returns a new frozen record and never mutates its input", () => {
  const draft = taskRecord("draft");
  const validated = applyTransition(draft, "validated", { now: LATER });
  assert.notStrictEqual(validated, draft);
  assert.equal(validated.state, "validated");
  assert.equal(validated.updatedAt, LATER);
  assert.equal(draft.state, "draft");
  assert.equal(draft.updatedAt, NOW);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(validated.contract, draft.contract);

  const queued = applyTransition(
    applyTransition(validated, "approved", { now: LATER, actorRoles: ["principal_investigator"] }),
    "queued",
    { now: LATER, actorRoles: [] },
  );
  assert.equal(queued.queuedAt, LATER);
  const running = applyTransition(queued, "running", { now: LATER });
  assert.equal(running.startedAt, LATER);
  const succeeded = applyTransition({ ...running, lastError: "stale" }, "succeeded", { now: LATER });
  assert.equal(succeeded.finishedAt, LATER);
  assert.equal(succeeded.lastError, null);

  const approved = applyTransition(taskRecord("validated"), "approved", {
    now: LATER,
    actorRoles: ["reviewer"],
    actorId: "user-9",
    approvalNote: "consent verified",
  });
  assert.equal(approved.approvedAt, LATER);
  assert.equal(approved.approvedBy, "user-9");
  assert.equal(approved.approvalNote, "consent verified");

  const needsReview = applyTransition(taskRecord("running"), "needs_review", { now: LATER, errorNote: "receipt mismatch" });
  assert.equal(needsReview.finishedAt, LATER);
  assert.equal(needsReview.lastError, "receipt mismatch");
});

test("applyTransition enforces role, budget and expiry gates", () => {
  assert.throws(
    () => applyTransition(taskRecord("validated"), "approved", { now: LATER, actorRoles: [] }),
    (error: unknown) => isDomainError(error, "task.transition_denied"),
  );
  assert.throws(
    () => applyTransition(taskRecord("failed", { attemptCount: 3, maxAttempts: 3 }), "queued", { now: LATER }),
    (error: unknown) => isDomainError(error, "task.transition_denied") && /retry budget exhausted/.test((error as Error).message),
  );
  assert.throws(
    () => applyTransition(taskRecord("approved", { expiresAt: PAST }), "queued", { now: NOW }),
    (error: unknown) => isDomainError(error, "task.transition_denied") && /expired/.test((error as Error).message),
  );
  assert.equal(applyTransition(taskRecord("approved", { expiresAt: PAST }), "expired", { now: NOW }).state, "expired");
});

// --------------------------------------------------------------- idempotency --

test("idempotency keys are stable, opaque and sensitive to every component", () => {
  const base = {
    studyId: "study-1",
    participantId: "part-1",
    externalFormVersionId: "formv-1",
    taskKind: "preflight_mapping",
    contractVersion: "1.0",
  } as const;
  const key = buildIdempotencyKey(base);
  assert.equal(key, buildIdempotencyKey({ ...base }));
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key.length, 64);

  const variants: Array<Record<string, unknown>> = [
    { studyId: "study-2" },
    { participantId: "part-2" },
    { externalFormVersionId: "formv-2" },
    { externalFormVersionId: null },
    { taskKind: "compose_form_payload" },
    { contractVersion: "1.1" },
  ];
  const keys = new Set<string>([key]);
  for (const override of variants) {
    const changed = buildIdempotencyKey({ ...base, ...override });
    assert.notEqual(changed, key, `changing ${Object.keys(override)[0]} must change the key`);
    assert.equal(changed.length, 64);
    keys.add(changed);
  }
  assert.equal(keys.size, variants.length + 1, "every component must separate the key space");

  assert.throws(
    () => buildIdempotencyKey({ ...base, participantId: "  " }),
    (error: unknown) => isDomainError(error, "task.idempotency_input_invalid"),
  );
});

test("contract hashing is canonical, key-order independent and content sensitive", () => {
  const contract = baseContract();
  const reorder = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reorder);
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).reverse();
      return Object.fromEntries(entries.map(([key, entry]) => [key, reorder(entry)]));
    }
    return value;
  };
  const hash = hashContract(contract);
  assert.equal(hash, hashContract(reorder(contract) as AgentTaskContract));
  assert.equal(hash, hashContract(JSON.parse(JSON.stringify(reorder(contract))) as AgentTaskContract));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, hashContract({ ...contract, studyCode: "ST-2" }));
  assert.notEqual(hash, hashContract({ ...contract, notes: ["changed"] }));
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ b: 1, a: undefined }), '{"b":1}');
  assert.throws(() => canonicalJson({ handler: () => 1 } as unknown), (error: unknown) =>
    isDomainError(error, "task.canonical_json_unsupported"),
  );
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic["self"] = cyclic;
  assert.throws(() => canonicalJson(cyclic), (error: unknown) => isDomainError(error, "task.canonical_json_unsupported"));
});

test("request binding rejects task id and idempotency key mismatches", () => {
  assert.equal(checkRequestBinding(request()), null);
  const wrongTask = checkRequestBinding(request(baseContract(), { taskId: "task-9" }));
  assert.equal(wrongTask?.code, "request.task_id_mismatch");
  assert.equal(wrongTask?.severity, "fail");
  const wrongKey = checkRequestBinding(request(baseContract(), { idempotencyKey: "key-zzz" }));
  assert.equal(wrongKey?.code, "request.idempotency_key_mismatch");
  assert.match(String(wrongKey?.message), /duplicate external work/);
});

// ---------------------------------------------------------- contract validation --

test("a well-formed contract validates", () => {
  const outcome: ContractValidation = validateContract(baseContract(), NOW);
  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok);
  assert.equal(outcome.contract.taskId, "task-1");
  assert.deepEqual(outcome.issues, []);
  // Warnings never block: an unmapped optional field is reported, not fatal.
  const warned = validateContract(variant({
    fieldMap: [
      ...baseContract().fieldMap,
      {
        fieldId: "f9",
        fieldTitle: "Consent code",
        fieldType: "short_text",
        required: true,
        value: null,
        valueKind: "none",
        provenance: "unmapped",
      },
    ],
  }), NOW);
  assert.equal(warned.ok, true);
  assert.ok(warned.ok);
  assert.deepEqual(warned.issues.map((issue) => issue.code), ["contract.required_field_without_source"]);
  assert.equal(warned.issues[0]?.severity, "warn");
});

test("validateContract rejects each forbidden contract shape", () => {
  const base = baseContract();
  const cases: Array<{ name: string; contract: unknown; code: string }> = [
    { name: "non-object", contract: null, code: "contract.not_object" },
    { name: "missing idempotencyKey", contract: variant({ idempotencyKey: undefined }), code: "contract.idempotency_key_missing" },
    { name: "empty idempotencyKey", contract: variant({ idempotencyKey: "   " }), code: "contract.idempotency_key_missing" },
    { name: "e-mail pseudonym", contract: variant({ participantPseudonym: "anna@example.org" }), code: "contract.identity_in_pseudonym" },
    {
      name: "full_name inside fieldMap",
      contract: variant({
        fieldMap: [
          ...base.fieldMap,
          {
            fieldId: "f3",
            fieldTitle: "Name",
            fieldType: "short_text",
            required: false,
            value: "Anna Petrova",
            valueKind: "text",
            provenance: "imported",
            full_name: "Anna Petrova",
          },
        ],
      }),
      code: "contract.identity_field_present",
    },
    {
      name: "contact_email inside permissions",
      contract: variant({ permissions: { ...base.permissions, contact_email: "anna@example.org" } }),
      code: "contract.identity_field_present",
    },
    {
      name: "contact_phone at the top level",
      contract: variant({ contact_phone: "+998900000000" }),
      code: "contract.identity_field_present",
    },
    { name: "expired relative to now", contract: variant({ expiresAt: PAST }), code: "contract.expired" },
    { name: "unparsable expiresAt", contract: variant({ expiresAt: "not-a-date" }), code: "contract.expires_at_invalid" },
    {
      name: "submission without an authorized path",
      contract: variant({
        permissions: { ...base.permissions, maySubmitExternalResponse: true },
        callback: { mode: "none", url: null },
      }),
      code: "contract.external_submission_without_authorization_path",
    },
    {
      name: "submission without a form version",
      contract: variant({
        externalFormVersionId: null,
        permissions: { ...base.permissions, maySubmitExternalResponse: true },
        callback: { mode: "webhook", url: "https://example.org/hook" },
      }),
      code: "contract.external_submission_without_form_version",
    },
    {
      name: "permitted answers without permission",
      contract: variant({ permissions: { ...base.permissions, mayReadPermittedAnswers: false } }),
      code: "contract.permitted_answers_without_permission",
    },
    {
      name: "webhook callback without url",
      contract: variant({ callback: { mode: "webhook", url: null } }),
      code: "contract.callback_url_missing",
    },
    { name: "token key", contract: variant({ token: "abc" }), code: "contract.credential_key_present" },
    { name: "secret key", contract: variant({ notes: ["ok"], secret: "abc" }), code: "contract.credential_key_present" },
    {
      name: "password key nested in callback",
      contract: variant({ callback: { mode: "poll", url: "https://example.org/poll", password: "abc" } }),
      code: "contract.credential_key_present",
    },
    { name: "apiKey key", contract: variant({ apiKey: "abc" }), code: "contract.credential_key_present" },
    { name: "unknown taskKind", contract: variant({ taskKind: "exfiltrate" }), code: "contract.task_kind_unknown" },
    { name: "bad field value kind", contract: variant({ fieldMap: [{ ...base.fieldMap[0], valueKind: "binary" }] }), code: "contract.value_kind_unknown" },
    { name: "value declared without a value", contract: variant({ fieldMap: [{ ...base.fieldMap[0], value: null }] }), code: "contract.field_value_missing" },
    { name: "missing provenance", contract: variant({ fieldMap: [{ ...base.fieldMap[0], provenance: "" }] }), code: "contract.field_map_entry_invalid" },
  ];
  for (const entry of cases) {
    const outcome = validateContract(entry.contract, NOW);
    assert.equal(outcome.ok, false, `${entry.name} must be rejected`);
    assert.ok(
      !outcome.ok && outcome.issues.some((issue) => issue.code === entry.code && issue.severity === "fail"),
      `${entry.name} must report ${entry.code} as a failure, got ${outcome.ok ? "ok" : outcome.issues.map((issue) => issue.code).join(", ")}`,
    );
  }
});

test("validateContract only enforces expiry against an injected clock", () => {
  const expired = variant({ expiresAt: PAST });
  assert.equal(validateContract(expired, NOW).ok, false);
  assert.equal(validateContract(expired).ok, true);
  assert.equal(validateContract(expired, "not-a-date").ok, true);
});

// ---------------------------------------------------------------- retry policy --

test("retryPolicy backs off exponentially up to a documented cap", () => {
  assert.equal(RETRY_BASE_DELAY_SECONDS, 15);
  assert.equal(RETRY_MAX_DELAY_SECONDS, 900);

  const first = retryPolicy(1, 4, { retryable: true });
  assert.equal(first.shouldRetry, true);
  assert.equal(first.delaySeconds, 15);
  assert.match(first.reason, /attempt 2 of 4/);
  assert.equal(retryPolicy(2, 4, { retryable: true }).delaySeconds, 30);
  assert.equal(retryPolicy(3, 4, { retryable: true }).delaySeconds, 60);
  assert.equal(retryPolicy(4, 8, { retryable: true }).delaySeconds, 120);
  assert.equal(retryPolicy(8, 10, { retryable: true }).delaySeconds, RETRY_MAX_DELAY_SECONDS);
  assert.equal(retryPolicy(0, 3, { retryable: true }).delaySeconds, RETRY_BASE_DELAY_SECONDS);

  const exhausted = retryPolicy(3, 3, { retryable: true });
  assert.equal(exhausted.shouldRetry, false);
  assert.equal(exhausted.delaySeconds, 0);
  assert.match(exhausted.reason, /retry budget exhausted/);

  const permanent = retryPolicy(1, 3, { retryable: false });
  assert.equal(permanent.shouldRetry, false);
  assert.equal(permanent.delaySeconds, 0);
  assert.match(permanent.reason, /non-retryable/);

  assert.equal(retryPolicy(0, 0, { retryable: true }).shouldRetry, false);
});

// --------------------------------------------------- local deterministic adapter --

test("local adapter advertises only capabilities it actually has", () => {
  const adapter = createLocalDeterministicAdapter({ now: FIXED_CLOCK });
  assert.equal(adapter.id, "local-deterministic");
  assert.equal(adapter.description.length > 0, true);
  assert.deepEqual(adapter.capabilities, {
    canPreflight: true,
    canComposePayload: true,
    canSubmitExternally: false,
    requiresNetwork: false,
    requiresCredentials: false,
  });
});

test("local adapter preflight produces a dry run report with payload and provenance", async () => {
  const adapter = createLocalDeterministicAdapter({ now: FIXED_CLOCK });
  const result = await adapter.preflight(request());
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.retryable, false);
  assert.equal(result.externalReceipt, null);
  assert.equal(result.blockedByPolicy, undefined);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.evidenceType, "dry_run_report");

  const body = evidenceBody(result);
  assert.equal(body["dryRun"], true);
  assert.equal(body["externalCallMade"], false);
  assert.equal(body["outcome"], "warn");
  assert.equal(body["generatedAt"], NOW);
  assert.equal(body["contractSha256"], hashContract(baseContract()));

  const payload = payloadOf(body);
  assert.deepEqual(payload, { f1: "34" });
  assert.equal(Object.keys(payload).includes("f2"), false);

  const fields = fieldsOf(body);
  assert.equal(fields.length, 2);
  assert.equal(fields[0]?.["provenance"], "observed_answer:age_at_enrolment@session-1");
  assert.equal(fields[0]?.["status"], "pass");
  assert.equal(fields[1]?.["status"], "warn");
  assert.deepEqual(fields[1]?.["issueCodes"], ["field.optional_without_documented_source"]);
  assert.deepEqual(body["counts"], {
    total: 2,
    mapped: 1,
    unmappedRequired: 0,
    unmappedOptional: 1,
    pass: 1,
    warn: 1,
    fail: 0,
  });
  assert.deepEqual(body["blockingReasons"], []);
});

test("local adapter preflight is byte-identical across runs", async () => {
  const adapter = createLocalDeterministicAdapter({ now: FIXED_CLOCK });
  const first = await adapter.preflight(request());
  const second = await adapter.preflight(request());
  assert.equal(JSON.stringify(first.evidence), JSON.stringify(second.evidence));
  assert.equal(first.message, second.message);
});

test("local adapter preflight fails hard on an invalid contract or an unmapped required field", async () => {
  const adapter = createLocalDeterministicAdapter({ now: FIXED_CLOCK });

  const invalid = await adapter.preflight(request({ ...baseContract(), participantPseudonym: "anna@example.org" }));
  assert.equal(invalid.outcome, "failed");
  assert.equal(invalid.retryable, false);
  assert.equal(invalid.errorCode, "contract.invalid");
  assert.equal(invalid.evidence[0]?.evidenceType, "validation_report");
  assert.match(invalid.message, /contract\.identity_in_pseudonym/);
  // Rejecting identity data must not copy it into evidence.
  assert.equal(JSON.stringify(invalid).includes("anna@example.org"), false);

  const unmapped = await adapter.preflight(
    request({
      ...baseContract(),
      fieldMap: baseContract().fieldMap.map((field) => (field.fieldId === "f2" ? { ...field, required: true } : field)),
    }),
  );
  assert.equal(unmapped.outcome, "failed");
  assert.equal(unmapped.retryable, false);
  assert.equal(unmapped.errorCode, "mapping.field_without_source");
  assert.match(unmapped.message, /f2 \(Interviewer notes\): field\.required_without_documented_source/);
  assert.equal(evidenceBody(unmapped)["outcome"], "fail");
});

test("local adapter rejects a request that does not match its contract", async () => {
  const adapter = createLocalDeterministicAdapter({ now: FIXED_CLOCK });
  const result = await adapter.execute(request(baseContract(), { idempotencyKey: "key-zzz" }));
  assert.equal(result.outcome, "failed");
  assert.equal(result.retryable, false);
  assert.equal(result.errorCode, "contract.invalid");
  assert.match(result.message, /request\.idempotency_key_mismatch/);
  assert.equal((result.evidence[0]?.body as Record<string, unknown>)["phase"], "execute");
});

test("local adapter never claims an external submission", async () => {
  const adapter = createLocalDeterministicAdapter({ now: FIXED_CLOCK });

  const composed = await adapter.execute(request());
  assert.equal(composed.outcome, "succeeded");
  assert.equal(composed.externalReceipt?.channel, "none");
  assert.equal(composed.externalReceipt?.responseId, null);
  assert.equal(composed.externalReceipt?.submittedAt, NOW);
  assert.equal(composed.evidence[0]?.evidenceType, "payload_snapshot");
  assert.deepEqual(payloadOf(evidenceBody(composed)), { f1: "34" });
  assert.equal(evidenceBody(composed)["externalSubmissionAttempted"], false);
  assert.equal(evidenceBody(composed)["channel"], "none");

  const second = await adapter.execute(request());
  assert.equal(JSON.stringify(composed), JSON.stringify(second));

  const submitted = await adapter.execute(request(submitContract()));
  assert.notEqual(submitted.outcome, "succeeded");
  assert.equal(submitted.outcome, "needs_review");
  assert.equal(submitted.blockedByPolicy, true);
  assert.equal(submitted.retryable, false);
  assert.equal(submitted.errorCode, "policy.no_authorized_submission_path");
  assert.match(submitted.message, /no authorized external submission path is configured/);
  assert.equal(submitted.externalReceipt, null);
  assert.equal(submitted.evidence[0]?.evidenceType, "payload_snapshot");

  const verification = await adapter.execute(request({ ...baseContract(), taskKind: "verify_submission" }));
  assert.equal(verification.outcome, "needs_review");
  assert.equal(verification.blockedByPolicy, true);
  assert.equal(verification.errorCode, "policy.no_authorized_verification_path");
});

test("local adapter simulation knobs stay deterministic and feed the retry policy", async () => {
  const failing = createLocalDeterministicAdapter({ now: FIXED_CLOCK, failOnAttempt: 2 });
  assert.equal((await failing.execute(request(baseContract(), { attemptNumber: 1 }))).outcome, "succeeded");
  const failure = await failing.execute(request(baseContract(), { attemptNumber: 2 }));
  assert.equal(failure.outcome, "failed");
  assert.equal(failure.retryable, true);
  assert.equal(failure.errorCode, "adapter.simulated_failure");
  assert.equal(failure.evidence[0]?.evidenceType, "error_trace");
  const decision = retryPolicy(2, 3, { retryable: failure.retryable });
  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.delaySeconds, 30);

  const reviewing = createLocalDeterministicAdapter({ now: FIXED_CLOCK, reviewOnAttempt: 1 });
  const review = await reviewing.execute(request());
  assert.equal(review.outcome, "needs_review");
  assert.equal(review.retryable, false);
  assert.equal(review.errorCode, "adapter.simulated_review");
  assert.equal(retryPolicy(1, 3, { retryable: review.retryable }).shouldRetry, false);
});

// ----------------------------------------------------------- google forms adapter --

test("google adapter capabilities reflect the provider flags", () => {
  const disabled = createGoogleFormsAdapter({
    hasApiCredentials: true,
    capabilities: { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: false },
  });
  assert.equal(disabled.id, "google-forms");
  assert.equal(disabled.capabilities.canPreflight, true);
  assert.equal(disabled.capabilities.canComposePayload, true);
  assert.equal(disabled.capabilities.canSubmitExternally, false);
  assert.equal(disabled.capabilities.requiresNetwork, true);
  assert.equal(disabled.capabilities.requiresCredentials, true);

  const enabled = createGoogleFormsAdapter({
    hasApiCredentials: true,
    capabilities: { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: true },
  });
  assert.equal(enabled.capabilities.canSubmitExternally, true);

  const noCredentials = createGoogleFormsAdapter({
    hasApiCredentials: false,
    capabilities: { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: true },
  });
  assert.equal(noCredentials.capabilities.canSubmitExternally, false);
});

test("google adapter refuses submission without a documented provider capability", async () => {
  const adapter = createGoogleFormsAdapter(
    {
      hasApiCredentials: true,
      capabilities: { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: false },
    },
    { now: FIXED_CLOCK, submit: async () => ({ receiptId: "must-not-be-called" }) },
  );
  const result = await adapter.execute(request(submitContract()));
  assert.notEqual(result.outcome, "succeeded");
  assert.equal(result.outcome, "needs_review");
  assert.equal(result.blockedByPolicy, true);
  assert.equal(result.retryable, false);
  assert.equal(result.errorCode, "policy.provider_cannot_submit_responses");
  assert.match(result.message, /documented Google Forms provider limitation/);
  assert.match(result.message, /no endpoint for creating form responses/);
  assert.equal(result.externalReceipt, null);
  assert.equal(result.evidence[0]?.evidenceType, "payload_snapshot");
  assert.equal(JSON.stringify(result).includes("must-not-be-called"), false);
});

test("google adapter refuses submission without an injected authorized transport", async () => {
  const adapter = createGoogleFormsAdapter(
    {
      hasApiCredentials: true,
      capabilities: { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: true },
    },
    { now: FIXED_CLOCK },
  );
  const result = await adapter.execute(request(submitContract()));
  assert.equal(result.outcome, "needs_review");
  assert.equal(result.blockedByPolicy, true);
  assert.equal(result.errorCode, "policy.no_authorized_submission_path");
  assert.match(result.message, /no authorized submit transport is injected/);

  // A non-function adapterOptions.submit is not a transport either.
  const sneaky = await adapter.execute(request(submitContract(), { adapterOptions: { submit: "https://example.org/do-it" } }));
  assert.equal(sneaky.outcome, "needs_review");
  assert.equal(sneaky.blockedByPolicy, true);
});

test("google adapter refuses submission without credentials or without contract permission", async () => {
  const capabilities = { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: true };
  const transport = async (): Promise<{ receiptId: string }> => ({ receiptId: "must-not-be-called" });

  const noCredentials = createGoogleFormsAdapter({ hasApiCredentials: false, capabilities }, { now: FIXED_CLOCK, submit: transport });
  const credentialResult = await noCredentials.execute(request(submitContract()));
  assert.equal(credentialResult.outcome, "needs_review");
  assert.equal(credentialResult.blockedByPolicy, true);
  assert.equal(credentialResult.errorCode, "policy.no_credentials_configured");
  assert.match(credentialResult.message, new RegExp(GOOGLE_FORMS_SECRET_REF));

  const granted = createGoogleFormsAdapter({ hasApiCredentials: true, capabilities }, { now: FIXED_CLOCK, submit: transport });
  const ungranted = await granted.execute(
    request({
      ...submitContract(),
      permissions: { ...submitContract().permissions, maySubmitExternalResponse: false },
      callback: { mode: "none", url: null },
    }),
  );
  assert.equal(ungranted.outcome, "needs_review");
  assert.equal(ungranted.blockedByPolicy, true);
  assert.equal(ungranted.errorCode, "policy.submission_not_granted_by_contract");
});

test("google adapter submits through the injected transport when every gate is open", async () => {
  const capabilities = { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: true };
  const seen: GoogleFormsSubmission[] = [];
  const adapter = createGoogleFormsAdapter(
    { hasApiCredentials: true, capabilities },
    {
      now: FIXED_CLOCK,
      submit: async (submission) => {
        seen.push(submission);
        return { receiptId: "receipt-1", responseId: "resp-77", submittedAt: LATER };
      },
    },
  );
  const result = await adapter.execute(request(submitContract(), { attemptNumber: 2 }));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.retryable, false);
  assert.equal(result.blockedByPolicy, undefined);
  assert.equal(result.externalReceipt?.channel, "api");
  assert.equal(result.externalReceipt?.receiptId, "receipt-1");
  assert.equal(result.externalReceipt?.responseId, "resp-77");
  assert.equal(result.externalReceipt?.submittedAt, LATER);
  assert.deepEqual(result.evidence.map((entry) => entry.evidenceType), ["payload_snapshot", "external_receipt"]);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.taskId, "task-1");
  assert.equal(seen[0]?.idempotencyKey, "key-aaa");
  assert.equal(seen[0]?.attemptNumber, 2);
  assert.deepEqual(seen[0]?.payload, { f1: "34" });
  assert.equal(JSON.stringify(seen[0]).includes("secret"), false);

  // The transport may also be injected per request by the service layer.
  const perRequest: GoogleFormsSubmission[] = [];
  const viaRequest = createGoogleFormsAdapter({ hasApiCredentials: true, capabilities }, { now: FIXED_CLOCK });
  const viaRequestResult = await viaRequest.execute(
    request(submitContract(), {
      adapterOptions: {
        submit: async (submission: GoogleFormsSubmission) => {
          perRequest.push(submission);
          return { receiptId: "receipt-2" };
        },
      },
    }),
  );
  assert.equal(viaRequestResult.outcome, "succeeded");
  assert.equal(viaRequestResult.externalReceipt?.receiptId, "receipt-2");
  assert.equal(viaRequestResult.externalReceipt?.submittedAt, NOW);
  assert.equal(perRequest.length, 1);
});

test("google adapter redacts credential-shaped text from transport errors", async () => {
  const adapter = createGoogleFormsAdapter(
    {
      hasApiCredentials: true,
      capabilities: { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: true },
    },
    {
      now: FIXED_CLOCK,
      submit: async () => {
        throw new Error("401 unauthorized: Bearer ya29.SECRETVALUE123456; api_key=ABCDEF123456");
      },
    },
  );
  const result = await adapter.execute(request(submitContract()));
  assert.equal(result.outcome, "failed");
  assert.equal(result.retryable, true);
  assert.equal(result.errorCode, "adapter.transport_error");
  assert.equal(result.externalReceipt, null);
  assert.equal(result.evidence.map((entry) => entry.evidenceType).join(","), "payload_snapshot,error_trace");
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes("SECRETVALUE"), false);
  assert.equal(serialised.includes("ABCDEF123456"), false);
  assert.equal(serialised.includes("ya29."), false);
  assert.equal(serialised.includes("[redacted-oauth-grant]"), true);
  assert.equal(serialised.includes("api_key=[redacted]"), true);
  assert.equal(evidenceBody(result, 1)["errorName"], "Error");
});

test("google adapter preflight reports fields without a documented source", async () => {
  const adapter = createGoogleFormsAdapter(
    {
      hasApiCredentials: true,
      capabilities: { api_can_read_structure: true, api_can_read_responses: false, api_can_submit_responses: false },
    },
    { now: FIXED_CLOCK },
  );
  const result = await adapter.preflight(request());
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.evidence[0]?.evidenceType, "validation_report");
  const body = evidenceBody(result);
  assert.equal(body["outcome"], "warn");
  assert.equal(body["externalCallMade"], false);
  assert.equal(evidenceBody(result)["secretReference"], GOOGLE_FORMS_SECRET_REF);
  const unsourced = body["fieldsWithoutDocumentedSource"] as Array<Record<string, unknown>>;
  assert.equal(unsourced.length, 1);
  assert.equal(unsourced[0]?.["fieldId"], "f2");
  assert.equal(unsourced[0]?.["required"], false);
  assert.match(String(unsourced[0]?.["reason"]), /no documented source is mapped/);
  const limits = body["capabilityLimits"] as string[];
  assert.equal(limits.length, 2);
  assert.ok(limits.some((limit) => /api_can_read_responses:false/.test(limit)));
  assert.ok(limits.some((limit) => /api_can_submit_responses:false/.test(limit)));
  assert.deepEqual(payloadOf(body), { f1: "34" });

  const invalid = await adapter.preflight(request({ ...baseContract(), participantPseudonym: "anna@example.org" }));
  assert.equal(invalid.outcome, "failed");
  assert.equal(invalid.errorCode, "contract.invalid");
  assert.match(invalid.message, /contract\.identity_in_pseudonym/);
});

test("google adapter refuses verification it cannot perform", async () => {
  const adapter = createGoogleFormsAdapter(
    {
      hasApiCredentials: true,
      capabilities: { api_can_read_structure: true, api_can_read_responses: false, api_can_submit_responses: false },
    },
    { now: FIXED_CLOCK },
  );
  const result = await adapter.execute(request({ ...baseContract(), taskKind: "verify_submission" }));
  assert.equal(result.outcome, "needs_review");
  assert.equal(result.blockedByPolicy, true);
  assert.match(result.message, /api_can_read_responses is false/);

  const readOnly = createGoogleFormsAdapter(
    {
      hasApiCredentials: true,
      capabilities: { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: true },
    },
    { now: FIXED_CLOCK },
  );
  const composed = await readOnly.execute(request());
  assert.equal(composed.outcome, "succeeded");
  assert.equal(composed.externalReceipt?.channel, "none");
  assert.equal(JSON.stringify(composed.evidence).includes('"channel":"api"'), false);
});

// ------------------------------------------------------------------- module hygiene --

test("registry resolves both adapters and fails closed on unknown or missing configuration", () => {
  assert.deepEqual(Object.keys(ADAPTER_REGISTRY).sort(), ["google-forms", "local-deterministic"]);
  assert.equal(ADAPTER_REGISTRY["nope"], undefined);
  assert.equal(resolveAdapter("local-deterministic").id, "local-deterministic");
  assert.equal(
    resolveAdapter("local-deterministic", { now: FIXED_CLOCK, failOnAttempt: 1 }).id,
    "local-deterministic",
  );
  assert.equal(
    resolveAdapter("google-forms", {
      hasApiCredentials: true,
      capabilities: { api_can_read_structure: true, api_can_read_responses: true, api_can_submit_responses: true },
    }).capabilities.canSubmitExternally,
    true,
  );
  assert.throws(
    () => resolveAdapter("not-an-adapter"),
    (error: unknown) => isDomainError(error, "adapter.unknown") && /knownAdapterIds/.test(JSON.stringify((error as DomainError).detail)),
  );
  assert.throws(
    () => resolveAdapter("google-forms"),
    (error: unknown) => isDomainError(error, "adapter.config_required"),
  );
});

test("domain modules contain no wall clock and no network call", () => {
  const sources = [
    "../../lib/domain/task-flow.ts",
    "../../lib/domain/adapters/payload.ts",
    "../../lib/domain/adapters/local-deterministic.ts",
    "../../lib/domain/adapters/google-forms.ts",
    "../../lib/domain/adapters/index.ts",
  ];
  for (const relative of sources) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    // Comments may legitimately discuss the clock or fetch; only code matters.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert.equal(/Date\.now\s*\(/.test(code), false, `${relative} must not read the wall clock`);
    assert.equal(/\bfetch\s*\(/.test(code), false, `${relative} must not call fetch`);
    assert.equal(/process\.env\b/.test(code), false, `${relative} must not read environment credentials`);
  }
});
