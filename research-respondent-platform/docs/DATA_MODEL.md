# Data model

Storage is a single SQLite database accessed through `better-sqlite3` in
synchronous, prepared-statement style. There is no ORM and no query builder:
every statement is written out in `lib/repo/*.ts` so the exact SQL is auditable.

Schema source of truth:

| File | Contents |
| --- | --- |
| `db/migrations/0001_core.sql` | All 42 research and platform tables, their CHECK constraints, foreign keys and indexes. |
| `db/migrations/0002_integrity_triggers.sql` | 9 triggers that enforce append-only history, identity basis, provenance and instrument freezing. |
| `db/migrations/0003_search_index.sql` | FTS5 virtual table `participant_search` plus 2 synchronisation triggers. |
| `db/pragmas.sql` | Session pragmas applied to every connection. |
| `db/index.ts` | Connection factory plus the checksummed migration runner. |

Connection pragmas (`db/pragmas.sql`, applied by `db/index.ts`):

- `foreign_keys = ON` - the only pragma that is treated as non-negotiable; after
  applying pragmas the connection re-reads it and forces it on if needed.
- `journal_mode = WAL` (skipped for `:memory:`), `synchronous = NORMAL`,
  `busy_timeout = 5000`, `temp_store = MEMORY`, `trusted_schema = OFF`.

All timestamps are ISO 8601 strings in UTC. All identifiers are opaque text ids
produced by `lib/util/ids.ts` (`newId(prefix)`), except `schema_migration.id`,
which is the migration file name without the `.sql` suffix.

## Tables by area

### Identity and access (5 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `organization` | Tenant root. `slug` unique. Every other row hangs off an organization. |
| `app_user` | Login accounts. `email` unique; `password_hash` + `password_salt` + `password_params` (scrypt parameters are stored so hashes can be upgraded). `is_active` 0/1. |
| `role_assignment` | Role grants per user, optionally per study. Role enum: `admin`, `principal_investigator`, `researcher`, `data_steward`, `reviewer`, `agent_operator`, `viewer`. CHECK: a role without a study may only be `admin` or `data_steward`. `revoked_at` keeps history. |
| `access_grant` | Explicit, revocable grants. `scope_type` in (`study`, `private_identity`, `export`, `integration`), `permission` in (`read`, `write`, `approve`, `export`), optional `expires_at`. Required for identity access. |
| `auth_session` | Server-side sessions. Only `token_hash` is stored (unique); `expires_at`, `revoked_at`, `user_agent`, `ip_hint`. |

### Studies (4 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `study` | `code` unique; `status` in (`draft`, `active`, `paused`, `closed`, `archived`). |
| `study_protocol_version` | Versioned protocol documents. `UNIQUE (study_id, version_label)`, `supersedes_id` chain, ethical approval and consent template text. |
| `recruitment_criterion` | Machine-readable eligibility rules (`rule_json`, evaluated by `lib/domain/cohort.ts`), `kind` in (`inclusion`, `exclusion`). |
| `study_participant` | Enrolment record. `UNIQUE (study_id, participant_id)`, `status` in (`invited`, `enrolled`, `active`, `completed`, `withdrawn`, `excluded`), withdrawal timestamp and reason. |

### Participants, identity and consent (3 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `participant` | Pseudonymous analytic record. `pseudonym` unique. Analytic attributes only (`birth_year`, `age_at_enrolment`, `self_described_gender`, `preferred_language`, `education_level`, `region`, `recruitment_channel`). `birth_year` is bounded 1900-2100, `age_at_enrolment >= 0`. `attribute_missingness_json` records which attributes the source document omits. No names, e-mails or phone numbers. |
| `participant_private_identity` | The only place identity data may live: `full_name`, `contact_email` (unique when present), `contact_phone`, `contact_handle`, `lawful_basis`, `retention_until`. One row per participant. |
| `consent_record` | Consent per participant, optionally per study. `UNIQUE (participant_id, study_id, consent_version)`. `status` in (`granted`, `declined`, `withdrawn`, `expired`); `basis` in (`written_signed`, `digital_form`, `verbal_witnessed`, `guardian_proxy`, `institutional_blanket`); `scope_json`, `evidence_source_id` pointing at the documented source that proves consent. |

