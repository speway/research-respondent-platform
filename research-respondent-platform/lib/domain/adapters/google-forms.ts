/**
 * Google Forms adapter: structure/response reads and a policy-gated submission.
 *
 * This module never performs a fetch: whatever the provider capability flags
 * claim, an actual submission must be delegated to an injected `submit`
 * transport that owns its own authentication. Without such a transport — or
 * without a documented provider submission capability — the task is returned as
 * `needs_review` with `blockedByPolicy: true`, never as `succeeded`.
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

export interface GoogleFormsCapabilities {
  api_can_read_structure: boolean;
  api_can_read_responses: boolean;
  api_can_submit_responses: boolean;
}

export interface GoogleFormsConfig {
  /** True only when an out-of-band secret reference is wired for the transport. */
  hasApiCredentials: boolean;
  capabilities: GoogleFormsCapabilities;
}

export interface GoogleFormsSubmission {
  taskId: string;
  idempotencyKey: string;
  attemptNumber: number;
  payload: Record<string, string>;
}

export interface GoogleFormsSubmissionReceipt {
  receiptId: string;
  responseId?: string | null;
  /** Defaults to the injected clock value. */
  submittedAt?: string;
}

/** The transport owns authentication; no secret is ever passed to it. */
export type GoogleFormsSubmit = (submission: GoogleFormsSubmission) => Promise<GoogleFormsSubmissionReceipt>;

export interface GoogleFormsAdapterOptions {
  /** Injected clock. Defaults to the epoch sentinel so runs stay reproducible. */
  now?: () => string;
  /** Injected authorized transport; when absent every submission is refused. */
  submit?: GoogleFormsSubmit;
}

const EPOCH_SENTINEL = "1970-01-01T00:00:00.000Z";
const ADAPTER_ID = "google-forms";
/** Secret *reference* (env var name) only — never a credential value. */
export const GOOGLE_FORMS_SECRET_REF = "GOOGLE_FORMS_SERVICE_ACCOUNT_JSON";
const PROVIDER_LIMITATION =
  "documented Google Forms provider limitation: the Forms API has no endpoint for creating form responses, so api_can_submit_responses is false and automated submission is not authorized";

