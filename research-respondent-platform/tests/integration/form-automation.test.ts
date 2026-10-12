/** Isolated provider/service fixtures. Never participant records or live submissions. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { Cabinet, cabinetConfiguration } from "../../lib/services/cabinet.ts";
import { FormAutomation, automationFlags } from "../../lib/services/form-automation.ts";
import { hashPassword, sha256 } from "../../lib/services/password.ts";
import { automationResultSchema, formIdentity } from "../../lib/domain/form-automation.ts";
import { runCloudFormTask } from "../../lib/services/cloud-form-task.ts";
import { formRequestAllowed } from "../../tools/cloud-agent/form-policy.mjs";
import { workspaceFromTask } from "../../lib/domain/agent-workbench.ts";
import { selectedRows } from "../../lib/domain/workbench.ts";

const accounts = [ { id: "owner", login: "owner", label: "Fixture", password: hashPassword("isolated-automation-password") },
  { id: "team", login: "team", label: "Team", password: hashPassword("isolated-automation-password") } ];
async function fixture() {
  let clock = Date.now(), generation = 0;
  const records = new Map<string, { body: string; etag: string }>();
  const store = {
    async read(path: string) { return records.get(path) ?? null; },
    async write(path: string, value: unknown, etag?: string) {
      const old = records.get(path); if (etag ? old?.etag !== etag : !!old) throw new BlobPreconditionFailedError();
      records.set(path, { body: JSON.stringify(value), etag: `"test-${++generation}"` });
    },
    async paths(prefix: string) { return [...records.keys()].filter((p) => p.startsWith(prefix)); },
  };
  const config = cabinetConfiguration({ RRP_CABINET_STORE_ID: "store_fixture", RRP_CABINET_ACCOUNTS: JSON.stringify(accounts), VERCEL: "1", VERCEL_ENV: "production" })!;
  const cabinet = new Cabinet(config, store, () => clock), automation = new FormAutomation(config, store, () => clock);
  const owner = config.accounts[0]!, team = config.accounts[1]!;
  const source = await cabinet.upload(owner, { kind: "source", name: "isolated.csv", base64: Buffer.from("participant_id,group,answer\nTEST-A,one,0\nTEST-B,two,2\n").toString("base64"), reference: "software fixture", rights: "test-only" });
  const evidence = await cabinet.upload(owner, { kind: "questionnaire", name: "isolated-grant.txt", base64: Buffer.from("Software fixture authorization, not consent from a person").toString("base64"), reference: "software fixture", rights: "test-only" });
  const project = await cabinet.createProject(owner, { name: "Fixture project", sourceId: source.id, questionnaireIds: [], formUrl: "https://docs.google.com/forms/d/e/fixture/viewform", purpose: "test-only", idHeader: "participant_id", criteria: [{ header: "group", op: "eq", value: "one", label: "one" }] });
  const request = { requestId: randomUUID(), projectId: project.id, participantRef: "TEST-A", mode: "prepare" as const };
  const writeRequest = { ...request, requestId: randomUUID(), mode: "submit" as const, evidenceAssetId: evidence.id, evidenceReference: "isolated authorization", consentConfirmed: true, recipientConfirmed: true };
  return { config, cabinet, automation, owner, team, source, evidence, project, request, writeRequest, store, records, advance: (ms: number) => { clock += ms; } };
}
const completed = { status: "response_recorded", externalSubmission: true, evidence: "visible_response_recorded", sectionsVerified: 2, questionsVerified: 5, observedAt: new Date().toISOString() };
it("jobs are immutable, request-bound and account-bound; no answers enter the launch payload", async () => {
  const f = await fixture(); const job = await f.automation.reserve(f.owner, f.request, false);
  assert.equal((await f.automation.reserve(f.owner, f.request, false)).id, job.id);
  await assert.rejects(f.automation.reserve(f.owner, { ...f.request, participantRef: "TEST-B" }, false), { status: 409 });
  await assert.rejects(f.automation.view(f.team.id, job.id), { status: 404 });
  const payloads: unknown[] = [];
  await f.automation.dispatch(job, async (...args) => { payloads.push(args); return "wrun_isolated"; });
  await f.automation.dispatch(job, async () => { throw new Error("Must not relaunch"); });
  assert.deepEqual(payloads, [[f.owner.id, job.id]]);
  assert.equal(JSON.stringify(await f.automation.view(f.owner.id, job.id)).includes("software fixture authorization"), false);
});
it("single-record source scope intersects original criteria without changing source bytes or checksum", async () => {
  const f = await fixture(); const bundle = await f.cabinet.bundle(f.owner, f.project.id);
  const scoped = await workspaceFromTask({ ...bundle.task, sourceRows: [2] });
  assert.equal(selectedRows(scoped).length, 1); assert.equal(scoped.checksum, f.source.sha256);
  assert.equal(selectedRows(await workspaceFromTask({ ...bundle.task, sourceRows: [3] })).length, 0, "Cannot escape original cohort by selecting an excluded row.");
  await assert.rejects(workspaceFromTask({ ...bundle.task, sourceRows: [99] }), /исходных строк/);
  await assert.rejects(workspaceFromTask({ ...bundle.task, sourceRows: [2, 2] }), /исходных строк/);
  const job = await f.automation.reserve(f.owner, f.request, false); const input = await f.automation.begin(f.owner.id, job.id, false);
  assert.deepEqual(input.task.sourceRows, [2]); assert.equal(input.task.source.text, bundle.task.source.text);
});
it("saving a scoped project cannot silently expand its source row selection", async () => {
  const f = await fixture();
  const scoped = await f.cabinet.createProject(f.owner, { name: "Scoped fixture", sourceId: f.source.id, questionnaireIds: [], formUrl: f.project.formUrl,
    purpose: "test-only", idHeader: "participant_id", criteria: [], sourceRows: [2] });
  const revision = await f.cabinet.saveSnapshot(f.owner, scoped.id, { checksum: f.source.sha256, formUrl: f.project.formUrl,
    purpose: "test-only", idHeader: "participant_id", match: "all", criteria: [] });
  const saved = await f.cabinet.bundle(f.owner, revision.id);
  assert.deepEqual(saved.task.sourceRows, [2]); assert.equal(saved.sourceChecks.selectedRecords, 1);
  assert.equal(saved.source.sha256, f.source.sha256);
});
it("concurrent dispatches allocate once and uncertain registration never repeats", async () => {
  const f = await fixture(); const job = await f.automation.reserve(f.owner, f.request, false); let starts = 0;
  await Promise.all(Array.from({ length: 8 }, () => f.automation.dispatch(job, async () => { starts++; return "wrun_isolated"; })));
  assert.equal(starts, 1);
  const next = await f.automation.reserve(f.owner, { ...f.request, requestId: randomUUID() }, false);
  await assert.rejects(f.automation.dispatch(next, async () => { throw new Error("registration uncertain"); }));
  assert.equal((await f.automation.dispatch(next, async () => { starts++; return "wrun_second"; })).status, "execution_uncertain");
  assert.equal(starts, 1);
});
it("out-of-cohort, disabled writes and missing declarations/evidence cannot start", async () => {
  const f = await fixture();
  await assert.rejects(f.automation.reserve(f.owner, { ...f.request, participantRef: "TEST-B" }, false), { status: 400 });
  await assert.rejects(f.automation.reserve(f.owner, f.writeRequest, false), { status: 403 });
  await assert.rejects(f.automation.reserve(f.owner, { ...f.request, mode: "submit" }, true));
  await assert.rejects(f.automation.reserve(f.owner, { ...f.writeRequest, evidenceAssetId: f.source.id }, true), { status: 400 });
  assert.equal((await f.automation.list(f.owner)).length, 0);
  assert.equal(formIdentity("https://docs.google.com/forms/d/e/fixture/viewform?usp=dialog"), "fixture");
  assert.throws(() => formIdentity("https://docs.google.com/forms/d/e/fixture/viewform?entry.1=2"));
  assert.equal(automationFlags({ VERCEL: "1", VERCEL_ENV: "preview", RRP_FORM_AUTOMATION: "1", RRP_FORM_AUTOMATION_WRITE: "1" }).writes, false);
});
it("daily budget and per-job start claims stop repeated allocation before browser creation", async () => {
  const f = await fixture(); let allocated = 0;
  for (let i = 0; i < 3; i++) { const job = await f.automation.reserve(f.owner, { ...f.request, requestId: randomUUID() }, false); await f.automation.dispatch(job, async () => { allocated++; return `wrun_${i}`; }); }
  const fourth = await f.automation.reserve(f.owner, { ...f.request, requestId: randomUUID() }, false);
  await assert.rejects(f.automation.dispatch(fourth, async () => { allocated++; return "must_not_start"; }), { status: 429 });
  assert.equal(allocated, 3);
  const first = (await f.automation.list(f.owner)).find((j) => j.status === "queued")!;
  const input = await f.automation.begin(f.owner.id, first.id, false); assert.equal(input.grant, null);
  await assert.rejects(f.automation.begin(f.owner.id, first.id, false), BlobPreconditionFailedError);
});
it("shared durable receipt ignores source revisions and harmless URL variants; only one submit claim wins", async () => {
  const f = await fixture(); const job = await f.automation.reserve(f.owner, f.writeRequest, true);
  await f.automation.begin(f.owner.id, job.id, true);
  const key = sha256(JSON.stringify([job.formUrl, job.request.participantRef, job.sourceSha256]));
  assert.equal(await f.automation.claimSubmission(job, key), true);
  const changed = await f.cabinet.upload(f.owner, { kind: "source", name: "changed.csv", base64: Buffer.from("participant_id,answer\nTEST-A,2\n").toString("base64"), reference: "software fixture revision", rights: "test-only" });
  const variant = await f.cabinet.createProject(f.owner, { name: "URL variant", sourceId: changed.id, questionnaireIds: [], formUrl: `${job.formUrl}?usp=dialog`, purpose: "test-only", idHeader: "participant_id", criteria: [] });
  const other = await f.automation.reserve(f.owner, { ...f.writeRequest, requestId: randomUUID(), projectId: variant.id }, true);
  assert.notEqual(other.sourceSha256, job.sourceSha256);
  assert.equal(await f.automation.claimSubmission(other, sha256(JSON.stringify([other.formUrl, other.request.participantRef, other.sourceSha256]))), false);
  await f.automation.finish(job, completed);
  assert.equal((await f.automation.view(f.owner.id, job.id)).status, "response_recorded");
  await assert.rejects(f.automation.finish(other, completed), /durable claim/);
});
it("errors after durable submit authorization become uncertainty, never a false no-send or retry", async () => {
  const f = await fixture(); const job = await f.automation.reserve(f.owner, f.writeRequest, true);
  await f.automation.claimSubmission(job, sha256(JSON.stringify([job.formUrl, job.request.participantRef, job.sourceSha256])));
  await f.automation.finish(job, { status: "blocked", externalSubmission: false, observedAt: new Date().toISOString() });
  const view = await f.automation.view(f.owner.id, job.id);
  assert.equal(view.status, "submission_uncertain"); assert.equal(view.result!.externalSubmission, "unknown"); assert.equal(view.retryAllowed, false);
  assert.throws(() => automationResultSchema.parse({ ...completed, evidence: undefined }));
});
it("expiry and cancellation are enforced before any cloud source/permission handoff", async () => {
  const f = await fixture(); const job = await f.automation.reserve(f.owner, f.request, false);
  await f.automation.cancel(f.owner, job.id); await assert.rejects(f.automation.begin(f.owner.id, job.id, false), { status: 403 });
  const expired = await f.automation.reserve(f.owner, { ...f.request, requestId: randomUUID() }, false);
  f.advance(1800001); await assert.rejects(f.automation.begin(f.owner.id, expired.id, false), { status: 403 });
});
it("project read keys inspect only their project's job summaries and cannot supply execute permissions", async () => {
  const f = await fixture(); const job = await f.automation.reserve(f.owner, f.request, false);
  const key = await f.cabinet.agentKey(f.owner, f.project.id);
  const scope = await f.cabinet.agentProjectScope(key.token);
  assert.equal((await f.automation.agentJobs(scope))[0]!.id, job.id);
  await f.cabinet.revokeKey(f.owner, key.keyId);
  await assert.rejects(f.cabinet.agentProjectScope(key.token), { status: 401 });
});
it("cloud network gate refuses write-bearing navigation in prepare mode and different recipients", () => {
  const input = { formUrl: "https://docs.google.com/forms/d/e/fixture/viewform", workbenchOrigin: "https://research-respondent-platform.vercel.app", mayFill: false, method: "POST", navigation: true, url: "https://docs.google.com/forms/d/e/fixture/formResponse", postData: "entry.1=actual-answer" };
  assert.equal(formRequestAllowed(input), false);
  assert.equal(formRequestAllowed({ ...input, mayFill: true }), true);
  assert.equal(formRequestAllowed({ ...input, mayFill: true, url: "https://docs.google.com/forms/d/e/foreign/formResponse" }), false);
  assert.equal(formRequestAllowed({ ...input, mayFill: true, url: "https://accounts.google.com/" }), false);
});
it("cloud adapter always stops its VM and a private readback is validated before returning", async () => {
  const f = await fixture(); const job = await f.automation.reserve(f.owner, f.request, false); const input = await f.automation.begin(f.owner.id, job.id, false);
  const events: string[] = [];
  const factory = async () => ({
    async writeFiles(files: { path: string; content: Buffer }[]) { events.push(files.some((x) => x.path.endsWith("input.json")) ? "private-input" : "trusted-code"); },
    async runCommand() { return { exitCode: 0, stdout: async () => "" }; },
    async update() { events.push("scoped-network"); },
    async readFileToBuffer({ path }: { path: string }) { return path.endsWith("result.json") ? Buffer.from(JSON.stringify({ status: "prepared", externalSubmission: false, observedAt: new Date().toISOString() })) : null; },
    async stop() { events.push("stopped"); },
  });
  const result = await runCloudFormTask(input, f.automation, factory); assert.equal(result.status, "prepared"); assert.equal(events.at(-1), "stopped");
  assert.ok(events.indexOf("private-input") > events.indexOf("trusted-code"));
  await assert.rejects(runCloudFormTask(input, f.automation, async () => ({ ...await factory(), async runCommand() { throw new Error("provider unavailable"); } })));
  assert.equal(events.at(-1), "stopped");
});
