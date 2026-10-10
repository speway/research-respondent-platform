/**
 * Local deterministic adapter: dry runs, payload composition and evidence only.
 *
 * It never opens a network connection, never asserts an external receipt and
 * never holds credentials. Tasks whose purpose is an external submission are
 * therefore returned as `needs_review` with `blockedByPolicy: true` — the only
 * honest outcome when no authorized submission path exists.
 */
import type {
  RuleIssue,
  TaskAdapter,
  TaskExecutionEvidenceInput,
  TaskExecutionRequest,
  TaskExecutionResult,
} from "../types.ts";
import { checkRequestBinding, hashContract, validateContract } from "../task-flow.ts";
import { blockingFieldReasons, composePayload, countFields, summarizeFields } from "./payload.ts";

export interface LocalDeterministicOptions {
  /** Injected clock. Defaults to the epoch sentinel so runs stay reproducible. */
  now?: () => string;
  /** Simulate a retryable adapter failure on this attempt number (execute only). */
  failOnAttempt?: number;
  /** Simulate a human review checkpoint on this attempt number (execute only). */
  reviewOnAttempt?: number;
}

const EPOCH_SENTINEL = "1970-01-01T00:00:00.000Z";
const ADAPTER_ID = "local-deterministic";
const CAPABILITIES = {
  canPreflight: true,
  canComposePayload: true,
  canSubmitExternally: false,
  requiresNetwork: false,
  requiresCredentials: false,
} as const;
const NO_AUTHORIZED_PATH =
  "no authorized external submission path is configured: the local-deterministic adapter performs no external submissions, so the task is blocked by policy instead of reporting success";
const NO_VERIFICATION_PATH =
  "no authorized external read path is configured: a submission cannot be verified locally, so the task is blocked by policy instead of reporting success";