### Provenance (2 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `documented_source` | One row per documented source document: `origin_type` (10 values, including `google_form_export`, `spss_dataset`, `paper_form`, `manual_entry_signed`), `reference`, `location`, `collected_from`, `collected_at`, `received_at`, `content_sha256`, `row_count`, `integrity_notes`. |
| `evidence_link` | Typed pointer from a source to an entity: `entity_type` in (`participant`, `assessment_session`, `observed_answer`, `derived_score`, `consent_record`, `eligibility_decision`, `manual_entry`), plus `locator` (sheet/row/column/line). This is how any stored value can be traced back to a place in a source document. |

### Instruments and scoring definitions (5 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `instrument` | Instrument metadata. `slug` unique. `rights_status` in (`public_domain`, `open_access`, `licensed_local`, `permission_pending`, `restricted_no_redistribution`), plus `rights_note`, `license_holder`, `is_clinical`, `requires_supervision`, `tradition` (13 values), `construct_domains_json`. |
| `instrument_version` | `UNIQUE (instrument_id, version_label, language)`. Carries `is_provisional`, `clinical_use_permitted`, `limitations`, `norm_reference`, `source_document_id`, `supersedes_id` and `frozen_at` (set when the first answer is recorded; wording edits are then rejected by a trigger). |
| `item_definition` | Item wording and format. `UNIQUE (instrument_version_id, item_code)`. `text_verbatim` is the verbatim wording; `response_type` in (`likert`, `yes_no`, `multiple_choice`, `numeric`, `open_text`, `date`, `categorical`); `options_json`, `min_value`, `max_value`, `required`, `reverse_scored`, `rights_note`. |
| `scale_definition` | `UNIQUE (instrument_version_id, scale_code)`. `kind` in (`raw_sum`, `mean`, `weighted_sum`, `factor_score`, `clinical_elevation`, `index`), `direction`, `min_possible`, `max_possible`, `interpretation_bands_json`, `norm_notes`. |
| `score_algorithm` | Versioned, declarative scoring pipeline (`algorithm_json`). `UNIQUE (instrument_version_id, scale_definition_id, algorithm_version)`. `missing_policy` in (`strict_complete`, `prorate_if_min_met`, `sum_available_only`, `no_score`), `min_items_required`, `is_active`. Executed deterministically by `lib/domain/scoring.ts`. |

### Assessments (4 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `assessment_session` | One administration of one instrument version to one participant at one timepoint. `UNIQUE (participant_id, instrument_version_id, timepoint_label)`, `session_index`, `administration_mode` (6 values), `language`, `documented_source_id` NOT NULL, `protocol_version_id`, `quality_flags_json`. |
| `observed_answer` | The atomic research value. `UNIQUE (assessment_session_id, item_definition_id)`. Stores `raw_value_text` exactly as documented, `value_numeric`, `value_coded`, `is_missing`, `missing_reason` (7 documented reasons), `source_documented_source_id` NOT NULL, `source_locator` NOT NULL, `collected_at`, `imported_at`. Two CHECK rules make the missing state explicit: `is_missing = 1` requires a `missing_reason` and forbids both value columns; `is_missing = 0` requires at least one value column. |
| `derived_score` | A computed score with full provenance: `score_algorithm_id` + `algorithm_version`, `raw_score`, `transformed_score`, `standardized_score`, `standard_error`, `percentile`, `items_used`, `items_missing`, `is_provisional`, `computability` in (`computed`, `not_computable`), `not_computable_reason`, `source_item_ids_json`, `superseded_by_id`. CHECK: a row that is not `computed` must carry a reason. |
| `interpretation_annotation` | Human interpretation attached to a participant, session or score: `annotation_type` in (`assessor_note`, `hypothesis`, `limitation`, `norm_caution`, `clinical_flag`, `follow_up_required`), `body`, optional `confidence` in (`low`, `moderate`, `high`). Never generated automatically. |

