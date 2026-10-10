# Research integrity policy (operational)

This document states, in operational terms, what the platform does and does not
do with research data. Every claim below points at the code or schema element
that enforces it. Where something is not implemented, it says so explicitly.

Standing rule: the platform records what a documented source says and refuses to
produce anything else. It does not create participants, answers, scores, consent
records or values that no source document supports, and it does not convert "no
data" into a value.

## 1. What the platform refuses to do

| Refusal | Enforced by |
| --- | --- |
| Create a participant, answer, session or score without a documented source | `observed_answer.source_documented_source_id NOT NULL`, `assessment_session.documented_source_id NOT NULL`, trigger `trg_documented_source_required_for_answers`; `scripts/bootstrap.ts` and `lib/services/bootstrap.ts` create an organization, one administrator and retention defaults only ("No participants, responses or scores were created."). |
| Fill, impute, interpolate or default a missing value | `observed_answer` CHECK constraint (a missing row must have a reason and both value columns NULL); `lib/domain/scoring.ts` (only reverse-keying, declared scaling, declared missing policy and display rounding are allowed); `lib/domain/mapping.ts` (`source answer is documented as missing` is a blocking reason for a required field, a warning with the key omitted for an optional field, and never a value, dash, empty string or placeholder). |
| Treat absent data as a satisfied criterion | `lib/domain/cohort.ts`: `DEFAULT_MISSING_BEHAVIOUR = "indeterminate"`; `MISSING_BEHAVIOURS = indeterminate | exclude | ignore`; participants whose data is absent are counted as indeterminate rather than included, and rules using `missingBehaviour: "ignore"` produce an explicit review warning. |
| Emit a score from insufficient data | `lib/domain/scoring.ts` implements `strict_complete`, `prorate_if_min_met`, `sum_available_only` and `no_score`; a score resting on fewer than the expected items is flagged `methodologicallyProvisional` and always carries `itemsMissing`; a non-computable score stores a reason (`derived_score` CHECK requires `not_computable_reason` unless `computability = 'computed'`). |
| Present a clinical band without permission | `lib/domain/scoring.ts`: a `clinical_elevation` scale of an instrument version without `clinicalUsePermitted` never yields a band; `instrument_version.is_provisional` and `clinical_use_permitted` are surfaced in the UI and enforced by the scorer. |
| Put identity data into an external form | `lib/domain/mapping.ts` rejects `participant_attribute` mappings whose attribute looks like identity data (`identity_attribute_not_permitted`); the task contract's `permissions.forbiddenScopes` lists `participant_private_identity`; identity data lives only in `participant_private_identity`. |
| Submit anything externally without an approved, evidenced path | `lib/domain/mapping.ts` `PLATFORM_SUBMISSION_PATH_VERIFIED = false` and `submissionAllowedByPlatform = false`; `buildTaskContract()` sets `permissions.maySubmitExternalResponse` only from `preflight.authorization.submissionAllowedByPlatform`; both adapters refuse instead of reporting success (see section 7). |
| Rewrite history | Triggers `trg_observed_answer_no_update`, `trg_observed_answer_no_delete`, `trg_derived_score_guard_update`, `trg_derived_score_no_delete`, `trg_audit_event_no_update`, `trg_audit_event_no_delete`; corrections create a new session revision or a superseding score row. |
| Store identity data without a lawful basis | Trigger `trg_private_identity_requires_basis` rejects a `participant_private_identity` row with an empty `lawful_basis`. |
| Put identity data in an analytic export | `export_job` CHECK: `contains_identity = 1` is only allowed when `scope = 'identity_restricted'`; `approveExport()` additionally requires the identity flag for that scope. |
| Let an agent exceed its grant | `agent_capability` rows are explicit and revocable; `AgentTaskContract.permissions` is generated per task, never inherited; `validateContract()` rejects credential keys and contract fields that exceed the pattern. |
| Retry a non-retryable outcome past its budget | `lib/domain/task-flow.ts` `retryPolicy()` (base 15 s, factor 2, cap 900 s) and `canTransition()`, which denies requeue at `attemptCount >= maxAttempts`; `agent_task.max_attempts` defaults to 3. |

## 2. How missing data is represented

Missing data is a first-class, documented state at three layers.

Storage layer:

- `observed_answer.is_missing = 1` requires `missing_reason` and forbids
  `value_numeric` and `value_coded`; `is_missing = 0` requires at least one of
  those two value columns. There is no state in which a row is "empty but
  present".
