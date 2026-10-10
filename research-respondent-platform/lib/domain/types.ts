/**
 * Shared, framework-free domain contracts.
 *
 * Everything in `lib/domain` is pure TypeScript: no database, no React, no
 * network. That keeps the methodological rules (scoring, cohort eligibility,
 * mapping validation, task state) unit-testable in isolation and reusable by
 * the repository layer, the API layer and the UI.
 */

export type IsoTimestamp = string;

// ---------------------------------------------------------------- utilities --

export interface RuleIssue {
  code: string;
  severity: "info" | "warn" | "fail";
  message: string;
  /** Optional structured pointer, e.g. { fieldId: "abc" } or { itemCode: "07" }. */
  detail?: Record<string, unknown>;
}

export class DomainError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.detail = detail;
  }
}

// ------------------------------------------------------- participant cohorts --

export type CohortRuleOperator =
  | "equals"
  | "not_equals"
  | "in"
  | "not_in"
  | "gte"
  | "lte"
  | "between"
  | "is_missing"
  | "is_present"
  | "has_any_assessment"
  | "has_scale_score"
  | "consent_status"
  | "study_status"
  | "missingness_at_most";

export type CohortRuleSubject =
  | "participant_attribute"
  | "consent"
  | "study_enrolment"
  | "scale_score"
  | "assessment"
  | "data_quality";

/**
 * A single machine-readable eligibility condition.
 *
 * `missingBehaviour` is the methodological safety valve: by default a rule whose
 * subject data is absent yields `indeterminate` (never a silent pass/fail).
 */
export interface CohortRule {
  id: string;
  subject: CohortRuleSubject;
  operator: CohortRuleOperator;
  /** e.g. "age_at_enrolment", "TOLERANCE_TOTAL", "granted". */
  field?: string;
  value?: string | number | boolean | Array<string | number>;
  /** Required for `between`. */
  valueMax?: number | string;
  /** Instrument/scale scoping for score rules. */
  instrumentVersionId?: string;
  scaleCode?: string;
  /** Restrict score rules to a timepoint. */
  timepointLabel?: string;
  /** Most recent N assessments only (default: any). */
  withinDays?: number;
  missingBehaviour?: "indeterminate" | "exclude" | "ignore";
  label?: string;
}

export interface ParticipantFactConsent {
  status: "granted" | "declined" | "withdrawn" | "expired" | "none";
  studyId: string | null;
  version: string | null;
  grantedAt: string | null;
  withdrawnAt: string | null;
  expiresAt: string | null;
}

export interface ParticipantFactEnrolment {
  studyId: string;
  status: "invited" | "enrolled" | "active" | "completed" | "withdrawn" | "excluded";
  enrolledAt: string;
  withdrawnAt: string | null;
}

export interface ParticipantFactAssessment {
  sessionId: string;
  studyId: string | null;
  instrumentVersionId: string;
  timepointLabel: string;
  completedAt: string | null;
  recordedAt: string;
  answeredItems: number;
  totalItems: number;
  missingItems: number;
}

export interface ParticipantFactScore {
  scaleCode: string;
  instrumentVersionId: string;
  rawScore: number | null;
  transformedScore: number | null;
  standardizedScore: number | null;
  percentile: number | null;
  computability: "computed" | "not_computable";
  algorithmVersion: string;
  assessmentSessionId: string;
  computedAt: string;
}

export interface ParticipantFact {
  participantId: string;
  pseudonym: string;
  attributes: Record<string, string | number | boolean | null>;
  consents: ParticipantFactConsent[];
  enrolments: ParticipantFactEnrolment[];
  assessments: ParticipantFactAssessment[];
  scores: ParticipantFactScore[];
}

export interface CohortRuleTrace {
  ruleId: string;
  label: string;
  subject: CohortRuleSubject;
  operator: CohortRuleOperator;
  outcome: "include" | "exclude" | "indeterminate" | "not_applicable";
  observed: string;
  expected: string;
  explanation: string;
  missing: boolean;
}

