-- ============================================================================
-- Migration 0004: import drafts
-- ============================================================================
-- A documented import happens in two steps: the operator uploads an export and
-- reviews a plan; only then is the plan committed. The uploaded bytes and the
-- reviewed plan are held here between the two steps, with an expiry so an
-- abandoned upload does not linger.

CREATE TABLE IF NOT EXISTS import_draft (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  study_id          TEXT REFERENCES study(id) ON DELETE SET NULL,
  instrument_version_id TEXT NOT NULL REFERENCES instrument_version(id) ON DELETE CASCADE,
  file_name         TEXT NOT NULL,
  file_sha256       TEXT NOT NULL,
  file_bytes        BLOB NOT NULL,
  sheet_name        TEXT,
  plan_json         TEXT NOT NULL,
  options_json      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned', 'committed', 'discarded')),
  created_by        TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  committed_at      TEXT,
  documented_source_id TEXT REFERENCES documented_source(id) ON DELETE SET NULL,
  commit_summary_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_draft_status ON import_draft(status, expires_at);