- `missing_reason` is restricted to `not_answered`, `skipped_by_branching`,
  `refused`, `illegible`, `not_administered`, `out_of_range_rejected`,
  `item_removed_in_version`. The reason is stored, not inferred later.
- `raw_value_text` is always kept verbatim; the numeric and coded columns are
  separate interpretations of it.
- `participant.attribute_missingness_json` records which analytic attributes the
  source document omits, per participant.
- `derived_score.computability` is `computed` or `not_computable`; the latter
  requires `not_computable_reason`.

Domain layer:

- Scoring treats an out-of-range or non-numeric value as missing, excludes
  `open_text` items with an explicit diagnostic, and reports
  `itemsUsed`/`itemsMissing`/`itemsExpected` plus the exact `sourceItemIds`.
- Cohort evaluation returns `indeterminate` with an observed/expected explanation
  instead of a silent include or exclude, and the preview reports per-rule
  counts plus a missingness summary.
- Mapping preflight distinguishes "the mapping reference is broken" (always a
  failure) from "the source is documented as missing" (fail when the target field
  is required, warn and omit the key when it is optional).

Presentation layer:

- A preflight payload contains only keys that resolve from a documented source or
  from a researcher-declared `fixed_constant`; every key carries its provenance in
  an `info` issue on the field entry. Failing fields contribute nothing.
- The Overview page shows a "Missing responses" metric with the hint "preserved
  as missing, never filled" and raises a warning when any response is missing.

## 3. How consent gates export and submission

Consent is recorded, versioned and evidence-linked:

- `consent_record` stores `consent_version`, `status` (`granted`, `declined`,
  `withdrawn`, `expired`), `basis` (`written_signed`, `digital_form`,
  `verbal_witnessed`, `guardian_proxy`, `institutional_blanket`), `scope_json`,
  `granted_at`, `withdrawn_at`, `expires_at` and `evidence_source_id` pointing at
  the document that proves consent. `UNIQUE (participant_id, study_id,
  consent_version)` keeps the history unambiguous.
- `lib/services/authz.ts` `requireActiveConsent()` is the check used by flows that
  need an active grant.
- Import: `lib/import/plan.ts` refuses to build a committable plan unless the
  operator declares consent and describes the evidence
  (`import.consent_not_declared`, `import.consent_evidence_missing`); the
  declaration is written with the import and recorded in the `import.commit`
  audit event. `commitImportPlan` is the only write path, and
  `requireCommittingPlan()` rejects a plan with blockers.
- Form mapping: `buildPreflight()` fails when consent is not on file (status not
  granted, or `withdrawnAt` set), leaves the payload empty in that case, and
  records the blocking reason plus `authorization.submissionBlockedReason`.
- Task execution: `permissions.maySubmitExternalResponse` is only true when the
  preflight authorized it; `validateContract()` rejects a contract that claims
  submission permission while `callback.mode` is `none`.
- Export: an export job moves `pending -> approved -> completed` with
  `approved_by`/`approved_at` recorded, `output_sha256` computed from the produced
  content, and a `denial_reason` when it is cancelled. Identity-bearing exports
  need the `identity_restricted` scope and the identity flag.

## 4. How instrument versions freeze

- `instrument_version.frozen_at` records the moment a version became immutable.
- Trigger `trg_instrument_version_frozen_items` aborts any change to
  `text_verbatim`, `response_type`, `options_json`, `reverse_scored` or
  `item_code` once at least one `observed_answer` exists for that version. The
  wording shown to a participant can therefore never be edited after the fact.
- Changes are made by creating a new version: `instrument_version.supersedes_id`
  links the replacement, and `UNIQUE (instrument_id, version_label, language)`
  keeps labels apart.
- Scoring algorithms are versioned rows (`score_algorithm`, unique per
  instrument version, scale and `algorithm_version`) and executed by a pure
  function, so any stored score can be re-derived from its declared version.
- Stored scores are immutable in their numeric and provenance columns
  (`trg_derived_score_guard_update`) and cannot be deleted
  (`trg_derived_score_no_delete`); a recomputation writes a new row and points
  `superseded_by_id` at the replacement.

## 5. Restricted item text and instrument rights

- Every instrument declares `rights_status`: `public_domain`, `open_access`,
  `licensed_local`, `permission_pending` or `restricted_no_redistribution`.
- `createInstrument()` enforces that an instrument which is neither public domain
  nor open access must name its license holder or rights contact, otherwise it
  throws `instrument.missing_license_holder`. `rights_note` and `license_holder`
  are stored beside the status.