export interface CohortEvaluation {
  participantId: string;
  pseudonym: string;
  decision: "included" | "excluded" | "indeterminate";
  traces: CohortRuleTrace[];
  includeFailures: number;
  excludeHits: number;
  indeterminateReasons: string[];
}

export interface CohortPreview {
  denominator: number;
  included: number;
  excluded: number;
  indeterminate: number;
  evaluations: CohortEvaluation[];
  /** Per-rule outcome counts, used to show where a filter is too aggressive. */
  ruleSummary: Array<{
    ruleId: string;
    label: string;
    include: number;
    exclude: number;
    indeterminate: number;
    notApplicable: number;
  }>;
  missingnessSummary: Array<{
    field: string;
    missingCount: number;
    presentCount: number;
  }>;
  warnings: RuleIssue[];
}

// ------------------------------------------------------------- psychometrics --

export type MissingPolicy =
  | "strict_complete"
  | "prorate_if_min_met"
  | "sum_available_only"
  | "no_score";

export type ScoreAlgorithmStep =
  | {
      kind: "recoded_sum";
      itemCodes: string[];
      reverseItemCodes?: string[];
      /** value + min + max for reversed items; defaults to item bounds. */
      reverseKey?: { min: number; max: number };
      multiplyBy?: number;
      addConstant?: number;
    }
  | {
      kind: "weighted_sum";
      weights: Array<{ itemCode: string; weight: number; reverse?: boolean }>;
      multiplyBy?: number;
      addConstant?: number;
    }
  | { kind: "mean_of_items"; itemCodes: string[]; reverseItemCodes?: string[]; reverseKey?: { min: number; max: number } }
  | { kind: "subscale_sum"; subscales: Array<{ scaleCode: string }> }
  | {
      kind: "linear_transform";
      fromRawScale?: string;
      multiplyBy: number;
      addConstant: number;
    }
  | { kind: "z_score"; mean: number; sd: number; sourceRawScale?: string }
  | { kind: "percentile_lookup"; table: Array<{ atOrAbove: number; percentile: number }>; sourceRawScale?: string }
  | { kind: "band_lookup"; bands: Array<{ max: number | null; label: string; note?: string }>; sourceRawScale?: string };

export interface ScoreAlgorithmDefinition {
  algorithmVersion: string;
  steps: ScoreAlgorithmStep[];
  missingPolicy: MissingPolicy;
  minItemsRequired: number;
  documentation?: string;
}

export interface ScorableItem {
  itemDefinitionId: string;
  itemCode: string;
  orderIndex: number;
  responseType: "likert" | "yes_no" | "multiple_choice" | "numeric" | "open_text" | "date" | "categorical";
  minValue: number | null;
  maxValue: number | null;
  reverseScored: boolean;
  isRequired: boolean;
}

export interface ScorableAnswer {
  itemDefinitionId: string;
  itemCode: string;
  valueNumeric: number | null;
  valueCoded: string | null;
  rawValueText: string;
  isMissing: boolean;
  missingReason: string | null;
}

export interface ScoreDiagnostic {
  code: string;
  severity: "info" | "warn" | "fail";
  message: string;
  itemCode?: string;
}

export interface ItemContribution {
  itemCode: string;
  value: number | null;
  reversed: boolean;
  contribution: number | null;
  included: boolean;
  note?: string;
}

export interface ComputedScore {
  scaleCode: string;
  computability: "computed" | "not_computable";
  notComputableReason: string | null;
  rawScore: number | null;
  transformedScore: number | null;
  standardizedScore: number | null;
  percentile: number | null;
  bandLabel: string | null;
  bandNote: string | null;
  itemsUsed: number;
  itemsMissing: number;
  itemsExpected: number;
  sourceItemIds: string[];
  contributions: ItemContribution[];
  algorithmVersion: string;
  diagnostics: ScoreDiagnostic[];
  /** True when the score must not be presented as a validated clinical result. */
  methodologicallyProvisional: boolean;
}

