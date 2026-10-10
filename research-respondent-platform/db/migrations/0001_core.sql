-- ============================================================================
-- Migration 0001: core research schema
-- ============================================================================
-- Design rules enforced by this schema (research-integrity invariants):
--   1. Every observed answer carries participant, instrument version, item
--      identity, collection timestamp, source document and raw value as typed
--      separately from its numeric coding. NULL means "not answered".
--   2. Every derived score carries the algorithm version and the exact set of
--      source answers used; scores are never updated in place without a new
--      version row (write-once semantics enforced by triggers in 0002).
--   3. Identity/contact data lives only in `participant_private_identity`,
--      reachable solely through an explicit access-grant check in application
--      code. Analytic tables never embed e-mail addresses or names.
--   4. External form submissions require an approved task with an idempotency
--      key; duplicates are rejected by a unique index.
--   5. Nothing in this schema fabricates values: every nullable analytic column
--      is a documented "missing" state, not a default.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity --

CREATE TABLE IF NOT EXISTS organization (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  created_at        TEXT NOT NULL,
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS app_user (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  email             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  password_salt     TEXT NOT NULL,
  password_params   TEXT NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at        TEXT NOT NULL,
  last_login_at     TEXT
);

CREATE TABLE IF NOT EXISTS role_assignment (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN (
                      'admin',                 -- full control incl. users, settings
                      'principal_investigator',-- study ownership, approvals
                      'researcher',            -- create/edit research data
                      'data_steward',          -- identity + consent + retention
                      'reviewer',              -- approve tasks, review exceptions
                      'agent_operator',        -- run/queue agent tasks
                      'viewer'                 -- read-only, no private identity
                    )),
  study_id          TEXT REFERENCES study(id) ON DELETE CASCADE,
  granted_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  granted_at        TEXT NOT NULL,
  revoked_at        TEXT,
  CHECK (study_id IS NOT NULL OR role IN ('admin', 'data_steward'))
);
CREATE INDEX IF NOT EXISTS idx_role_assignment_user ON role_assignment(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS access_grant (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  scope_type        TEXT NOT NULL CHECK (scope_type IN ('study', 'private_identity', 'export', 'integration')),
  scope_id          TEXT,
  permission        TEXT NOT NULL CHECK (permission IN ('read', 'write', 'approve', 'export')),
  granted_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  granted_at        TEXT NOT NULL,
  expires_at        TEXT,
  revoked_at        TEXT,
  reason            TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_grant_user ON access_grant(user_id, scope_type, revoked_at);

CREATE TABLE IF NOT EXISTS auth_session (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL UNIQUE,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT,
  user_agent        TEXT,
  ip_hint           TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_session_token ON auth_session(token_hash);

-- ----------------------------------------------------------------- studies --

CREATE TABLE IF NOT EXISTS study (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  code              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  research_question TEXT NOT NULL,
  principal_email   TEXT,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'active', 'paused', 'closed', 'archived')),
  created_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_org ON study(organization_id, status);

CREATE TABLE IF NOT EXISTS study_protocol_version (
  id                TEXT PRIMARY KEY,
  study_id          TEXT NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  version_label     TEXT NOT NULL,
  supersedes_id     TEXT REFERENCES study_protocol_version(id) ON DELETE SET NULL,
  effective_from    TEXT NOT NULL,
  design_summary    TEXT,
  inclusion_criteria TEXT,
  exclusion_criteria TEXT,
  ethical_approval  TEXT,
  consent_template  TEXT,
  data_access_notes TEXT,
  approved_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (study_id, version_label)
);
CREATE INDEX IF NOT EXISTS idx_protocol_study ON study_protocol_version(study_id, effective_from);

CREATE TABLE IF NOT EXISTS recruitment_criterion (
  id                TEXT PRIMARY KEY,
  study_id          TEXT NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  protocol_version_id TEXT REFERENCES study_protocol_version(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('inclusion', 'exclusion')),
  label             TEXT NOT NULL,
  -- machine-readable rule; evaluated by lib/domain/cohort.ts
  rule_json         TEXT NOT NULL,
  rationale         TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_criterion_study ON recruitment_criterion(study_id, kind);

CREATE TABLE IF NOT EXISTS study_participant (
  id                TEXT PRIMARY KEY,
  study_id          TEXT NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  participant_id    TEXT NOT NULL REFERENCES participant(id) ON DELETE RESTRICT,
  enrolled_at       TEXT NOT NULL,
  enrolment_source  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'enrolled'
                      CHECK (status IN ('invited', 'enrolled', 'active', 'completed', 'withdrawn', 'excluded')),
  withdrawn_at      TEXT,
  withdrawal_reason TEXT,
  UNIQUE (study_id, participant_id)
);
CREATE INDEX IF NOT EXISTS idx_study_participant ON study_participant(study_id, status);

-- ------------------------------------------------------------ participants --

CREATE TABLE IF NOT EXISTS participant (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  pseudonym         TEXT NOT NULL UNIQUE,
  -- Cohort-safe analytic attributes only. No names/e-mails/phones here.
  birth_year        INTEGER CHECK (birth_year IS NULL OR (birth_year BETWEEN 1900 AND 2100)),
  age_at_enrolment  INTEGER CHECK (age_at_enrolment IS NULL OR age_at_enrolment >= 0),
  self_described_gender TEXT,
  preferred_language TEXT,
  education_level   TEXT,
  region            TEXT,
  recruitment_channel TEXT,
  -- Explicit missing-data marker for attributes the source document omits.
  attribute_missingness_json TEXT NOT NULL DEFAULT '{}',
  notes             TEXT,
  created_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_participant_org ON participant(organization_id);

-- Separation of identity data from analytic data. Requires the
-- 'private_identity' access grant, and is never included in analytic exports.
CREATE TABLE IF NOT EXISTS participant_private_identity (
  participant_id    TEXT PRIMARY KEY REFERENCES participant(id) ON DELETE CASCADE,
  full_name         TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  contact_handle    TEXT,
  lawful_basis      TEXT,
  retention_until   TEXT,
  recorded_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  recorded_at       TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_private_identity_email
  ON participant_private_identity(contact_email) WHERE contact_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS consent_record (
  id                TEXT PRIMARY KEY,
  participant_id    TEXT NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  study_id          TEXT REFERENCES study(id) ON DELETE SET NULL,
  consent_version   TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('granted', 'declined', 'withdrawn', 'expired')),
  basis             TEXT NOT NULL CHECK (basis IN (
                      'written_signed', 'digital_form', 'verbal_witnessed',
                      'guardian_proxy', 'institutional_blanket')),
  granted_at        TEXT,
  withdrawn_at      TEXT,
  expires_at        TEXT,
  scope_json        TEXT NOT NULL DEFAULT '[]',
  evidence_source_id TEXT REFERENCES documented_source(id) ON DELETE SET NULL,
  recorded_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  recorded_at       TEXT NOT NULL,
  notes             TEXT,
  UNIQUE (participant_id, study_id, consent_version)
);
CREATE INDEX IF NOT EXISTS idx_consent_participant ON consent_record(participant_id, status);

-- ------------------------------------------------------------- provenance --

CREATE TABLE IF NOT EXISTS documented_source (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  origin_type       TEXT NOT NULL CHECK (origin_type IN (
                      'google_form_export', 'spreadsheet', 'spss_dataset', 'csv_export',
                      'paper_form', 'interview_transcript', 'observation_log',
                      'external_api', 'manual_entry_signed', 'instrument_report')),
  title             TEXT NOT NULL,
  reference         TEXT NOT NULL,          -- file name, URL, archive location
  location          TEXT,                   -- path or storage reference
  collected_from    TEXT,                   -- who/where collected, non-identifying
  collected_at      TEXT,                   -- documented collection period
  received_at       TEXT NOT NULL,
  content_sha256    TEXT,
  row_count         INTEGER,
  integrity_notes   TEXT,
  recorded_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documented_source_org ON documented_source(organization_id, origin_type);

CREATE TABLE IF NOT EXISTS evidence_link (
  id                TEXT PRIMARY KEY,
  documented_source_id TEXT NOT NULL REFERENCES documented_source(id) ON DELETE CASCADE,
  entity_type       TEXT NOT NULL CHECK (entity_type IN (
                      'participant', 'assessment_session', 'observed_answer',
                      'derived_score', 'consent_record', 'eligibility_decision', 'manual_entry')),
  entity_id         TEXT NOT NULL,
  locator           TEXT,                   -- sheet/row/column/timestamp in the source
  note              TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_link_entity ON evidence_link(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_evidence_link_source ON evidence_link(documented_source_id);

-- ------------------------------------------------------------ instruments --

CREATE TABLE IF NOT EXISTS instrument (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT REFERENCES organization(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  abbreviation      TEXT,
  authors           TEXT,
  tradition         TEXT CHECK (tradition IS NULL OR tradition IN (
                      'big_five', 'sixteen_pf', 'temperament_strelau_pavlovian',
                      'temperament_strelau_regulative', 'temperament_other',
                      'clinical_mmpi_family', 'normal_range_mpq_family',
                      'self_regulation', 'tolerance_of_uncertainty',
                      'addiction_screening', 'cognitive_ability',
                      'psychosomatic', 'other')),
  construct_domains_json TEXT NOT NULL DEFAULT '[]',
  rights_status     TEXT NOT NULL CHECK (rights_status IN (
                      'public_domain', 'open_access', 'licensed_local',
                      'permission_pending', 'restricted_no_redistribution')),
  rights_note       TEXT,
  license_holder    TEXT,
  is_clinical       INTEGER NOT NULL DEFAULT 0 CHECK (is_clinical IN (0, 1)),
  requires_supervision INTEGER NOT NULL DEFAULT 0 CHECK (requires_supervision IN (0, 1)),
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instrument_version (
  id                TEXT PRIMARY KEY,
  instrument_id     TEXT NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  version_label     TEXT NOT NULL,
  language          TEXT NOT NULL,
  adaptation        TEXT,
  publication_year  TEXT,
  norm_reference    TEXT,
  response_format   TEXT,
  scoring_notes     TEXT,
  -- Methodological guardrails surfaced in the UI and enforced by the scorer.
  is_provisional    INTEGER NOT NULL DEFAULT 0 CHECK (is_provisional IN (0, 1)),
  clinical_use_permitted INTEGER NOT NULL DEFAULT 0 CHECK (clinical_use_permitted IN (0, 1)),
  limitations       TEXT,
  source_document_id TEXT REFERENCES documented_source(id) ON DELETE SET NULL,
  supersedes_id     TEXT REFERENCES instrument_version(id) ON DELETE SET NULL,
  frozen_at         TEXT,                   -- set when first answer recorded; blocks silent edits
  created_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (instrument_id, version_label, language)
);
CREATE INDEX IF NOT EXISTS idx_instrument_version ON instrument_version(instrument_id);

CREATE TABLE IF NOT EXISTS item_definition (
  id                TEXT PRIMARY KEY,
  instrument_version_id TEXT NOT NULL REFERENCES instrument_version(id) ON DELETE CASCADE,
  item_code         TEXT NOT NULL,          -- stable key, e.g. '01', 'SF1'
  order_index       INTEGER NOT NULL,
  text_verbatim     TEXT NOT NULL,
  text_language     TEXT NOT NULL,
  response_type     TEXT NOT NULL CHECK (response_type IN (
                      'likert', 'yes_no', 'multiple_choice', 'numeric', 'open_text', 'date', 'categorical')),
  options_json      TEXT NOT NULL DEFAULT '[]',
  min_value         REAL,
  max_value         REAL,
  required          INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  reverse_scored    INTEGER NOT NULL DEFAULT 0 CHECK (reverse_scored IN (0, 1)),
  section           TEXT,
  rights_note       TEXT,
  UNIQUE (instrument_version_id, item_code)
);
CREATE INDEX IF NOT EXISTS idx_item_definition_version ON item_definition(instrument_version_id, order_index);

CREATE TABLE IF NOT EXISTS scale_definition (
  id                TEXT PRIMARY KEY,
  instrument_version_id TEXT NOT NULL REFERENCES instrument_version(id) ON DELETE CASCADE,
  scale_code        TEXT NOT NULL,
  title             TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN (
                      'raw_sum', 'mean', 'weighted_sum', 'factor_score', 'clinical_elevation', 'index')),
  direction         TEXT NOT NULL DEFAULT 'higher_is_more'
                      CHECK (direction IN ('higher_is_more', 'higher_is_less', 'bipolar')),
  min_possible      REAL,
  max_possible      REAL,
  interpretation_bands_json TEXT NOT NULL DEFAULT '[]',
  norm_notes        TEXT,
  UNIQUE (instrument_version_id, scale_code)
);

-- Versioned scoring algorithm. `algorithm_json` is a declarative pipeline the
-- pure scorer in lib/domain/scoring.ts executes deterministically.
CREATE TABLE IF NOT EXISTS score_algorithm (
  id                TEXT PRIMARY KEY,
  instrument_version_id TEXT NOT NULL REFERENCES instrument_version(id) ON DELETE CASCADE,
  scale_definition_id TEXT REFERENCES scale_definition(id) ON DELETE CASCADE,
  algorithm_version TEXT NOT NULL,
  algorithm_json    TEXT NOT NULL,
  min_items_required INTEGER NOT NULL DEFAULT 1,
  missing_policy    TEXT NOT NULL DEFAULT 'prorate_if_min_met'
                      CHECK (missing_policy IN ('strict_complete', 'prorate_if_min_met', 'sum_available_only', 'no_score')),
  documentation     TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (instrument_version_id, scale_definition_id, algorithm_version)
);
CREATE INDEX IF NOT EXISTS idx_score_algorithm_version ON score_algorithm(instrument_version_id, is_active);

-- ------------------------------------------------------------ assessments --

CREATE TABLE IF NOT EXISTS assessment_session (
  id                TEXT PRIMARY KEY,
  study_id          TEXT REFERENCES study(id) ON DELETE SET NULL,
  participant_id    TEXT NOT NULL REFERENCES participant(id) ON DELETE RESTRICT,
  instrument_version_id TEXT NOT NULL REFERENCES instrument_version(id) ON DELETE RESTRICT,
  timepoint_label   TEXT NOT NULL,
  session_index     INTEGER NOT NULL DEFAULT 1,
  administration_mode TEXT NOT NULL CHECK (administration_mode IN (
                      'self_online', 'self_paper', 'interviewer_assisted',
                      'group_paper', 'imported_dataset', 'external_form')),
  language          TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  documented_source_id TEXT NOT NULL REFERENCES documented_source(id) ON DELETE RESTRICT,
  protocol_version_id TEXT REFERENCES study_protocol_version(id) ON DELETE SET NULL,
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  notes             TEXT,
  recorded_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (participant_id, instrument_version_id, timepoint_label)
);
CREATE INDEX IF NOT EXISTS idx_assessment_session_participant ON assessment_session(participant_id);
CREATE INDEX IF NOT EXISTS idx_assessment_session_study ON assessment_session(study_id);

-- Observed answers are append-only (see triggers in 0002).
CREATE TABLE IF NOT EXISTS observed_answer (
  id                TEXT PRIMARY KEY,
  assessment_session_id TEXT NOT NULL REFERENCES assessment_session(id) ON DELETE CASCADE,
  participant_id    TEXT NOT NULL REFERENCES participant(id) ON DELETE RESTRICT,
  item_definition_id TEXT NOT NULL REFERENCES item_definition(id) ON DELETE RESTRICT,
  item_code         TEXT NOT NULL,
  raw_value_text    TEXT NOT NULL,          -- exactly what the source document shows
  value_numeric     REAL,                   -- numeric coding when the item is numeric
  value_coded       TEXT,                   -- option code for categorical items
  is_missing        INTEGER NOT NULL DEFAULT 0 CHECK (is_missing IN (0, 1)),
  missing_reason    TEXT CHECK (missing_reason IS NULL OR missing_reason IN (
                      'not_answered', 'skipped_by_branching', 'refused', 'illegible',
                      'not_administered', 'out_of_range_rejected', 'item_removed_in_version')),
  response_latency_ms INTEGER,
  source_documented_source_id TEXT NOT NULL REFERENCES documented_source(id) ON DELETE RESTRICT,
  source_locator    TEXT NOT NULL,          -- sheet!row, column header, line number
  collected_at      TEXT,                   -- documented collection timestamp
  imported_at       TEXT NOT NULL,
  recorded_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  CHECK (
    (is_missing = 1 AND missing_reason IS NOT NULL AND value_numeric IS NULL AND value_coded IS NULL)
    OR
    (is_missing = 0 AND (value_numeric IS NOT NULL OR value_coded IS NOT NULL))
  ),
  UNIQUE (assessment_session_id, item_definition_id)
);
CREATE INDEX IF NOT EXISTS idx_observed_answer_item ON observed_answer(item_definition_id);
CREATE INDEX IF NOT EXISTS idx_observed_answer_session ON observed_answer(assessment_session_id);

CREATE TABLE IF NOT EXISTS derived_score (
  id                TEXT PRIMARY KEY,
  assessment_session_id TEXT NOT NULL REFERENCES assessment_session(id) ON DELETE CASCADE,
  participant_id    TEXT NOT NULL REFERENCES participant(id) ON DELETE RESTRICT,
  scale_definition_id TEXT NOT NULL REFERENCES scale_definition(id) ON DELETE RESTRICT,
  score_algorithm_id TEXT NOT NULL REFERENCES score_algorithm(id) ON DELETE RESTRICT,
  algorithm_version TEXT NOT NULL,
  raw_score         REAL,
  transformed_score REAL,
  standardized_score REAL,
  standard_error    REAL,
  percentile        REAL,
  items_used        INTEGER NOT NULL,
  items_missing     INTEGER NOT NULL,
  is_provisional    INTEGER NOT NULL DEFAULT 0 CHECK (is_provisional IN (0, 1)),
  computability     TEXT NOT NULL CHECK (computability IN ('computed', 'not_computable')),
  not_computable_reason TEXT,
  source_item_ids_json TEXT NOT NULL DEFAULT '[]',
  computed_at       TEXT NOT NULL,
  computed_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  superseded_by_id  TEXT REFERENCES derived_score(id) ON DELETE SET NULL,
  CHECK (computability = 'computed' OR not_computable_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_derived_score_participant ON derived_score(participant_id, scale_definition_id);
CREATE INDEX IF NOT EXISTS idx_derived_score_session ON derived_score(assessment_session_id);

CREATE TABLE IF NOT EXISTS interpretation_annotation (
  id                TEXT PRIMARY KEY,
  participant_id    TEXT NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  assessment_session_id TEXT REFERENCES assessment_session(id) ON DELETE CASCADE,
  derived_score_id  TEXT REFERENCES derived_score(id) ON DELETE SET NULL,
  annotation_type   TEXT NOT NULL CHECK (annotation_type IN (
                      'assessor_note', 'hypothesis', 'limitation', 'norm_caution',
                      'clinical_flag', 'follow_up_required')),
  body              TEXT NOT NULL,
  confidence        TEXT CHECK (confidence IS NULL OR confidence IN ('low', 'moderate', 'high')),
  author_user_id    TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL
);

-- --------------------------------------------------------------- segments --

CREATE TABLE IF NOT EXISTS segment (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  study_id          TEXT REFERENCES study(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  created_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (organization_id, study_id, name)
);

CREATE TABLE IF NOT EXISTS segment_rule (
  id                TEXT PRIMARY KEY,
  segment_id        TEXT NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  order_index       INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('include', 'exclude')),
  rule_json         TEXT NOT NULL,
  label             TEXT NOT NULL,
  UNIQUE (segment_id, order_index)
);

CREATE TABLE IF NOT EXISTS segment_snapshot (
  id                TEXT PRIMARY KEY,
  segment_id        TEXT NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  revision          INTEGER NOT NULL,
  rules_sha256      TEXT NOT NULL,
  evaluated_at      TEXT NOT NULL,
  denominator       INTEGER NOT NULL,
  included_count    INTEGER NOT NULL,
  excluded_count    INTEGER NOT NULL,
  indeterminate_count INTEGER NOT NULL,
  result_json       TEXT NOT NULL,
  evaluated_by      TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  UNIQUE (segment_id, revision)
);

CREATE TABLE IF NOT EXISTS eligibility_decision (
  id                TEXT PRIMARY KEY,
  study_id          TEXT NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  participant_id    TEXT NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  segment_snapshot_id TEXT REFERENCES segment_snapshot(id) ON DELETE SET NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('eligible', 'ineligible', 'indeterminate')),
  explanation_json  TEXT NOT NULL,
  decided_at        TEXT NOT NULL,
  decided_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_eligibility_study ON eligibility_decision(study_id, decision);

-- ----------------------------------------------------------- external forms --

CREATE TABLE IF NOT EXISTS external_form (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider          TEXT NOT NULL CHECK (provider IN ('google_forms', 'microsoft_forms', 'limesurvey', 'other')),
  external_id       TEXT NOT NULL,
  title             TEXT NOT NULL,
  edit_url          TEXT,
  responder_url     TEXT,
  owner_account     TEXT,
  -- Documented capability facts, verified against provider documentation.
  api_can_read_structure INTEGER NOT NULL DEFAULT 0 CHECK (api_can_read_structure IN (0, 1)),
  api_can_read_responses INTEGER NOT NULL DEFAULT 0 CHECK (api_can_read_responses IN (0, 1)),
  api_can_submit_responses INTEGER NOT NULL DEFAULT 0 CHECK (api_can_submit_responses IN (0, 1)),
  capability_evidence TEXT,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_form_provider ON external_form(provider, external_id);

CREATE TABLE IF NOT EXISTS external_form_version (
  id                TEXT PRIMARY KEY,
  external_form_id  TEXT NOT NULL REFERENCES external_form(id) ON DELETE CASCADE,
  version_label     TEXT NOT NULL,
  revision_id       TEXT,
  captured_at       TEXT NOT NULL,
  structure_sha256  TEXT NOT NULL,
  captured_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  supersedes_id     TEXT REFERENCES external_form_version(id) ON DELETE SET NULL,
  source_document_id TEXT REFERENCES documented_source(id) ON DELETE SET NULL,
  UNIQUE (external_form_id, version_label)
);

CREATE TABLE IF NOT EXISTS external_form_field (
  id                TEXT PRIMARY KEY,
  external_form_version_id TEXT NOT NULL REFERENCES external_form_version(id) ON DELETE CASCADE,
  field_id          TEXT NOT NULL,          -- provider question id
  order_index       INTEGER NOT NULL,
  title             TEXT NOT NULL,
  field_type        TEXT NOT NULL CHECK (field_type IN (
                      'short_text', 'paragraph', 'multiple_choice', 'checkbox',
                      'dropdown', 'linear_scale', 'date', 'time', 'grid', 'file_upload',
                      'section_header', 'unknown')),
  is_required       INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
  options_json      TEXT NOT NULL DEFAULT '[]',
  section           TEXT,
  raw_json          TEXT,
  UNIQUE (external_form_version_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_external_field_version ON external_form_field(external_form_version_id, order_index);

CREATE TABLE IF NOT EXISTS field_mapping (
  id                TEXT PRIMARY KEY,
  study_id          TEXT NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  external_form_version_id TEXT NOT NULL REFERENCES external_form_version(id) ON DELETE CASCADE,
  external_form_field_id TEXT NOT NULL REFERENCES external_form_field(id) ON DELETE CASCADE,
  mapping_kind      TEXT NOT NULL CHECK (mapping_kind IN (
                      'observed_answer',       -- verbatim existing participant answer
                      'derived_score',         -- validated scale score
                      'participant_attribute', -- documented, non-identifying attribute
                      'fixed_constant',        -- study-level constant, declared by researcher
                      'unmapped')),
  source_ref_json   TEXT NOT NULL DEFAULT '{}',
  value_transform   TEXT NOT NULL DEFAULT 'verbatim'
                      CHECK (value_transform IN ('verbatim', 'option_label', 'option_index', 'numeric_round', 'date_iso')),
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'validated', 'rejected', 'stale')),
  validation_json   TEXT NOT NULL DEFAULT '{}',
  rationale         TEXT,
  created_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (study_id, external_form_version_id, external_form_field_id)
);
CREATE INDEX IF NOT EXISTS idx_field_mapping_form ON field_mapping(external_form_version_id, status);

CREATE TABLE IF NOT EXISTS mapping_validation (
  id                TEXT PRIMARY KEY,
  field_mapping_id  TEXT NOT NULL REFERENCES field_mapping(id) ON DELETE CASCADE,
  run_at            TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('pass', 'warn', 'fail')),
  issues_json       TEXT NOT NULL DEFAULT '[]',
  checked_count     INTEGER NOT NULL DEFAULT 0,
  run_by            TEXT REFERENCES app_user(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mapping_validation_mapping ON mapping_validation(field_mapping_id, run_at);

-- ----------------------------------------------------------------- agents --

CREATE TABLE IF NOT EXISTS agent (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  provider          TEXT NOT NULL CHECK (provider IN (
                      'deepseek', 'openai', 'anthropic', 'google', 'local_deterministic',
                      'human_operator', 'mcp_generic', 'other')),
  kind              TEXT NOT NULL CHECK (kind IN ('ai', 'human', 'service')),
  endpoint          TEXT,
  auth_secret_ref   TEXT,                    -- name of env var / secret store key, never the secret
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  contact           TEXT,
  registered_by     TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS agent_capability (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  capability        TEXT NOT NULL CHECK (capability IN (
                      'read_field_map', 'read_permitted_answers', 'preflight_only',
                      'submit_external_response', 'attach_execution_evidence',
                      'request_human_review')),
  scope_json        TEXT NOT NULL DEFAULT '{}',
  max_submissions_per_day INTEGER,
  granted_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  granted_at        TEXT NOT NULL,
  revoked_at        TEXT,
  UNIQUE (agent_id, capability)
);

CREATE TABLE IF NOT EXISTS agent_task (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  study_id          TEXT NOT NULL REFERENCES study(id) ON DELETE RESTRICT,
  participant_id    TEXT NOT NULL REFERENCES participant(id) ON DELETE RESTRICT,
  external_form_version_id TEXT REFERENCES external_form_version(id) ON DELETE RESTRICT,
  assigned_agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN (
                      'preflight_mapping', 'compose_form_payload', 'submit_external_response',
                      'verify_submission', 'collect_documented_answers')),
  state             TEXT NOT NULL DEFAULT 'draft' CHECK (state IN (
                      'draft', 'validated', 'approved', 'queued', 'running',
                      'succeeded', 'failed', 'needs_review', 'cancelled', 'expired')),
  contract_json     TEXT NOT NULL,
  contract_sha256   TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 100,
  requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0, 1)),
  approved_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at       TEXT,
  approval_note     TEXT,
  queued_at         TEXT,
  started_at        TEXT,
  finished_at       TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  expires_at        TEXT,
  last_error        TEXT,
  created_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
-- Idempotency: one live task per (study, participant, form version, kind).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_idempotency
  ON agent_task(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_agent_task_state ON agent_task(state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_task_study ON agent_task(study_id, state);

CREATE TABLE IF NOT EXISTS task_attempt (
  id                TEXT PRIMARY KEY,
  agent_task_id     TEXT NOT NULL REFERENCES agent_task(id) ON DELETE CASCADE,
  attempt_number    INTEGER NOT NULL,
  state_from        TEXT NOT NULL,
  state_to          TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  adapter           TEXT NOT NULL,
  request_json      TEXT NOT NULL,
  response_json     TEXT,
  error_code        TEXT,
  error_message     TEXT,
  retryable         INTEGER,
  UNIQUE (agent_task_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_task_attempt_task ON task_attempt(agent_task_id);

CREATE TABLE IF NOT EXISTS execution_evidence (
  id                TEXT PRIMARY KEY,
  agent_task_id     TEXT NOT NULL REFERENCES agent_task(id) ON DELETE CASCADE,
  task_attempt_id   TEXT REFERENCES task_attempt(id) ON DELETE CASCADE,
  evidence_type     TEXT NOT NULL CHECK (evidence_type IN (
                      'dry_run_report', 'payload_snapshot', 'external_receipt',
                      'screenshot_reference', 'human_attestation', 'validation_report',
                      'error_trace')),
  body_json         TEXT NOT NULL,
  body_sha256       TEXT NOT NULL,
  recorded_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_evidence_task ON execution_evidence(agent_task_id);

-- ------------------------------------------------------ audit and exports --

-- Append-only. Triggers in migration 0002 reject UPDATE and DELETE.
CREATE TABLE IF NOT EXISTS audit_event (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  occurred_at       TEXT NOT NULL,
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id          TEXT,
  actor_label       TEXT NOT NULL,
  action            TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  entity_id         TEXT,
  study_id          TEXT,
  participant_id    TEXT,
  outcome           TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied', 'partial')),
  severity          TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'notice', 'warning', 'critical')),
  detail_json       TEXT NOT NULL DEFAULT '{}',
  request_id        TEXT,
  ip_hint           TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_event_time ON audit_event(occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_event_entity ON audit_event(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_study ON audit_event(study_id, occurred_at);

CREATE TABLE IF NOT EXISTS export_job (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  study_id          TEXT REFERENCES study(id) ON DELETE SET NULL,
  segment_snapshot_id TEXT REFERENCES segment_snapshot(id) ON DELETE SET NULL,
  format            TEXT NOT NULL CHECK (format IN ('csv', 'json', 'jsonl')),
  scope             TEXT NOT NULL CHECK (scope IN (
                      'analytic_deidentified', 'provenance_audit', 'cohort_manifest',
                      'task_execution_report', 'identity_restricted')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'running', 'completed', 'failed', 'cancelled')),
  requested_by      TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by       TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at       TEXT,
  requested_at      TEXT NOT NULL,
  completed_at      TEXT,
  row_count         INTEGER,
  filters_json      TEXT NOT NULL DEFAULT '{}',
  output_sha256     TEXT,
  output_path       TEXT,
  contains_identity INTEGER NOT NULL DEFAULT 0 CHECK (contains_identity IN (0, 1)),
  denial_reason     TEXT,
  CHECK (contains_identity = 0 OR scope = 'identity_restricted')
);
CREATE INDEX IF NOT EXISTS idx_export_job_org ON export_job(organization_id, status);

CREATE TABLE IF NOT EXISTS retention_policy (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  entity_type       TEXT NOT NULL CHECK (entity_type IN (
                      'participant_private_identity', 'observed_answer', 'audit_event',
                      'export_job', 'execution_evidence', 'documented_source')),
  retention_months  INTEGER,
  action_on_expiry  TEXT NOT NULL CHECK (action_on_expiry IN ('anonymize', 'delete', 'review')),
  lawful_basis      TEXT,
  updated_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (organization_id, entity_type)
);

CREATE TABLE IF NOT EXISTS system_setting (
  key               TEXT PRIMARY KEY,
  value_json        TEXT NOT NULL,
  updated_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at        TEXT NOT NULL
);

-- ----------------------------------------------------- schema bookkeeping --

CREATE TABLE IF NOT EXISTS schema_migration (
  id                TEXT PRIMARY KEY,
  applied_at        TEXT NOT NULL,
  checksum          TEXT NOT NULL,
  duration_ms       INTEGER NOT NULL,
  applied_by        TEXT NOT NULL
);
