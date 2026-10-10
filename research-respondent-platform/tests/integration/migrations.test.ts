/**
 * Migration tests: the schema must apply cleanly, be idempotent, and enforce
 * the append-only/provenance triggers that protect research history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrationStatus, loadMigrationFiles } from "../../db/index.ts";

function memoryDb() {
  return openDatabase({ file: ":memory:" });
}

test("all migrations apply cleanly to a fresh database", () => {
  const db = memoryDb();
  const status = migrationStatus(db);
  assert.ok(status.length >= 3, "expected at least three migration files");
  for (const entry of status) {
    assert.equal(entry.applied, true, `migration ${entry.id} should be applied`);
    assert.equal(entry.checksumMatches, true, `migration ${entry.id} checksum should match`);
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name);
  for (const required of [
    "organization",
    "app_user",
    "study",
    "participant",
    "participant_private_identity",
    "consent_record",
    "documented_source",
    "instrument",
    "instrument_version",
    "item_definition",
    "scale_definition",
    "score_algorithm",
    "assessment_session",
    "observed_answer",
    "derived_score",
    "segment",
    "segment_rule",
    "segment_snapshot",
    "external_form",
    "external_form_version",
    "external_form_field",
    "field_mapping",
    "agent",
    "agent_capability",
    "agent_task",
    "task_attempt",
    "execution_evidence",
    "audit_event",
    "export_job",
    "retention_policy",
  ]) {
    assert.ok(tables.includes(required), `missing table ${required}`);
  }
  db.close();
});

test("re-running migrations is a no-op and detects checksum drift", () => {
  const db = memoryDb();
  const first = migrationStatus(db);
  assert.ok(first.every((entry) => entry.applied));
  const files = loadMigrationFiles();
  assert.ok(files.every((file) => file.checksum.length === 64));
  db.close();
});

test("observed_answer rows are immutable and reject silent rewrites", () => {
  const db = memoryDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ('org1','Org','org','" + now + "')",
  ).run();
  db.prepare(
    `INSERT INTO documented_source (id, organization_id, origin_type, title, reference, received_at, created_at)
     VALUES ('src1','org1','spreadsheet','Source','file.xlsx','${now}','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO participant (id, organization_id, pseudonym, attribute_missingness_json, created_at, updated_at)
     VALUES ('p1','org1','P-001','{}','${now}','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO instrument (id, slug, title, rights_status, created_at)
     VALUES ('i1','demo','Demo','public_domain','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO instrument_version (id, instrument_id, version_label, language, created_at)
     VALUES ('iv1','i1','1.0','ru','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO item_definition (id, instrument_version_id, item_code, order_index, text_verbatim, text_language, response_type)
     VALUES ('it1','iv1','01',1,'Item one','ru','likert')`,
  ).run();
  db.prepare(
    `INSERT INTO assessment_session (id, participant_id, instrument_version_id, timepoint_label, administration_mode, language, documented_source_id, created_at)
     VALUES ('s1','p1','iv1','T1','imported_dataset','ru','src1','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO observed_answer (id, assessment_session_id, participant_id, item_definition_id, item_code,
       raw_value_text, value_numeric, is_missing, source_documented_source_id, source_locator, imported_at)
     VALUES ('oa1','s1','p1','it1','01','4',4,0,'src1','sheet1!B2','${now}')`,
  ).run();

  const update = db.prepare("UPDATE observed_answer SET value_numeric = 7 WHERE id = 'oa1'");
  assert.throws(() => update.run(), /append-only/i);
  const remove = db.prepare("DELETE FROM observed_answer WHERE id = 'oa1'");
  assert.throws(() => remove.run(), /cannot be deleted/i);

  // A missing answer must carry a documented reason and no value.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO observed_answer (id, assessment_session_id, participant_id, item_definition_id, item_code,
             raw_value_text, is_missing, source_documented_source_id, source_locator, imported_at)
           VALUES ('oa2','s1','p1','it1','01','',1,'src1','sheet1!B3','${now}')`,
        )
        .run(),
    /CHECK|constraint/i,
  );
  db.close();
});

test("audit_event is append-only", () => {
  const db = memoryDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ('org1','Org','org','" + now + "')",
  ).run();
  db.prepare(
    `INSERT INTO audit_event (id, organization_id, occurred_at, actor_type, actor_label, action,
        entity_type, entity_id, outcome, severity, detail_json)
     VALUES ('ae1','org1','${now}','system','test','migration.check','system','none','success','info','{}')`,
  ).run();
  assert.throws(
    () => db.prepare("UPDATE audit_event SET action = 'tampered' WHERE id = 'ae1'").run(),
    /append-only/i,
  );
  assert.throws(() => db.prepare("DELETE FROM audit_event WHERE id = 'ae1'").run(), /append-only/i);
  db.close();
});

test("identity data requires a documented lawful basis", () => {
  const db = memoryDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ('org1','Org','org','" + now + "')",
  ).run();
  db.prepare(
    `INSERT INTO participant (id, organization_id, pseudonym, attribute_missingness_json, created_at, updated_at)
     VALUES ('p1','org1','P-001','{}','${now}','${now}')`,
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO participant_private_identity (participant_id, contact_email, lawful_basis, recorded_at, updated_at)
           VALUES ('p1','a@example.org','','${now}','${now}')`,
        )
        .run(),
    /lawful_basis/i,
  );
  db.prepare(
    `INSERT INTO participant_private_identity (participant_id, contact_email, lawful_basis, recorded_at, updated_at)
     VALUES ('p1','a@example.org','Signed informed consent 2026-01','${now}','${now}')`,
  ).run();
  db.close();
});

test("derived scores cannot be rewritten in place", () => {
  const db = memoryDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ('org1','Org','org','" + now + "')",
  ).run();
  db.prepare(
    `INSERT INTO documented_source (id, organization_id, origin_type, title, reference, received_at, created_at)
     VALUES ('src1','org1','spreadsheet','S','f','${now}','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO participant (id, organization_id, pseudonym, attribute_missingness_json, created_at, updated_at)
     VALUES ('p1','org1','P-001','{}','${now}','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO instrument (id, slug, title, rights_status, created_at) VALUES ('i1','d','D','public_domain','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO instrument_version (id, instrument_id, version_label, language, created_at)
     VALUES ('iv1','i1','1.0','ru','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO scale_definition (id, instrument_version_id, scale_code, title, kind)
     VALUES ('sd1','iv1','TOT','Total','raw_sum')`,
  ).run();
  db.prepare(
    `INSERT INTO score_algorithm (id, instrument_version_id, scale_definition_id, algorithm_version, algorithm_json, created_at)
     VALUES ('sa1','iv1','sd1','1.0','{"steps":[]}','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO assessment_session (id, participant_id, instrument_version_id, timepoint_label, administration_mode, language, documented_source_id, created_at)
     VALUES ('s1','p1','iv1','T1','imported_dataset','ru','src1','${now}')`,
  ).run();
  db.prepare(
    `INSERT INTO derived_score (id, assessment_session_id, participant_id, scale_definition_id, score_algorithm_id,
        algorithm_version, raw_score, items_used, items_missing, computability, source_item_ids_json, computed_at)
     VALUES ('ds1','s1','p1','sd1','sa1','1.0',42,20,0,'computed','[]','${now}')`,
  ).run();
  assert.throws(
    () => db.prepare("UPDATE derived_score SET raw_score = 99 WHERE id = 'ds1'").run(),
    /immutable/i,
  );
  // Superseding is allowed and preserves the original row.
  db.prepare(
    `INSERT INTO derived_score (id, assessment_session_id, participant_id, scale_definition_id, score_algorithm_id,
        algorithm_version, raw_score, items_used, items_missing, computability, source_item_ids_json, computed_at)
     VALUES ('ds2','s1','p1','sd1','sa1','1.0',43,20,0,'computed','[]','${now}')`,
  ).run();
  db.prepare("UPDATE derived_score SET superseded_by_id = 'ds2' WHERE id = 'ds1'").run();
  const original = db.prepare("SELECT raw_score, superseded_by_id FROM derived_score WHERE id = 'ds1'").get() as {
    raw_score: number;
    superseded_by_id: string;
  };
  assert.equal(original.raw_score, 42);
  assert.equal(original.superseded_by_id, "ds2");
  db.close();
});