export interface ScaleScoringSpec {
  scaleDefinitionId: string;
  scaleCode: string;
  scaleTitle: string;
  kind: "raw_sum" | "mean" | "weighted_sum" | "factor_score" | "clinical_elevation" | "index";
  instrumentVersionId: string;
  /** Item codes that feed this scale, used for coverage reporting. */
  itemCodes: string[];
  algorithmId: string;
  algorithm: ScoreAlgorithmDefinition;
}

export interface SessionScoringInput {
  assessmentSessionId: string;
  instrumentVersionId: string;
  instrumentTitle: string;
  clinicalUsePermitted: boolean;
  provisionalInstrument: boolean;
  items: ScorableItem[];
  answers: ScorableAnswer[];
  scales: ScaleScoringSpec[];
}

export interface SessionScoringResult {
  assessmentSessionId: string;
  scores: ComputedScore[];
  sessionDiagnostics: ScoreDiagnostic[];
  coverage: {
    totalItems: number;
    answeredItems: number;
    missingItems: number;
    missingByReason: Record<string, number>;
    completenessRatio: number;
  };
}

// ------------------------------------------------------- external form mapping --

export type ExternalFieldType =
  | "short_text"
  | "paragraph"
  | "multiple_choice"
  | "checkbox"
  | "dropdown"
  | "linear_scale"
  | "date"
  | "time"
  | "grid"
  | "file_upload"
  | "section_header"
  | "unknown";

export interface ExternalFormFieldInput {
  fieldId: string;
  orderIndex: number;
  title: string;
  fieldType: ExternalFieldType;
  isRequired: boolean;
  options: string[];
  section: string | null;
}

export interface MappingCandidate {
  mappingId: string;
  mappingKind: "observed_answer" | "derived_score" | "participant_attribute" | "fixed_constant" | "unmapped";
  valueTransform: "verbatim" | "option_label" | "option_index" | "numeric_round" | "date_iso";
  sourceRef: Record<string, unknown>;
  status: "draft" | "validated" | "rejected" | "stale";
  rationale: string | null;
}

export interface MappingSourceContext {
  participantId: string;
  pseudonym: string;
  answers: Array<{
    itemDefinitionId: string;
    itemCode: string;
    questionText: string;
    responseType: string;
    options: string[];
    minValue: number | null;
    maxValue: number | null;
    valueNumeric: number | null;
    valueCoded: string | null;
    rawValueText: string;
    isMissing: boolean;
    missingReason: string | null;
    collectedAt: string | null;
    sessionId: string;
    documentedSourceId: string;
    sourceLocator: string;
  }>;
  scores: Array<{
    scaleCode: string;
    scaleTitle: string;
    rawScore: number | null;
    transformedScore: number | null;
    computability: "computed" | "not_computable";
    algorithmVersion: string;
    sessionId: string;
  }>;
  attributes: Record<string, string | number | boolean | null>;
}

export interface FieldMappingValidation {
  mappingId: string;
  fieldId: string;
  fieldTitle: string;
  outcome: "pass" | "warn" | "fail";
  issues: RuleIssue[];
  resolvedValue: string | null;
  resolvedDisplay: string | null;
  valueKind: "text" | "numeric" | "option" | "date" | "none";
}

export interface PreflightReport {
  studyId: string;
  participantId: string;
  externalFormVersionId: string;
  generatedAt: IsoTimestamp;
  outcome: "pass" | "warn" | "fail";
  fields: FieldMappingValidation[];
  payload: Record<string, string>;
  counts: { pass: number; warn: number; fail: number; unmappedRequired: number; missingSource: number };
  blockingReasons: string[];
  /** Always true until an approved execution records real external receipts. */
  dryRun: true;
  authorization: {
    consentStatus: string;
    consentVersion: string | null;
    participantConsentOnFile: boolean;
    submissionAllowedByPlatform: boolean;
    submissionBlockedReason: string | null;
  };
  auditNotes: string[];
}

