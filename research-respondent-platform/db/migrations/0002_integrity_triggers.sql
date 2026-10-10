-- ============================================================================
-- Migration 0002: integrity triggers
-- ============================================================================
-- These triggers enforce append-only and provenance rules at the storage layer
-- so that a bug in application code cannot silently rewrite research history.
-- ============================================================================

-- --- observed answers are write-once ---------------------------------------
DROP TRIGGER IF EXISTS trg_observed_answer_no_update;
CREATE TRIGGER trg_observed_answer_no_update
BEFORE UPDATE ON observed_answer
BEGIN
  SELECT RAISE(ABORT,
    'observed_answer rows are append-only: record a corrected answer in a new assessment session revision instead of mutating history');
END;

DROP TRIGGER IF EXISTS trg_observed_answer_no_delete;
CREATE TRIGGER trg_observed_answer_no_delete
BEFORE DELETE ON observed_answer
BEGIN
  SELECT RAISE(ABORT,
    'observed_answer rows cannot be deleted; withdraw the whole assessment session with an audit event instead');
END;

-- --- derived scores keep history ------------------------------------------
-- Only the `superseded_by_id` pointer and annotation of provisionality may be
-- changed; the numeric result and the item provenance are immutable.
DROP TRIGGER IF EXISTS trg_derived_score_guard_update;
CREATE TRIGGER trg_derived_score_guard_update
BEFORE UPDATE ON derived_score
BEGIN
  SELECT CASE
    WHEN OLD.raw_score IS NOT NEW.raw_score
      OR OLD.transformed_score IS NOT NEW.transformed_score
      OR OLD.standardized_score IS NOT NEW.standardized_score
      OR OLD.percentile IS NOT NEW.percentile
      OR OLD.items_used IS NOT NEW.items_used
      OR OLD.items_missing IS NOT NEW.items_missing
      OR OLD.algorithm_version IS NOT NEW.algorithm_version
      OR OLD.scale_definition_id IS NOT NEW.scale_definition_id
      OR OLD.assessment_session_id IS NOT NEW.assessment_session_id
      OR OLD.source_item_ids_json IS NOT NEW.source_item_ids_json
      OR OLD.computability IS NOT NEW.computability
    THEN RAISE(ABORT,
      'derived_score results are immutable: write a new score row and set superseded_by_id to preserve the audit trail')
  END;
END;

DROP TRIGGER IF EXISTS trg_derived_score_no_delete;
CREATE TRIGGER trg_derived_score_no_delete
BEFORE DELETE ON derived_score
BEGIN
  SELECT RAISE(ABORT, 'derived_score rows cannot be deleted; supersede them instead');
END;

-- --- audit events are immutable -------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_event_no_update;
CREATE TRIGGER trg_audit_event_no_update
BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only and cannot be updated');
END;

DROP TRIGGER IF EXISTS trg_audit_event_no_delete;
CREATE TRIGGER trg_audit_event_no_delete
BEFORE DELETE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only and cannot be deleted');
END;

-- --- identity records are sensitive ---------------------------------------
DROP TRIGGER IF EXISTS trg_private_identity_requires_basis;
CREATE TRIGGER trg_private_identity_requires_basis
BEFORE INSERT ON participant_private_identity
BEGIN
  SELECT CASE
    WHEN NEW.lawful_basis IS NULL OR TRIM(NEW.lawful_basis) = ''
    THEN RAISE(ABORT,
      'participant_private_identity requires a documented lawful_basis before identity data may be stored')
  END;
END;

-- --- documentation is required for collected data --------------------------
DROP TRIGGER IF EXISTS trg_documented_source_required_for_answers;
CREATE TRIGGER trg_documented_source_required_for_answers
BEFORE INSERT ON assessment_session
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM documented_source WHERE id = NEW.documented_source_id)
    THEN RAISE(ABORT, 'assessment_session requires an existing documented_source (provenance)')
  END;
END;

-- --- instrument versions freeze once answers exist ------------------------
DROP TRIGGER IF EXISTS trg_instrument_version_frozen_items;
CREATE TRIGGER trg_instrument_version_frozen_items
BEFORE UPDATE ON item_definition
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM observed_answer oa
      JOIN assessment_session s ON s.id = oa.assessment_session_id
      WHERE s.instrument_version_id = OLD.instrument_version_id
    )
    AND (OLD.text_verbatim IS NOT NEW.text_verbatim
      OR OLD.response_type IS NOT NEW.response_type
      OR OLD.options_json IS NOT NEW.options_json
      OR OLD.reverse_scored IS NOT NEW.reverse_scored
      OR OLD.item_code IS NOT NEW.item_code)
    THEN RAISE(ABORT,
      'this instrument version already has recorded answers: item wording, format, options and keying are frozen. Create a new instrument version instead')
  END;
END;
