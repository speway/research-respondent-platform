/** Isolated storage fixtures. These records never enter a deployed study or form. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { Cabinet, cabinetConfiguration } from "../../lib/services/cabinet.ts";
import { reserveCabinetAttempt, type CabinetStore } from "../../lib/services/cabinet-store.ts";
import { hashPassword } from "../../lib/services/password.ts";
import { workspaceFromTask } from "../../lib/domain/agent-workbench.ts";
import { validateUpload } from "../../lib/domain/cabinet.ts";
import { bankSpecSchema } from "../../lib/domain/respondent-bank.ts";

const password = "isolated-cabinet-fixture-password";
const accounts = [ { id: "owner", login: "owner", label: "Owner", password: hashPassword(password) },
  { id: "team", login: "team", label: "Team", password: hashPassword(password) } ];
function fixture() {
  let clock = Date.parse("2026-10-11T07:00:00Z"); let generation = 0;
  const records = new Map<string, { body: string; etag: string }>();
  const store: CabinetStore = {
    async read(path) { return records.get(path) ?? null; },
    async write(path, value, etag) { const previous = records.get(path);
      if ((etag && previous?.etag !== etag) || (!etag && previous)) throw new BlobPreconditionFailedError();
      records.set(path, { body: JSON.stringify(value), etag: `"fixture-${++generation}"` }); },
    async paths(prefix) { return [...records.keys()].filter((key) => key.startsWith(prefix)); },
  };
  const config = cabinetConfiguration({ RRP_CABINET_STORE_ID: "store_fixture", RRP_CABINET_ACCOUNTS: JSON.stringify(accounts) })!;
  return { cabinet: new Cabinet(config, store, () => clock), store, records, advance: (ms: number) => { clock += ms; } };
}
const encoded = (text: string) => Buffer.from(text).toString("base64");
async function projectFixture(f = fixture()) {
  const login = await f.cabinet.login("owner", password); const owner = (await f.cabinet.session(login.token))!;
  const source = await f.cabinet.upload(owner, { kind: "source", name: "isolated-test.csv", base64: encoded("participant_id,group,answer\nTEST-A,one,2\nTEST-B,two,4\n"), reference: "Isolated fixture, not participant data", rights: "test-only" });
  const questionnaire = await f.cabinet.upload(owner, { kind: "questionnaire", name: "isolated-method.txt", base64: encoded("Test item answer; options 1,2,3,4"), reference: "Fixture v1", rights: "test-only" });
  const project = await f.cabinet.createProject(owner, { name: "Fixture", sourceId: source.id, questionnaireIds: [questionnaire.id], formUrl: "https://docs.google.com/forms/d/e/fixture/viewform", purpose: "test-only", idHeader: "participant_id", criteria: [{ header: "group", op: "eq", value: "one", label: "one" }] });
  return { ...f, owner, login, source, project, questionnaire };
}
it("cabinet login, expiry, logout and account password rotation invalidate access", async () => {
  const f = fixture(); const first = await f.cabinet.login("owner", password);
  assert.equal((await f.cabinet.session(first.token))?.id, "owner");
  await f.cabinet.logout(first.token); assert.equal(await f.cabinet.session(first.token), null);
  const second = await f.cabinet.login("owner", password); f.advance(8 * 3600000 + 1);
  assert.equal(await f.cabinet.session(second.token), null);
  const rotated = cabinetConfiguration({ RRP_CABINET_STORE_ID: "store_fixture", RRP_CABINET_ACCOUNTS: JSON.stringify([{ ...accounts[0], password: hashPassword("rotated-isolated-fixture-password") }]) })!;
  assert.equal(await new Cabinet(rotated, f.store).session(second.token), null);
});
it("wrong passwords cannot create a session and login attempts are bounded", async () => {
  const f = fixture(); for (let i = 0; i < 20; i++) await assert.rejects(f.cabinet.login("owner", "wrong-password"), { status: 401 });
  await assert.rejects(f.cabinet.login("owner", password), { status: 429 });
  assert.equal([...f.records.keys()].some((path) => path.includes("/sessions/")), false);
  f.advance(900000); assert.ok((await f.cabinet.login("owner", password)).token);
});
it("concurrent ETag attempts cannot all consume the last slot", async () => {
  const f = fixture(); await f.store.write("limit", { count: 19 });
  const results = await Promise.all(Array.from({ length: 8 }, () => reserveCabinetAttempt(f.store, "limit", 20)));
  assert.equal(results.filter(Boolean).length, 1); assert.equal(JSON.parse(f.records.get("limit")!.body).count, 20);
});
it("storage failures do not grant login or silently reset counters", async () => {
  const f = fixture(); f.store.write = async () => { throw new Error("unavailable"); };
  await assert.rejects(f.cabinet.login("owner", password), /unavailable/);
  assert.equal(f.records.size, 0);
});
it("sources and questionnaire files persist across a new service instance with exact checksums", async () => {
  const f = await projectFixture(); const reopened = new Cabinet(cabinetConfiguration({ RRP_CABINET_STORE_ID: "store_fixture", RRP_CABINET_ACCOUNTS: JSON.stringify(accounts) })!, f.store);
  const bundle = await reopened.bundle(f.owner, f.project.id);
  assert.equal(bundle.task.source.text, "participant_id,group,answer\nTEST-A,one,2\nTEST-B,two,4\n");
  assert.equal(bundle.questionnaires[0]!.meta.id, f.questionnaire.id);
  assert.equal((await reopened.asset(f.owner, f.questionnaire.id)).body.base64, encoded("Test item answer; options 1,2,3,4"));
  assert.equal(bundle.permissions.maySubmitExternalResponse, false);
  assert.equal((await reopened.catalog(f.owner)).projects.length, 1);
});
it("shared account cannot list, load or give an agent access to personal sources", async () => {
  const f = await projectFixture(); const team = (await f.cabinet.session((await f.cabinet.login("team", password)).token))!;
  assert.deepEqual((await f.cabinet.catalog(team)).assets, []);
  await assert.rejects(f.cabinet.asset(team, f.source.id), { status: 404 });
  await assert.rejects(f.cabinet.bundle(team, f.project.id), { status: 404 });
  await assert.rejects(f.cabinet.agentKey(team, f.project.id), { status: 404 });
});
it("agent key reads only its frozen project, expires and can be revoked after reload", async () => {
  const f = await projectFixture(); const key = await f.cabinet.agentKey(f.owner, f.project.id);
  assert.equal((await f.cabinet.forAgent(key.token)).project.id, f.project.id);
  assert.equal((await f.cabinet.forAgentFile(key.token, f.questionnaire.id)).meta.id, f.questionnaire.id);
  const unrelated = await f.cabinet.upload(f.owner, { kind: "questionnaire", name: "unrelated.txt", reference: "fixture", rights: "test-only", base64: encoded("unrelated") });
  await assert.rejects(f.cabinet.forAgentFile(key.token, unrelated.id), { status: 404 });
  assert.equal((await f.cabinet.catalog(f.owner)).keys[0]!.keyId, key.keyId);
  await f.cabinet.revokeKey(f.owner, key.keyId); await assert.rejects(f.cabinet.forAgent(key.token), { status: 401 });
  const next = await f.cabinet.agentKey(f.owner, f.project.id); f.advance(24 * 3600000 + 1);
  await assert.rejects(f.cabinet.forAgent(next.token), { status: 401 });
});
it("bad upload formats, modeled provenance and corrupt stored source bytes are rejected", async () => {
  assert.throws(() => validateUpload({ kind: "source", name: "bad.csv", reference: "x", rights: "x", base64: "!!!!" }));
  assert.throws(() => validateUpload({ kind: "source", name: "modeled.json", reference: "x", rights: "x", base64: encoded(JSON.stringify([{ participant_id: "test", data_origin: "modeled" }])) }));
  const f = await projectFixture(); const path = [...f.records.keys()].find((p) => p.endsWith(`/assets/${f.source.id}.json`))!;
  f.records.set(path, { body: JSON.stringify({ base64: encoded("changed") }), etag: "tampered" });
  await assert.rejects(f.cabinet.bundle(f.owner, f.project.id), /checksum mismatch/);
});
it("saving criteria creates an immutable revision using stored answers, never browser replacements", async () => {
  const f = await projectFixture(); const original = await f.cabinet.bundle(f.owner, f.project.id);
  const workspace = await workspaceFromTask(original.task);
  workspace.dataset!.rows[0]!.values[2] = "invented-in-browser"; workspace.rules = [];
  const settings = { checksum: workspace.checksum, formUrl: workspace.formUrl, purpose: workspace.purpose,
    idHeader: "participant_id", match: workspace.match, criteria: [] };
  const revision = await f.cabinet.saveSnapshot(f.owner, f.project.id, settings);
  const saved = await f.cabinet.bundle(f.owner, revision.id);
  assert.notEqual(revision.id, f.project.id); assert.deepEqual(saved.project.criteria, []);
  assert.equal(saved.task.source.text, original.task.source.text);
  assert.equal((await f.cabinet.bundle(f.owner, f.project.id)).project.criteria.length, 1);
  await assert.rejects(f.cabinet.saveSnapshot(f.owner, f.project.id, { ...settings, checksum: "0".repeat(64) }), { status: 400 });
  await assert.rejects(f.cabinet.saveSnapshot(f.owner, f.project.id, { ...settings, dataset: workspace.dataset }));
});

async function bankFixture() {
  const f = await projectFixture();
  const addition = await f.cabinet.upload(f.owner, { kind: "source", name: "addition.csv", reference: "Isolated addition v1", rights: "test-only",
    base64: encoded("participant_id,group,answer\nTEST-B,two,4\nTEST-C,three,0\n") });
  const spec = bankSpecSchema.parse({ mode: "merge", leftId: f.source.id, rightId: addition.id, leftIdHeader: "participant_id", rightIdHeader: "participant_id", name: "Isolated bank", reference: "fixture v1", rights: "test-only" });
  return { ...f, addition, spec };
}
it("bank preview is read-only and an approved commit persists a replay-safe version with lineage", async () => {
  const f = await bankFixture(); const originalKeys = [...f.records.keys()];
  const preview = await f.cabinet.previewBank(f.owner, f.spec);
  assert.deepEqual([...f.records.keys()], originalKeys); assert.equal(preview.summary.conflicts, 0);
  const result = await f.cabinet.commitBank(f.owner, f.spec, preview.previewHash);
  const replay = await f.cabinet.commitBank(f.owner, f.spec, preview.previewHash);
  assert.equal(result.id, replay.id); assert.equal(result.records, 3);
  assert.equal((await f.cabinet.catalog(f.owner)).assets.length, 4);
  const reopened = new Cabinet(cabinetConfiguration({ RRP_CABINET_STORE_ID: "store_fixture", RRP_CABINET_ACCOUNTS: JSON.stringify(accounts) })!, f.store);
  const lineage = await reopened.lineage(f.owner, result.id);
  assert.equal(lineage.resultSha256, result.sha256); assert.equal(lineage.parents[0]!.sha256, f.source.sha256);
  assert.deepEqual(lineage.rows[1]!.origins, [{ source: "left", line: 3 }, { source: "right", line: 2 }]);
  assert.equal((await reopened.bundle(f.owner, f.project.id)).source.id, f.source.id);
});
it("stale previews, conflicts, account crossing and unknown persistence do not publish a bank version", async () => {
  const f = await bankFixture(); const preview = await f.cabinet.previewBank(f.owner, f.spec);
  await assert.rejects(f.cabinet.commitBank(f.owner, { ...f.spec, name: "changed" }, preview.previewHash), { status: 409 });
  const team = (await f.cabinet.session((await f.cabinet.login("team", password)).token))!;
  await assert.rejects(f.cabinet.previewBank(team, f.spec), { status: 404 });
  const conflict = await f.cabinet.upload(f.owner, { kind: "source", name: "conflict.csv", reference: "fixture", rights: "test-only", base64: encoded("participant_id,group,answer\nTEST-A,one,9\n") });
  const badSpec = { ...f.spec, rightId: conflict.id }; const blocked = await f.cabinet.previewBank(f.owner, badSpec);
  assert.ok(blocked.summary.conflicts); await assert.rejects(f.cabinet.commitBank(f.owner, badSpec, blocked.previewHash), { status: 409 });
  const originalWrite = f.store.write; f.store.write = async (path, value, etag) => {
    if (path.includes("/lineage/")) throw new Error("uncertain lineage persistence");
    await originalWrite(path, value, etag);
  };
  await assert.rejects(f.cabinet.commitBank(f.owner, f.spec, preview.previewHash), /uncertain/);
  await assert.rejects(f.cabinet.commitBank(f.owner, f.spec, preview.previewHash), { status: 409 });
  assert.equal((await f.cabinet.catalog(f.owner)).assets.some((a) => !!a.derivation), false);
});
it("concurrent bank commits publish at most one version for an approved preview", async () => {
  const f = await bankFixture(); const preview = await f.cabinet.previewBank(f.owner, f.spec);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => f.cabinet.commitBank(f.owner, f.spec, preview.previewHash)));
  assert.ok(results.some((r) => r.status === "fulfilled"));
  assert.equal((await f.cabinet.catalog(f.owner)).assets.filter((a) => !!a.derivation).length, 1);
  const replay = await f.cabinet.commitBank(f.owner, f.spec, preview.previewHash);
  assert.equal(replay.id, (await f.cabinet.catalog(f.owner)).assets.find((a) => !!a.derivation)!.id);
});
it("an agent receives readiness and scoped lineage, without gaining parent file or other project access", async () => {
  const f = await bankFixture(); const preview = await f.cabinet.previewBank(f.owner, f.spec);
  const result = await f.cabinet.commitBank(f.owner, f.spec, preview.previewHash);
  const project = await f.cabinet.createProject(f.owner, { name: "Bank fixture", sourceId: result.id, questionnaireIds: [], formUrl: f.project.formUrl, purpose: "test-only", idHeader: "participant_id", criteria: [] });
  const key = await f.cabinet.agentKey(f.owner, project.id);
  const bundle = await f.cabinet.forAgent(key.token);
  assert.equal(bundle.sourceChecks.readyForFormObservation, true); assert.equal(bundle.sourceChecks.selectedRecords, 3);
  assert.equal(bundle.lineage!.sha256, result.derivation!.lineageSha256);
  assert.equal((await f.cabinet.forAgentLineage(key.token, result.id)).parents.length, 2);
  await assert.rejects(f.cabinet.forAgentFile(key.token, f.source.id), { status: 404 });
  await assert.rejects(f.cabinet.forAgentLineage(key.token, f.source.id), { status: 404 });
  assert.equal(bundle.permissions.maySubmitExternalResponse, false);
  const path = [...f.records.keys()].find((p) => p.endsWith(`/lineage/${result.id}.json`))!;
  const record = f.records.get(path)!; const tampered = JSON.parse(record.body); tampered.rows[0].outputLine = 99;
  f.records.set(path, { ...record, body: JSON.stringify(tampered) });
  await assert.rejects(f.cabinet.forAgentLineage(key.token, result.id), /checksum/);
});
it("agent readiness reports repeated participant IDs instead of claiming a repeated-session source is ready", async () => {
  const f = await projectFixture();
  const source = await f.cabinet.upload(f.owner, { kind: "source", name: "sessions.csv", reference: "Isolated fixture", rights: "test-only",
    base64: encoded("participant_id,response_id,answer\nTEST-A,one,2\nTEST-A,two,4\n") });
  const project = await f.cabinet.createProject(f.owner, { name: "Repeated sessions", sourceId: source.id, questionnaireIds: [], formUrl: f.project.formUrl,
    purpose: "test-only", idHeader: "participant_id", criteria: [] });
  const bundle = await f.cabinet.bundle(f.owner, project.id);
  assert.equal(bundle.sourceChecks.readyForFormObservation, false); assert.equal(bundle.sourceChecks.duplicateIds, 1);
  assert.deepEqual(bundle.sourceChecks.blockers, ["duplicate_participant_id"]);
});