// ----------------------------------------------------------- agent task model --

export type TaskState =
  | "draft"
  | "validated"
  | "approved"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_review"
  | "cancelled"
  | "expired";

export type TaskKind =
  | "preflight_mapping"
  | "compose_form_payload"
  | "submit_external_response"
  | "verify_submission"
  | "collect_documented_answers";

export interface AgentTaskContract {
  contractVersion: "1.0";
  taskId: string;
  taskKind: TaskKind;
  studyId: string;
  studyCode: string;
  participantPseudonym: string;
  /** Pseudonymous only: never carries names, e-mails or phone numbers. */
  externalFormVersionId: string | null;
  externalFormTitle: string | null;
  fieldMap: Array<{
    fieldId: string;
    fieldTitle: string;
    fieldType: ExternalFieldType;
    required: boolean;
    value: string | null;
    valueKind: "text" | "numeric" | "option" | "date" | "none";
    provenance: string;
  }>;
  permittedAnswers: Array<{
    itemCode: string;
    questionText: string;
    value: string;
    collectedAt: string | null;
    documentedSourceId: string;
    sourceLocator: string;
  }>;
  permissions: {
    mayReadPermittedAnswers: boolean;
    maySubmitExternalResponse: boolean;
    mayAttachEvidence: boolean;
    mayRequestHumanReview: boolean;
    /** Record ids the agent must not fetch, recorded for audit. */
    forbiddenScopes: string[];
  };
  expiresAt: IsoTimestamp;
  idempotencyKey: string;
  callback: { mode: "none" | "poll" | "webhook"; url: string | null };
  notes: string[];
}

export interface TaskTransitionResult {
  allowed: boolean;
  from: TaskState;
  to: TaskState;
  reason: string;
  requiresActorRole?: string;
}

export interface TaskExecutionEvidenceInput {
  evidenceType:
    | "dry_run_report"
    | "payload_snapshot"
    | "external_receipt"
    | "screenshot_reference"
    | "human_attestation"
    | "validation_report"
    | "error_trace";
  body: Record<string, unknown>;
}

export interface TaskExecutionRequest {
  taskId: string;
  contract: AgentTaskContract;
  attemptNumber: number;
  idempotencyKey: string;
  /** Deterministic adapters use this to make repeated runs reproducible. */
  adapterOptions?: Record<string, unknown>;
}

export interface TaskExecutionResult {
  outcome: "succeeded" | "failed" | "needs_review";
  message: string;
  retryable: boolean;
  errorCode?: string;
  externalReceipt?: {
    receiptId: string;
    submittedAt: IsoTimestamp;
    responseId: string | null;
    channel: "api" | "browser_automation" | "human_operator" | "none";
  } | null;
  evidence: TaskExecutionEvidenceInput[];
  /** Set when the adapter refuses because the platform has no authorized path. */
  blockedByPolicy?: boolean;
}

export interface TaskAdapter {
  readonly id: string;
  readonly description: string;
  /** Capabilities this adapter can actually perform (never assumed). */
  readonly capabilities: {
    canPreflight: boolean;
    canComposePayload: boolean;
    canSubmitExternally: boolean;
    requiresNetwork: boolean;
    requiresCredentials: boolean;
  };
  preflight(request: TaskExecutionRequest): Promise<TaskExecutionResult>;
  execute(request: TaskExecutionRequest): Promise<TaskExecutionResult>;
}

// ----------------------------------------------------- documented data import --

export type ImportFieldRole =
  | "participant_key"
  | "collected_at"
  | "instrument_item"
  | "participant_attribute"
  | "identity_email"
  | "identity_name"
  | "ignore";

export interface ImportColumn {
  index: number;
  header: string;
  role: ImportFieldRole;
  /** For instrument_item: the item code of the target instrument version. */
  itemCode?: string;
  /** For participant_attribute: the participant column name. */
  attribute?: string;
  /** For identity_email/identity_name: stored only in the restricted identity table. */
  identityField?: "contact_email" | "full_name" | "contact_phone";
  options?: string[];
  minValue?: number | null;
  maxValue?: number | null;
}