export function createLocalDeterministicAdapter(options: LocalDeterministicOptions = {}): TaskAdapter {
  const clock = options.now ?? (() => EPOCH_SENTINEL);

  function invalidContract(
    phase: string,
    generatedAt: string,
    code: string,
    issues: RuleIssue[],
    message: string,
  ): TaskExecutionResult {
    return {
      outcome: "failed",
      message,
      retryable: false,
      errorCode: code,
      externalReceipt: null,
      evidence: [{ evidenceType: "validation_report", body: { generatedAt, phase, outcome: "fail", issues } }],
    };
  }

  return {
    id: ADAPTER_ID,
    description:
      "Deterministic dry-run adapter: validates the contract, composes the payload and records evidence without any network or credential use.",
    capabilities: CAPABILITIES,

    async preflight(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
      const generatedAt = clock();
      const binding = checkRequestBinding(request);
      const validation = validateContract(request.contract, generatedAt);
      if (binding !== null || !validation.ok) {
        const issues = binding === null ? validation.issues : [binding, ...validation.issues];
        const codes = [...new Set(issues.map((issue) => issue.code))];
        return invalidContract("preflight", generatedAt, "contract.invalid", issues, `contract rejected: ${codes.join(", ")}`);
      }
      const contract = validation.contract;
      const fields = summarizeFields(contract);
      const counts = countFields(fields);
      const blockingReasons = blockingFieldReasons(fields);
      const payload = composePayload(contract);
      const body = {
        generatedAt,
        phase: "preflight",
        adapterId: ADAPTER_ID,
        dryRun: true,
        externalCallMade: false,
        externalSubmissionAttempted: false,
        outcome: blockingReasons.length > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass",
        taskId: contract.taskId,
        taskKind: contract.taskKind,
        studyCode: contract.studyCode,
        participantPseudonym: contract.participantPseudonym,
        externalFormVersionId: contract.externalFormVersionId,
        idempotencyKey: request.idempotencyKey,
        attemptNumber: request.attemptNumber,
        contractSha256: hashContract(contract),
        payload,
        fields,
        counts,
        blockingReasons,
        authorization: {
          maySubmitExternalResponse: contract.permissions.maySubmitExternalResponse,
          forbiddenScopes: contract.permissions.forbiddenScopes,
        },
      };
      if (blockingReasons.length > 0) {
        return {
          outcome: "failed",
          message: `dry run blocked by ${blockingReasons.length} field(s) without a usable documented source: ${blockingReasons.join("; ")}`,
          retryable: false,
          errorCode: "mapping.field_without_source",
          externalReceipt: null,
          evidence: [{ evidenceType: "dry_run_report", body }],
        };
      }
      return {
        outcome: "succeeded",
        message: `dry run composed ${Object.keys(payload).length} payload field(s) from ${counts.total} mapped field(s); no external call was made`,
        retryable: false,
        externalReceipt: null,
        evidence: [{ evidenceType: "dry_run_report", body }],
      };
    },

    async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
      const generatedAt = clock();
      const binding = checkRequestBinding(request);
      const validation = validateContract(request.contract, generatedAt);
      if (binding !== null || !validation.ok) {
        const issues = binding === null ? validation.issues : [binding, ...validation.issues];
        const codes = [...new Set(issues.map((issue) => issue.code))];
        return invalidContract("execute", generatedAt, "contract.invalid", issues, `contract rejected: ${codes.join(", ")}`);
      }
      const contract = validation.contract;

      if (options.failOnAttempt === request.attemptNumber) {
        return {
          outcome: "failed",
          message: `simulated adapter failure on attempt ${request.attemptNumber} (deterministic test double)`,
          retryable: true,
          errorCode: "adapter.simulated_failure",
          externalReceipt: null,
          evidence: [
            {
              evidenceType: "error_trace",
              body: { generatedAt, phase: "execute", adapterId: ADAPTER_ID, simulated: true, attemptNumber: request.attemptNumber },
            },
          ],
        };
      }
      if (options.reviewOnAttempt === request.attemptNumber) {
        return {
          outcome: "needs_review",
          message: `simulated human review checkpoint on attempt ${request.attemptNumber} (deterministic test double)`,
          retryable: false,
          errorCode: "adapter.simulated_review",
          externalReceipt: null,
          evidence: [
            {
              evidenceType: "validation_report",
              body: { generatedAt, phase: "execute", adapterId: ADAPTER_ID, checkpoint: "simulated_review", attemptNumber: request.attemptNumber },
            },
          ],
        };
      }

      const payload = composePayload(contract);
      const fields = summarizeFields(contract);
      const payloadSnapshot: TaskExecutionEvidenceInput = {
        evidenceType: "payload_snapshot",
        body: {
          generatedAt,
          phase: "execute",
          adapterId: ADAPTER_ID,
          dryRun: true,
          externalSubmissionAttempted: false,
          channel: "none",
          taskId: contract.taskId,
          taskKind: contract.taskKind,
          idempotencyKey: request.idempotencyKey,
          attemptNumber: request.attemptNumber,
          contractSha256: hashContract(contract),
          payload,
          fieldProvenance: fields.map((field) => ({
            fieldId: field.fieldId,
            valueKind: field.valueKind,
            provenance: field.provenance,
            mapped: field.mapped,
            status: field.status,
          })),
        },
      };

      // Research integrity: an external submission can never be reported as
      // succeeded without a verified authorized path, and this adapter has none.
      if (contract.taskKind === "submit_external_response") {
        return {
          outcome: "needs_review",
          message: NO_AUTHORIZED_PATH,
          retryable: false,
          errorCode: "policy.no_authorized_submission_path",
          externalReceipt: null,
          blockedByPolicy: true,
          evidence: [payloadSnapshot],
        };
      }
      if (contract.taskKind === "verify_submission") {
        return {
          outcome: "needs_review",
          message: NO_VERIFICATION_PATH,
          retryable: false,
          errorCode: "policy.no_authorized_verification_path",
          externalReceipt: null,
          blockedByPolicy: true,
          evidence: [payloadSnapshot],
        };
      }

      return {
        outcome: "succeeded",
        message: `composed ${Object.keys(payload).length} payload field(s) locally; no external submission was performed (receipt channel 'none')`,
        retryable: false,
        externalReceipt: {
          receiptId: `${ADAPTER_ID}:${request.idempotencyKey.slice(0, 32)}`,
          submittedAt: generatedAt,
          responseId: null,
          channel: "none",
        },
        evidence: [payloadSnapshot],
      };
    },
  };
}