### Cohorts and eligibility (4 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `segment` | A named cohort definition, `UNIQUE (organization_id, study_id, name)`. `study_id NULL` means an organization-wide segment. |
| `segment_rule` | Ordered rules: `UNIQUE (segment_id, order_index)`, `kind` in (`include`, `exclude`), `rule_json`, `label`. |
| `segment_snapshot` | Frozen evaluation result: `UNIQUE (segment_id, revision)`, `rules_sha256`, `evaluated_at`, denominator, included/excluded/indeterminate counts, full `result_json`. Comparing snapshots is how a cohort definition change is audited. |
| `eligibility_decision` | Per-participant decision: `decision` in (`eligible`, `ineligible`, `indeterminate`), `explanation_json`, optional link to the snapshot that produced it. `indeterminate` is a first-class outcome, not an error. |

### External forms and mapping (5 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `external_form` | Researcher-controlled external form. `provider` in (`google_forms`, `microsoft_forms`, `limesurvey`, `other`); `UNIQUE (provider, external_id)`. Capability facts are stored explicitly: `api_can_read_structure`, `api_can_read_responses`, `api_can_submit_responses` (all default 0) plus `capability_evidence`. |
| `external_form_version` | `UNIQUE (external_form_id, version_label)`. `structure_sha256` makes structural drift detectable; `supersedes_id`, `captured_at`, `source_document_id`. |
| `external_form_field` | `UNIQUE (external_form_version_id, field_id)`. `field_type` (12 values), `is_required`, `options_json`, `section`, `order_index`, plus the raw provider JSON. |
| `field_mapping` | `UNIQUE (study_id, external_form_version_id, external_form_field_id)`. `mapping_kind` in (`observed_answer`, `derived_score`, `participant_attribute`, `fixed_constant`, `unmapped`); `value_transform` in (`verbatim`, `option_label`, `option_index`, `numeric_round`, `date_iso`); `status` in (`draft`, `validated`, `rejected`, `stale`); `source_ref_json`, `validation_json`, `rationale`. |
| `mapping_validation` | Append-style validation history per mapping: `run_at`, `outcome` in (`pass`, `warn`, `fail`), `issues_json`, `checked_count`, `run_by`. |

### Agents and tasks (5 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `agent` | Registered executor. `provider` (8 values incl. `local_deterministic`, `human_operator`), `kind` in (`ai`, `human`, `service`), `auth_secret_ref` (the *name* of a secret, never the value), `is_active`. `UNIQUE (organization_id, name)`. |
| `agent_capability` | `UNIQUE (agent_id, capability)`. `capability` in (`read_field_map`, `read_permitted_answers`, `preflight_only`, `submit_external_response`, `attach_execution_evidence`, `request_human_review`), `scope_json`, `max_submissions_per_day`, revocation timestamp. |
| `agent_task` | The durable task. `kind` in (`preflight_mapping`, `compose_form_payload`, `submit_external_response`, `verify_submission`, `collect_documented_answers`); `state` in the 10-value task machine; `contract_json` + `contract_sha256`; `idempotency_key` with a UNIQUE index; `requires_approval` (default 1), `approved_by`/`approved_at`/`approval_note`, `attempt_count`/`max_attempts` (default 3), `expires_at`, `last_error`, timestamps for queue/start/finish. |
| `task_attempt` | One execution attempt. `UNIQUE (agent_task_id, attempt_number)`, `state_from`/`state_to`, `adapter`, `request_json`, `response_json`, `error_code`, `error_message`, `retryable`. |
| `execution_evidence` | Immutable evidence per task or attempt: `evidence_type` in (`dry_run_report`, `payload_snapshot`, `external_receipt`, `screenshot_reference`, `human_attestation`, `validation_report`, `error_trace`), `body_json` + `body_sha256`. |

### Audit, exports and retention (4 tables)