export interface ImportSourceDescriptor {
  organizationId: string;
  /** Optional: a source document may predate a study or serve several. */
  studyId?: string | null;
  originType:
    | "google_form_export"
    | "spreadsheet"
    | "spss_dataset"
    | "csv_export"
    | "paper_form"
    | "interview_transcript"
    | "observation_log"
    | "external_api"
    | "manual_entry_signed"
    | "instrument_report";
  title: string;
  reference: string;
  location?: string;
  collectedFrom?: string;
  collectedAt?: string;
  integrityNotes?: string;
  contentSha256?: string;
}

export interface ImportOptions {
  /** Descriptive label of the timepoint, e.g. "T1" or "2025-10-30 wave". */
  timepointLabel: string;
  administrationMode:
    | "self_online"
    | "self_paper"
    | "interviewer_assisted"
    | "group_paper"
    | "imported_dataset"
    | "external_form";
  language: string;
  /** Consent declaration recorded by the operator running the import. */
  consent: {
    declared: boolean;
    basis:
      | "written_signed"
      | "digital_form"
      | "verbal_witnessed"
      | "guardian_proxy"
      | "institutional_blanket";
    version: string;
    scope: string[];
    evidenceNote: string;
    /** Date the consent was collected from participants, if uniform. */
    grantedAt?: string;
  };
  /** Persist identity columns into the restricted identity table. */
  storeIdentity: boolean;
  /** When false nothing is written: the plan/report is returned only. */
  commit: boolean;
  /** Deterministic participant pseudonym prefix, e.g. "P23". */
  pseudonymPrefix?: string;
}

export interface ImportRow {
  rowNumber: number;
  cells: Array<string | number | boolean | null>;
}

export interface ImportPlanRow {
  rowNumber: number;
  participantKey: string | null;
  pseudonym: string;
  collectedAt: string | null;
  items: Array<{
    itemCode: string;
    rawValueText: string;
    valueNumeric: number | null;
    valueCoded: string | null;
    isMissing: boolean;
    missingReason: string | null;
    columnIndex: number;
    issueCodes: string[];
  }>;
  attributes: Record<string, string | number | boolean | null>;
  identity: { contact_email?: string; full_name?: string; contact_phone?: string } | null;
  issues: RuleIssue[];
  /** A row can be skipped entirely when it carries no usable research data. */
  skippable: boolean;
}

export interface ImportPlan {
  descriptor: ImportSourceDescriptor;
  options: ImportOptions;
  columns: ImportColumn[];
  rows: ImportPlanRow[];
  summary: {
    totalRows: number;
    usableRows: number;
    skippedRows: number;
    duplicateParticipantKeys: number;
    totalCells: number;
    missingCells: number;
    outOfRangeCells: number;
    invalidDateCells: number;
    unmappedCells: number;
    identityCells: number;
    perItemMissing: Array<{ itemCode: string; missing: number; present: number }>;
  };
  issues: RuleIssue[];
  /** Hard blockers prevent commit. */
  blockers: RuleIssue[];
  warnings: RuleIssue[];
}

export interface ImportCommitResult {
  documentedSourceId: string;
  sessionsCreated: number;
  answersCreated: number;
  participantsCreated: number;
  participantsMatched: number;
  identityRecordsCreated: number;
  consentRecordsCreated: number;
  skippedRows: number;
  auditEventIds: string[];
}

// -------------------------------------------------------------- authorization --

export type ActorType = "user" | "agent" | "system";

export interface Actor {
  type: ActorType;
  id: string | null;
  label: string;
  roles: string[];
  organizationId: string;
  /** Permission scopes: "study:<id>:write", "export:create", ... */
  permissions: string[];
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
  missingPermission?: string;
  policyCode: string;
}