export function createGoogleFormsAdapter(
  config: GoogleFormsConfig,
  adapterOptions: GoogleFormsAdapterOptions = {},
): TaskAdapter {
  const clock = adapterOptions.now ?? (() => EPOCH_SENTINEL);
  const { capabilities } = config;
  const canSubmit = capabilities.api_can_submit_responses && config.hasApiCredentials;

  function capabilityLimits(): string[] {
    const limits: string[] = [];
    if (!capabilities.api_can_read_structure) {
      limits.push("api_can_read_structure:false — the live form structure cannot be re-read, so the stored field map is unverified");
    }
    if (!capabilities.api_can_read_responses) {
      limits.push("api_can_read_responses:false — submitted responses cannot be read back, so a submission cannot be verified");
    }
    if (!capabilities.api_can_submit_responses) limits.push(`api_can_submit_responses:false — ${PROVIDER_LIMITATION}`);
    if (!config.hasApiCredentials) {
      limits.push(`hasApiCredentials:false — no secret reference '${GOOGLE_FORMS_SECRET_REF}' is configured for the transport`);
    }
    return limits;
  }

  function blocked(
    reason: string,
    errorCode: string,
    evidence: TaskExecutionEvidenceInput[],
  ): TaskExecutionResult {
    return {
      outcome: "needs_review",
      message: reason,
      retryable: false,
      errorCode,
      externalReceipt: null,
      blockedByPolicy: true,
      evidence,
    };
  }

  function invalidContract(phase: string, generatedAt: string, issues: RuleIssue[]): TaskExecutionResult {
    const codes = [...new Set(issues.map((issue) => issue.code))];
    return {
      outcome: "failed",
      message: `contract rejected: ${codes.join(", ")}`,
      retryable: false,
      errorCode: "contract.invalid",
      externalReceipt: null,
      evidence: [
        { evidenceType: "validation_report", body: { generatedAt, phase, adapterId: ADAPTER_ID, outcome: "fail", issues } },
      ],
    };
  }

  /**
   * The transport may be injected at construction time or per request. A
   * `submit` function present in `request.adapterOptions` is honoured so the
   * service can wire it from the agent's authorized capability record.
   */
  function resolveTransport(request: TaskExecutionRequest): GoogleFormsSubmit | undefined {
    if (adapterOptions.submit !== undefined) return adapterOptions.submit;
    const candidate = request.adapterOptions?.["submit"];
    return typeof candidate === "function" ? (candidate as GoogleFormsSubmit) : undefined;
  }

  return {
    id: ADAPTER_ID,
    description:
      "Google Forms adapter: read-only preflight against the stored field map plus a policy-gated submission that must be delegated to an injected authorized transport.",
    capabilities: {
      canPreflight: true,
      canComposePayload: true,
      canSubmitExternally: canSubmit,
      requiresNetwork: true,
      requiresCredentials: true,
    },

    async preflight(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
      const generatedAt = clock();
      const binding = checkRequestBinding(request);
      const validation = validateContract(request.contract, generatedAt);
      if (binding !== null || !validation.ok) {
        return invalidContract("preflight", generatedAt, binding === null ? validation.issues : [binding, ...validation.issues]);
      }
      const contract = validation.contract;
      const fields = summarizeFields(contract);
      const counts = countFields(fields);
      const blockingReasons = blockingFieldReasons(fields);
      const fieldsWithoutDocumentedSource = fields
        .filter((field) => !field.mapped)
        .map((field) => ({
          fieldId: field.fieldId,
          fieldTitle: field.fieldTitle,
          required: field.required,
          provenance: field.provenance,
          reason: field.explicitlyUnmapped
            ? "no documented source is mapped for this field"
            : `valueKind '${field.valueKind}' declared without a value`,
        }));
      const limits = capabilityLimits();
      const outcome = blockingReasons.length > 0 ? "fail" : fieldsWithoutDocumentedSource.length > 0 || limits.length > 0 ? "warn" : "pass";
      const body = {
        generatedAt,
        phase: "preflight",
        adapterId: ADAPTER_ID,
        dryRun: true,
        externalCallMade: false,
        outcome,
        taskId: contract.taskId,
        taskKind: contract.taskKind,
        studyCode: contract.studyCode,
        participantPseudonym: contract.participantPseudonym,
        externalFormVersionId: contract.externalFormVersionId,
        idempotencyKey: request.idempotencyKey,
        contractSha256: hashContract(contract),
        payload: composePayload(contract),
        fields,
        counts,
        fieldsWithoutDocumentedSource,
        capabilityLimits: limits,
        blockingReasons,
        secretReference: GOOGLE_FORMS_SECRET_REF,
      };
      if (outcome === "fail") {
        return {
          outcome: "failed",
          message: `preflight blocked by ${blockingReasons.length} field(s) without a usable documented source: ${blockingReasons.join("; ")}`,
          retryable: false,
          errorCode: "mapping.field_without_source",
          externalReceipt: null,
          evidence: [{ evidenceType: "validation_report", body }],
        };
      }
      return {
        outcome: "succeeded",
        message: `preflight validated ${counts.mapped} of ${counts.total} field(s); ${fieldsWithoutDocumentedSource.length} without a documented source, ${limits.length} capability limitation(s)`,
        retryable: false,
        externalReceipt: null,
        evidence: [{ evidenceType: "validation_report", body }],
      };
    },

    async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
      const generatedAt = clock();
      const binding = checkRequestBinding(request);
      const validation = validateContract(request.contract, generatedAt);
      if (binding !== null || !validation.ok) {
        return invalidContract("execute", generatedAt, binding === null ? validation.issues : [binding, ...validation.issues]);
      }
      const contract = validation.contract;
      const payload = composePayload(contract);
      const fields = summarizeFields(contract);
      const payloadSnapshot: TaskExecutionEvidenceInput = {
        evidenceType: "payload_snapshot",
        body: {
          generatedAt,
          phase: "execute",
          adapterId: ADAPTER_ID,
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
          capabilities: { ...capabilities },
        },
      };

      if (contract.taskKind === "verify_submission") {
        const reason = capabilities.api_can_read_responses
          ? "no authorized verification transport is injected: a submission cannot be confirmed locally, so the task is blocked by policy"
          : "api_can_read_responses is false: responses cannot be read back, so a submission cannot be verified";
        return blocked(reason, "policy.no_authorized_verification_path", [payloadSnapshot]);
      }

      if (contract.taskKind === "submit_external_response") {
        if (!contract.permissions.maySubmitExternalResponse) {
          return blocked(
            "the task contract does not grant permissions.maySubmitExternalResponse, so no submission may be attempted",
            "policy.submission_not_granted_by_contract",
            [payloadSnapshot],
          );
        }
        if (!capabilities.api_can_submit_responses) {
          return blocked(PROVIDER_LIMITATION, "policy.provider_cannot_submit_responses", [payloadSnapshot]);
        }
        if (!config.hasApiCredentials) {
          return blocked(
            `hasApiCredentials is false: no secret reference '${GOOGLE_FORMS_SECRET_REF}' is configured, so no authorized submission path exists`,
            "policy.no_credentials_configured",
            [payloadSnapshot],
          );
        }
        const transport = resolveTransport(request);
        if (transport === undefined) {
          return blocked(
            "no authorized submit transport is injected, so the submission is refused rather than reported as succeeded",
            "policy.no_authorized_submission_path",
            [payloadSnapshot],
          );
        }
        try {
          const receipt = await transport({
            taskId: contract.taskId,
            idempotencyKey: request.idempotencyKey,
            attemptNumber: request.attemptNumber,
            payload,
          });
          const submittedAt = receipt.submittedAt ?? generatedAt;
          return {
            outcome: "succeeded",
            message: `submitted through the injected authorized transport (responseId ${receipt.responseId ?? "(not returned)"})`,
            retryable: false,
            externalReceipt: {
              receiptId: receipt.receiptId,
              submittedAt,
              responseId: receipt.responseId ?? null,
              channel: "api",
            },
            evidence: [
              payloadSnapshot,
              {
                evidenceType: "external_receipt",
                body: {
                  generatedAt: submittedAt,
                  adapterId: ADAPTER_ID,
                  receiptId: receipt.receiptId,
                  responseId: receipt.responseId ?? null,
                  channel: "api",
                  idempotencyKey: request.idempotencyKey,
                  attemptNumber: request.attemptNumber,
                  secretReference: GOOGLE_FORMS_SECRET_REF,
                },
              },
            ],
          };
        } catch (error) {
          return {
            outcome: "failed",
            message: "the injected submit transport failed; no receipt was recorded",
            retryable: true,
            errorCode: "adapter.transport_error",
            externalReceipt: null,
            evidence: [
              payloadSnapshot,
              {
                evidenceType: "error_trace",
                body: {
                  generatedAt,
                  adapterId: ADAPTER_ID,
                  errorName: error instanceof Error ? error.name : "UnknownError",
                  errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
                },
              },
            ],
          };
        }
      }

      return {
        outcome: "succeeded",
        message: `composed ${Object.keys(payload).length} payload field(s) for '${contract.taskKind}'; no external call was made by this adapter`,
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

/** Transport errors are untrusted text: strip anything credential-shaped. */
function redactSecrets(text: string): string {
  return text
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted-oauth-grant]")
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, "[redacted-jwt]")
    // Markers deliberately avoid the words below; `(?!\[)` keeps the catch-all
    // from rewriting an already redacted value, so redaction is idempotent.
    .replace(/\b(api[_-]?key|token|secret|password|authorization|bearer)\b\s*[:=]?\s*(?!\[)\S+/gi, "$1=[redacted]")
    .slice(0, 400);
}