| Table | Purpose and notable constraints |
| --- | --- |
| `audit_event` | Append-only log: `occurred_at`, `actor_type` in (`user`, `agent`, `system`), `actor_id`, `actor_label`, `action`, `entity_type`, `entity_id`, `study_id`, `participant_id`, `outcome` in (`success`, `failure`, `denied`, `partial`), `severity` in (`info`, `notice`, `warning`, `critical`), `detail_json`, `request_id`, `ip_hint`. |
| `export_job` | Export request and lifecycle: `format` in (`csv`, `json`, `jsonl`); `scope` in (`analytic_deidentified`, `provenance_audit`, `cohort_manifest`, `task_execution_report`, `identity_restricted`); `status` in (`pending`, `approved`, `running`, `completed`, `failed`, `cancelled`); `requested_by`, `approved_by`, `row_count`, `output_sha256`, `output_path`, `denial_reason`. CHECK: `contains_identity = 1` is only allowed for the `identity_restricted` scope. |
| `retention_policy` | `UNIQUE (organization_id, entity_type)` over 6 entity types, `retention_months`, `action_on_expiry` in (`anonymize`, `delete`, `review`), `lawful_basis`. |
| `system_setting` | Key/value platform settings (`value_json`). |

### Bookkeeping and search (2 objects)

| Object | Purpose |
| --- | --- |
| `schema_migration` | Applied migration id, `applied_at`, `checksum`, `duration_ms`, `applied_by`. Written inside the same transaction as the migration itself. |
| `participant_search` (FTS5) | Full-text index over `pseudonym`, `notes`, `recruitment_channel`, `region`, kept in sync by `trg_participant_search_insert` and `trg_participant_search_update`. Identity fields are deliberately not indexed. |

## The seven invariants

### 1. Every answer has provenance

Enforced by: `observed_answer.source_documented_source_id NOT NULL` and
`source_locator NOT NULL` (a value cannot be stored without naming the document
and the position inside it); `assessment_session.documented_source_id NOT NULL`;
the trigger `trg_documented_source_required_for_answers` (rejects a session whose
source row does not exist); `evidence_link` for entity-to-source traceability;
`lib/repo/sources.ts` `provenanceCoverage()` and the Overview page alert
"answer(s) lack a documented source link".

### 2. Scores are versioned and immutable

Enforced by: `derived_score.score_algorithm_id` + `algorithm_version` NOT NULL
with the algorithm row versioned by `UNIQUE (instrument_version_id,
scale_definition_id, algorithm_version)`; `source_item_ids_json` recording the
exact items used; the trigger `trg_derived_score_guard_update` (aborts any update
to the numeric result, item provenance, algorithm version or computability);
`trg_derived_score_no_delete` (rows are superseded via `superseded_by_id`, never
deleted).

### 3. Missing stays missing

Enforced by: the two-branch CHECK on `observed_answer` (see above), so a row is
either "has a value" or "is missing with a reason" and can never be a blank
middle state; `missing_reason` constrained to 7 documented reasons;
`participant.attribute_missingness_json` for omitted attributes;
`derived_score` CHECK requiring `not_computable_reason` whenever
`computability != 'computed'`. Application layer: `lib/domain/scoring.ts` never
imputes, `lib/domain/mapping.ts` omits missing keys and raises a blocking reason
for required fields, and `lib/domain/cohort.ts` defaults to `indeterminate` when
data is absent.

### 4. Consent precedes export and submission

Enforced by: `consent_record` with version, basis, scope and an evidence link;
`export_job` CHECK restricting `contains_identity = 1` to the
`identity_restricted` scope plus the `approved_by`/`approved_at` gate in
`lib/repo/exports.ts`; `lib/services/authz.ts` `requireActiveConsent()`. Import
side: `lib/import/plan.ts` adds the blockers `import.consent_not_declared` and
`import.consent_evidence_missing`, and `requireCommittingPlan()` refuses to commit
a plan carrying blockers. Submission side: `lib/domain/mapping.ts` marks consent
not on file as a blocking reason, `buildTaskContract()` sets
`permissions.maySubmitExternalResponse` only when the preflight authorizes it, and
the adapters refuse to submit without an approved path.