- Item-level `rights_note` exists on `item_definition` for wording that carries
  its own restriction or attribution requirement.
- Item wording stays inside the platform. `text_verbatim` is read only by
  instrument administration, the item list and the session detail view
  (`lib/repo/assessments.ts`); no export path selects it. The export layer that
  exists today (`lib/repo/exports.ts`) performs job bookkeeping, approval,
  checksum recording and retention assessment - there is no dataset/export
  content generator on disk, so restricted wording cannot currently leave the
  platform through this codebase.
- Requirement for future export code: an export must exclude item wording by
  default, must refuse to include wording whose `rights_status` is
  `licensed_local`, `permission_pending` or `restricted_no_redistribution`
  unless an operator with `export:approve` explicitly authorizes that inclusion,
  and the decision must be captured in the export job record and the audit log.
- External form payloads never carry item wording either: a mapping resolves a
  value (an answer, a score, an attribute or a declared constant), never the
  question text, and `permissions.forbiddenScopes` excludes identity records.

## 6. Clinical and interpretive guardrails

- `instrument.is_clinical` and `requires_supervision` mark instruments that need
  supervision; `instrument_version.clinical_use_permitted` is the gate the scorer
  reads. Without it, a `clinical_elevation` scale produces diagnostics and no
  band.
- `instrument_version.is_provisional` and `limitations` carry the methodological
  caveats; scores computed under a provisional instrument or from a partial item
  set are flagged `methodologicallyProvisional`.
- Interpretive text is human-authored only: `interpretation_annotation` rows are
  written through `addAnnotation()` with an author, a type and an optional
  confidence; no module generates interpretation text.
- Display rounding is `roundForDisplay(..., 4)`; stored numbers keep full
  precision so a rounded value is never the source of truth.

## 7. Agent execution integrity

- Contracts are pseudonymous: `participantPseudonym` plus the documented values
  that were explicitly permitted. `validateContract()` rejects any key named
  `fullName`/`contactEmail`/`contactPhone` (case- and separator-insensitive)
  anywhere in the contract, any key named `token`, `secret`, `password` or
  `apiKey`, a pseudonym that looks like an e-mail address, a missing
  `idempotencyKey`, an `expiresAt` in the past relative to the injected clock,
  submission permission with `callback.mode = "none"`, and a required field
  mapped without a documented source.
- Secrets are references only. `agent.auth_secret_ref` stores an environment
  variable name; `GOOGLE_FORMS_SECRET_REF` is a name constant; the Google Forms
  adapter's transport receives no credential and transport error text is redacted
  (`redactSecrets()`) before it is stored as evidence.
- Idempotency: `buildIdempotencyKey()` is a deterministic SHA-256 over study,
  participant, external form version, task kind and contract version;
  `idx_agent_task_idempotency` enforces uniqueness; a repeat request returns the
  existing task and records `task.create.idempotent_replay`.
- Evidence: `execution_evidence.body_json` is stored with a SHA-256 over its
  canonical form; `task_attempt` rows are unique per attempt number.
- No adapter performs a network call. `local-deterministic` never contacts the
  network: `preflight` produces a `dry_run_report`, `execute` produces a
  `payload_snapshot` with `externalReceipt.channel = "none"`, and
  `submit_external_response` and `verify_submission` return `needs_review` with
  `blockedByPolicy: true`. `google-forms` never calls `fetch`: it refuses
  submission when `api_can_submit_responses` is false, when no credential
  reference is configured, or when no authorized transport is injected, and it
  delegates to an injected `submit` callback if and only if all gates pass.
  `ADAPTER_REGISTRY` throws `adapter.config_required` for the Google Forms
  adapter without an explicit capability config, so capabilities are never
  guessed.

## 8. Documented Google Forms capability limitation

Verified against the provider documentation as recorded in
`lib/repo/forms.ts` (`GOOGLE_FORMS_CAPABILITY_NOTE`):

- The Google Forms API can read form structure.
- With the responses scope it can read submitted responses of a form the caller
  owns.
- It does not expose a supported endpoint for creating a response on behalf of a
  respondent.

Consequences in this codebase: `external_form.api_can_submit_responses` defaults
to 0 with `capability_evidence` recorded; `PLATFORM_SUBMISSION_PATH_VERIFIED` is
false; a preflight still produces a dry-run payload for researcher review and
records the blocking reason; nothing in the platform claims a submission
happened. External submission stays disabled until an authorized, evidenced path
is configured.

## 9. Honest limitations

1. No external submission path exists. `submissionAllowedByPlatform` is always
   false; `maySubmitExternalResponse` is therefore always false in practice.
