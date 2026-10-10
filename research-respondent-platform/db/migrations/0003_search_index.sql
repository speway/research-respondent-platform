-- ============================================================================
-- Migration 0003: full-text search for the participant registry and audit log
-- ============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS participant_search USING fts5(
  participant_id UNINDEXED,
  pseudonym,
  notes,
  recruitment_channel,
  region
);

CREATE TRIGGER IF NOT EXISTS trg_participant_search_insert
AFTER INSERT ON participant
BEGIN
  INSERT INTO participant_search(participant_id, pseudonym, notes, recruitment_channel, region)
  VALUES (NEW.id, NEW.pseudonym, COALESCE(NEW.notes, ''), COALESCE(NEW.recruitment_channel, ''), COALESCE(NEW.region, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_participant_search_update
AFTER UPDATE ON participant
BEGIN
  DELETE FROM participant_search WHERE participant_id = OLD.id;
  INSERT INTO participant_search(participant_id, pseudonym, notes, recruitment_channel, region)
  VALUES (NEW.id, NEW.pseudonym, COALESCE(NEW.notes, ''), COALESCE(NEW.recruitment_channel, ''), COALESCE(NEW.region, ''));
END;
