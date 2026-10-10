/** Isolated invented fixtures only; never opens the application database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../db/index.ts";
import { createOrganization, createUser, buildActor, createSession, resolveSession, revokeSession } from "../../lib/repo/org.ts";
import { createStudy, enrolParticipant } from "../../lib/repo/studies.ts";
import { createParticipant, recordConsent } from "../../lib/repo/participants.ts";
import { registerDocumentedSource } from "../../lib/repo/sources.ts";
import { createInstrument, createInstrumentVersion, addItems, createAssessmentSession, persistAnswers } from "../../lib/repo/assessments.ts";
import { requestExport, approveExport } from "../../lib/repo/exports.ts";
import { runExportJob } from "../../lib/services/exports-runner.ts";
import { loadMappingSourceContext } from "../../lib/services/preflight-context.ts";
import { authorize, PERMISSIONS, requireActiveConsent } from "../../lib/services/authz.ts";
import { assertOwned, assertStudyChild } from "../../lib/services/ownership.ts";
import { createStudySegment, snapshotSegment, getStudyCohortPreview } from "../../lib/services/cohorts.ts";

function fixture() {
  const db = openDatabase({ file: ":memory:" });
  const org = createOrganization(db, { name: "Security test fixture" });
  const user = createUser(db, { organizationId: org.id, email: "admin@example.test", displayName: "Fixture", password: "fixture-password-123", roles: [{ role: "admin" }] });
  const actor = buildActor(db, user);
  const study = createStudy(db, { organizationId: org.id, code: "FIX", title: "Fixture study", researchQuestion: "Test isolation", createdBy: user.id });
  const otherStudy = createStudy(db, { organizationId: org.id, code: "OTHER", title: "Other fixture", researchQuestion: "Test scope", createdBy: user.id });
  const source = registerDocumentedSource(db, { organizationId: org.id, studyId: study.id, originType: "spreadsheet", title: "Invented test source", reference: "fixture.csv" });
  const participant = createParticipant(db, { organizationId: org.id, pseudonym: "FIX-ONLY", attributes: {}, evidenceDocumentedSourceId: source.id, evidenceLocator: "row:1", createdBy: user.id, consent: { studyId: study.id, version: "v1", status: "granted", basis: "written_signed" } }).participant;
  enrolParticipant(db, { studyId: study.id, participantId: participant.id, enrolmentSource: "fixture" });
  const instrument = createInstrument(db, { organizationId: org.id, slug: "security-fixture", title: "Invented test instrument", rightsStatus: "public_domain" });
  const version = createInstrumentVersion(db, { instrumentId: instrument.id, versionLabel: "v1", language: "en" });
  const items = addItems(db, version.id, [1, 2].map((n) => ({ itemCode: String(n), orderIndex: n, textVerbatim: `Invented item ${n}`, textLanguage: "en", responseType: "numeric" as const, minValue: 0, maxValue: 10 })));
  function session(studyId: string, label: string, value: number) {
    const row = createAssessmentSession(db, { studyId, participantId: participant.id, instrumentVersionId: version.id, timepointLabel: label, administrationMode: "imported_dataset", language: "en", documentedSourceId: source.id });
    persistAnswers(db, row, items.map((item) => ({ itemDefinitionId: item.id, itemCode: item.item_code, rawValueText: String(value), valueNumeric: value, valueCoded: null, isMissing: false, missingReason: null, sourceLocator: `row:1/item:${item.item_code}` })), user.id);
    return row;
  }
  function exported(scope: "analytic_deidentified" | "provenance_audit" = "analytic_deidentified", studyId: string | null = study.id, format: "json" | "jsonl" = "json") {
    const job = requestExport(db, { organizationId: org.id, studyId, scope, format, requestedBy: user.id });
    approveExport(db, job.id, user.id);
    return runExportJob(db, actor, job.id);
  }
  return { db, org, user, actor, study, otherStudy, source, participant, session, exported };
}

test("exports actually remove withdrawn answers and shared provenance", () => {
  const w = fixture();
  try {
    w.session(w.study.id, "T1", 3);
    assert.equal(w.exported().rowCount, 2);
    const withdrawn = recordConsent(w.db, { participantId: w.participant.id, studyId: w.study.id, version: "v1", status: "withdrawn", basis: "written_signed" });
    assert.ok(w.db.prepare("SELECT id FROM consent_record WHERE id = ?").get(withdrawn.id), "withdrawal returns its persisted record for audit");
    const result = w.exported();
    assert.equal(result.rowCount, 0);
    assert.deepEqual(JSON.parse(result.content), []);
    assert.equal(result.consentExcluded.length, 1);
    assert.equal(w.exported("provenance_audit").rowCount, 0);
    assert.equal(w.exported("analytic_deidentified", null).rowCount, 0, "organization export also gates each row by study consent");
  } finally { w.db.close(); }
});

test("JSONL exports are one object per line and omit internal identifiers", () => {
  const w = fixture();
  try {
    w.session(w.study.id, "T1", 3);
    const output = w.exported("analytic_deidentified", w.study.id, "jsonl");
    const rows = output.content.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].pseudonym, w.participant.pseudonym);
    assert.equal("_participant_id" in rows[0], false);
  } finally { w.db.close(); }
});

test("mapping retains every item of the latest session and excludes other studies", () => {
  const w = fixture();
  try {
    const old = w.session(w.study.id, "T1", 2);
    const latest = w.session(w.study.id, "T2", 4);
    w.db.prepare("UPDATE assessment_session SET created_at = '2026-01-01' WHERE id = ?").run(old.id);
    w.db.prepare("UPDATE assessment_session SET created_at = '2026-02-01' WHERE id = ?").run(latest.id);
    const foreign = w.session(w.otherStudy.id, "T3", 9);
    w.db.prepare("UPDATE assessment_session SET created_at = '2026-03-01' WHERE id = ?").run(foreign.id);
    const context = loadMappingSourceContext(w.db, { participantId: w.participant.id, studyId: w.study.id });
    assert.equal(context.answers.length, 2);
    assert.ok(context.answers.every((answer) => answer.sessionId === latest.id && answer.valueNumeric === 4));
    const t1 = loadMappingSourceContext(w.db, { participantId: w.participant.id, studyId: w.study.id, timepointLabel: "T1" });
    assert.equal(t1.answers.length, 2);
    assert.ok(t1.answers.every((answer) => answer.sessionId === old.id));
  } finally { w.db.close(); }
});

test("consent cannot fall back to an older grant or blanket consent after withdrawal", () => {
  const granted = { status: "granted", studyId: "study", withdrawnAt: null, expiresAt: null, version: "v1" };
  const withdrawn = { ...granted, status: "withdrawn", version: "v2" };
  assert.equal(requireActiveConsent([withdrawn, granted, { ...granted, studyId: null }], "study", "2026-10-10").allowed, false);
  assert.equal(requireActiveConsent([{ ...granted, expiresAt: "invalid" }], "study", "2026-10-10").allowed, false);
  assert.equal(requireActiveConsent([{ ...granted, expiresAt: "2026-10-10" }], "study", "2026-10-10").allowed, false);
  assert.equal(requireActiveConsent([granted], "study", "invalid").allowed, false);
});

test("session tokens are hashed; tampered, revoked, inactive and invalid-expiry sessions fail closed", () => {
  const w = fixture();
  try {
    const { token, session } = createSession(w.db, w.user.id);
    assert.notEqual(session.token_hash, token);
    assert.ok(resolveSession(w.db, token));
    assert.equal(resolveSession(w.db, token + "tampered"), null);
    w.db.prepare("UPDATE auth_session SET expires_at = 'invalid' WHERE id = ?").run(session.id);
    assert.equal(resolveSession(w.db, token), null);
    w.db.prepare("UPDATE auth_session SET expires_at = '2099-01-01' WHERE id = ?").run(session.id);
    w.db.prepare("UPDATE app_user SET is_active = 0 WHERE id = ?").run(w.user.id);
    assert.equal(resolveSession(w.db, token), null);
    w.db.prepare("UPDATE app_user SET is_active = 1 WHERE id = ?").run(w.user.id);
    revokeSession(w.db, token);
    assert.equal(resolveSession(w.db, token), null);
  } finally { w.db.close(); }
});

test("organization guards reject foreign studies, participants and exports before mutation", () => {
  const w = fixture();
  try {
    const foreign = { ...w.actor, organizationId: createOrganization(w.db, { name: "Foreign fixture" }).id };
    for (const [kind, id] of [["study", w.study.id], ["participant", w.participant.id]] as const) {
      assert.throws(() => assertOwned(w.db, foreign, kind, id), /unavailable/);
      assert.doesNotThrow(() => assertOwned(w.db, w.actor, kind, id));
    }
    const job = requestExport(w.db, { organizationId: w.org.id, scope: "analytic_deidentified", format: "json" });
    assert.throws(() => assertOwned(w.db, foreign, "export", job.id), /unavailable/);
    assert.throws(() => getStudyCohortPreview(w.db, w.study.id, foreign), /unavailable/);
    assert.throws(() => createStudySegment(w.db, foreign, { studyId: w.study.id, name: "Forbidden", rules: [] }), /unavailable/);
    assert.throws(() => assertStudyChild(w.db, w.study.id, "criterion", "missing"), /unavailable/);
    const segment = createStudySegment(w.db, w.actor, { studyId: w.study.id, name: "Fixture segment", rules: [] });
    const viewer = { ...w.actor, roles: ["viewer"], permissions: [PERMISSIONS.cohortRead] };
    assert.throws(() => snapshotSegment(w.db, viewer, segment.id), /cohort:write/);
  } finally { w.db.close(); }
});

test("a study PI cannot obtain organization-wide study write access", () => {
  const w = fixture();
  try {
    const pi = createUser(w.db, { organizationId: w.org.id, email: "pi@example.test", displayName: "Fixture PI", password: "fixture-password-123", roles: [{ role: "principal_investigator", studyId: w.study.id }] });
    const actor = buildActor(w.db, pi);
    assert.equal(authorize(actor, PERMISSIONS.studyWrite).allowed, false);
    assert.equal(authorize(actor, PERMISSIONS.studyWrite, { studyId: w.study.id }).allowed, true);
    assert.equal(authorize(actor, PERMISSIONS.studyWrite, { studyId: w.otherStudy.id }).allowed, false);
    assert.equal(authorize(actor, PERMISSIONS.assessmentWrite, { studyId: w.otherStudy.id }).allowed, false);
    assert.equal(authorize(actor, PERMISSIONS.exportApprove, { studyId: w.otherStudy.id }).allowed, false);
    assert.equal(authorize(actor, PERMISSIONS.exportCreate).allowed, false);
    assert.equal(authorize(actor, PERMISSIONS.exportCreate, { studyId: w.study.id }).allowed, true);
  } finally { w.db.close(); }
});