2. No Google Forms integration code exists: capability flags are stored facts
   only, and no OAuth client, HTTP client or response reader is implemented.
3. Export content generation is not implemented. `export_job` bookkeeping,
   approval, checksum recording and retention assessment exist; nothing writes an
   export file yet.
4. Retention is reported, never executed. `assessRetention()` returns candidate
   counts and a proposed action; anonymisation and deletion require a human step
   that is not implemented.
5. Consent is not enforced by a database trigger. A direct SQL write could store
   a consent record or an export row that bypasses application checks.
6. `DELETE` is still possible on entities without a no-delete trigger
   (`participant`, `consent_record`, `documented_source`, `agent_task`, and
   others). Append-only protection covers observed answers, derived scores and
   audit events only.
7. Several UI sections are still being built. The navigation declares nine
   sections (Overview, Studies, Participants, Psychological Library, Cohorts,
   Forms & Mappings, Agents & Tasks, Audit & Exports, Settings); only the pages
   present on disk can render. `docs/SETUP.md` and `README.md` record which ones
   exist as of the observation timestamp in the status table.
8. Clinical interpretation is out of scope. The platform can compute and label a
   score, but it does not diagnose, and it refuses to present a clinical band
   without `clinical_use_permitted`.
9. Scoring coverage depends on the imported data. Cohort and score results are
   only as complete as the documented sources; missingness is reported, never
   repaired.
10. No multi-tenant isolation beyond the organization foreign keys and the
    authorization layer; the application is designed for a single research
    organization per deployment.
11. The HTTP surface is limited to `/api/health`; research data is not exposed
    through a REST API.
12. Autosave/idempotent import replay across concurrent operators is not covered
    by a lock beyond SQLite transactions and `busy_timeout`.

## 10. Verification log

Observation timestamp: 2026-10-10 15:51 +05:00 (Asia/Tashkent), on Node
v24.21.0, pnpm 11.7.0, Windows. The repository was under active construction by
other workstreams while this document was written; pages, lint findings and test
counts changed during the session (the counts below are the last observed state),
so re-run the commands to confirm the current state.

| Command | Observed result |
| --- | --- |
| `nodejs --experimental-strip-types --test tests/unit/*.test.ts tests/integration/*.test.ts` | 165 tests, 154 pass, 11 fail. All 11 failures are in `tests/integration/pipeline.test.ts`, which aborts with `SQLITE_CONSTRAINT_CHECK: missing_reason IS NULL OR missing_reason IN (...)` when it writes an answer whose `missing_reason` is outside the seven documented values. The constraint is enforcing invariant 3; the caller is wrong, not the schema. |
| `nodejs ./node_modules/typescript/bin/tsc --noEmit` | exit 0, no diagnostics. |
| `nodejs ./node_modules/next/dist/bin/next build` | exit 0 on the most recent successful run (14 routes). An earlier build failed while `lib/services/preflight-context.ts` was still being written; that file now exists. |
| `nodejs ./node_modules/eslint/bin/eslint.js .` | 8 errors, 0 warnings (exit 1): unused bindings in `app/cohorts/page.tsx:22`, `app/library/page.tsx:19`, `lib/services/orchestration.ts:38` and `:366`, `tests/integration/pipeline.test.ts:56`; unnecessary regex escapes in `lib/import/plan.ts:48` and `:425`. |
| `nodejs --experimental-strip-types --test tests/http/smoke.test.ts` | 9 tests, 8 pass, 1 fail: `/forms -> 404` against a build that predates the `/forms` page. |
| `pnpm run lint` / `pnpm run typecheck` | Fails in this environment before running the script: the pnpm dependency check aborts with `ERR_PNPM_IGNORED_BUILDS` for `better-sqlite3@13.0.3`. Use the direct `nodejs` commands above, or approve the build script (see `docs/SETUP.md`). |

The complete-data path (participant -> session -> answers -> scores -> cohort ->
mapping -> task) is covered by the domain unit tests, and schema application plus
the integrity triggers are covered by `tests/integration/migrations.test.ts`,
which passes. The newer `tests/integration/pipeline.test.ts` exercises the same
path end to end and currently fails on the `missing_reason` constraint, which is
documented above rather than hidden.

Note: the platform's refusals were exercised by the tests that pass - for example
the append-only triggers reject UPDATE and DELETE, consent status gates
eligibility as `indeterminate`, and the mapping preflight keeps a documented
missing source out of the payload while still producing a dry-run report.