Gap: there is no database trigger for consent. A row can be written to
`consent_record` only through application code, and export/submission decisions
are application-level. This is stated as a limitation in
`docs/RESEARCH_INTEGRITY.md`.

### 5. The audit log is append-only

Enforced by: `trg_audit_event_no_update` and `trg_audit_event_no_delete` (both
`RAISE(ABORT)`); `trg_observed_answer_no_update` / `trg_observed_answer_no_delete`
for recorded answers; `trg_derived_score_no_delete`. Application layer:
`lib/services/audit.ts` `recordAudit()` is the only writer,
`scrubAuditDetail()` redacts keys matching
`/(password|secret|token|apikey|api_key|authorization|cookie)/i` before storage,
and `auditIntegrityReport()` counts the `trg_audit_event_no_%` triggers in
`sqlite_master` so a database missing them is reported (`appendOnlyEnforced`), and
the Overview page turns that into a fail-level alert.

### 6. Identity data is separated from research data

Enforced by: a dedicated `participant_private_identity` table (one row per
participant) that no analytic table references; a partial unique index on
`contact_email`; the trigger `trg_private_identity_requires_basis` (rejects an
identity row without a documented `lawful_basis`); `access_grant.scope_type =
'private_identity'` for explicit grants; role modelling where `identity:read`
is held by `admin` and `data_steward` only (the `principal_investigator` role
list explicitly omits it) and is otherwise granted per user. Search indexing
covers pseudonym and cohort attributes only.

### 7. External task delivery is idempotent and evidence-bound

Enforced by: the UNIQUE index `idx_agent_task_idempotency` on
`agent_task.idempotency_key`; `contract_sha256` stored beside `contract_json`;
`UNIQUE (agent_task_id, attempt_number)` on `task_attempt`; `body_sha256` on
`execution_evidence`. Application layer: `buildIdempotencyKey()` in
`lib/domain/task-flow.ts` derives the key from SHA-256 over study, participant,
form version, task kind and contract version (no randomness), and
`createTaskFromPreflight()` returns the existing task and records the audit
action `task.create.idempotent_replay` instead of creating a duplicate.

## Trigger reference

| Trigger (migration 0002 unless noted) | Table | Rule enforced |
| --- | --- | --- |
| `trg_observed_answer_no_update` | `observed_answer` | Answers are write-once; corrections go into a new session revision. |
| `trg_observed_answer_no_delete` | `observed_answer` | Answers cannot be deleted; the session is withdrawn with an audit event instead. |
| `trg_derived_score_guard_update` | `derived_score` | Numeric results, item provenance, algorithm version and computability are immutable. |
| `trg_derived_score_no_delete` | `derived_score` | Scores are superseded, not deleted. |
| `trg_audit_event_no_update` | `audit_event` | The audit log cannot be rewritten. |
| `trg_audit_event_no_delete` | `audit_event` | The audit log cannot be pruned by the application. |
| `trg_private_identity_requires_basis` | `participant_private_identity` | Identity data requires a documented lawful basis. |
| `trg_documented_source_required_for_answers` | `assessment_session` | A session must reference an existing documented source. |
| `trg_instrument_version_frozen_items` | `item_definition` | Once answers exist for a version, item wording, response type, options, keying and item code are frozen. |
| `trg_participant_search_insert` (0003) | `participant` | Keeps the FTS index populated. |
| `trg_participant_search_update` (0003) | `participant` | Re-indexes changed participant rows. |

## Known schema-level gaps

These are recorded so the model is not over-trusted:

1. No trigger enforces consent before an export or a submission; only
   application code does.
2. Deletion is still possible for entities without a no-delete trigger
   (for example `participant`, `consent_record`, `documented_source`). Cascades
   are used for dependent rows.
3. `participant.birth_year` and `age_at_enrolment` are stored but the schema does
   not compute age at a timepoint; that is a domain concern.
4. Retention is recorded and assessed, never executed: `assessRetention()`
   reports candidate rows and the proposed action, and the actual anonymisation
   or deletion remains a human, audited step that is not implemented yet.
