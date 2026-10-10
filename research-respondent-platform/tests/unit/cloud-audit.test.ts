import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOUD_AUDIT_LIMITS, runCloudFormAudit, type AuditFactory } from "../../lib/services/cloud-form-audit.ts";
const url = "https://forms.gle/fixture";
const approval = { purpose: "read_only_form_audit" as const, evidenceReference: "Isolated fixture budget only", expiresAt: "2099-01-01T00:00:00Z", maxRuns: 1 as const };
const result = { status: "observed", sectionNumber: 2, externalSubmission: false, observation: { schema: "rrp.observed-form.v1", url, requestedUrl: url, title: "Fixture", scope: "visible_section", observedAt: "2026-10-10T00:00:00Z", method: "visible_ui", questions: [{ id: "q1", section: "B", text: "A", kind: "text", required: true, options: [] }] } };
function fixture(failure = "") {
  const calls: string[] = []; let created = 0, stopped = 0; const reservations = new Set<string>();
  const budgetJournal = { claim: async (key: string) => { if (reservations.has(key)) return false; reservations.add(key); return true; } };
  const createSandbox: AuditFactory = async (options) => {
    created++; assert.equal(options.timeout, 300000); assert.equal(options.resources.vcpus, 1); assert.equal(options.persistent, false); assert.deepEqual(options.ports, []);
    return {
      writeFiles: async (files) => { assert.equal(files.length, 4); assert.ok(files.every((f) => f.path.startsWith("/vercel/sandbox/"))); calls.push("files"); },
      runCommand: async ({ cmd, args, cwd, sudo }) => {
        calls.push(cmd); assert.equal(args.includes("--token"), false);
        if (cmd === "mkdir") { assert.equal(cwd, "/"); assert.equal(sudo, undefined); }
        else { assert.equal(cwd, "/vercel/sandbox"); }
        if (args.includes("install-deps") || args.includes("/vercel/sandbox/prepare-ubuntu.mjs")) assert.equal(sudo, true);
        if (cmd === "node" && args.includes("install")) assert.equal(sudo, undefined);
        return { exitCode: failure === "command" ? 1 : 0, stdout: async () => "" };
      },
      update: async ({ networkPolicy }) => { calls.push("network"); assert.equal(networkPolicy.allow.includes("registry.npmjs.org"), false); assert.equal(networkPolicy.allow.includes("docs.google.com"), true); },
      readFileToBuffer: async () => Buffer.from(failure === "foreign" ? JSON.stringify({ ...result, observation: { ...result.observation, url: "https://forms.gle/other", requestedUrl: "https://forms.gle/other" } }) : failure === "oversize" ? "x".repeat(CLOUD_AUDIT_LIMITS.maxOutputBytes + 1) : JSON.stringify(result)),
      stop: async () => { stopped++; },
    };
  };
  return { calls, createSandbox, budgetJournal, get created() { return created; }, get stopped() { return stopped; } };
}
test("cloud audit has a fixed budget, narrows egress before reading and always stops its VM", async () => {
  const f = fixture();
  assert.deepEqual(await runCloudFormAudit({ formUrl: url, approval, ...f }), result);
  assert.deepEqual(f.calls, ["mkdir", "files", "npm", "node", "node", "node", "network", "node"]); assert.equal(f.stopped, 1);
  await assert.rejects(runCloudFormAudit({ formUrl: url, approval, ...f }), /already reserved/);
  assert.equal(f.created, 1);
});
test("expired or foreign input cannot provision, and failed/invalid output stops without retry", async () => {
  const f = fixture();
  await assert.rejects(runCloudFormAudit({ formUrl: "https://evil.test", approval, ...f }));
  await assert.rejects(runCloudFormAudit({ formUrl: url, approval: { ...approval, expiresAt: "2000-01-01T00:00:00Z" }, ...f })); assert.equal(f.created, 0);
  for (const failure of ["command", "foreign", "oversize"]) {
    const failed = fixture(failure); await assert.rejects(runCloudFormAudit({ formUrl: url, approval, ...failed })); assert.equal(failed.stopped, 1); assert.equal(failed.created, 1);
  }
});
test("simultaneous cloud requests consume one atomic budget reservation", async () => {
  const f = fixture(); const runs = await Promise.allSettled(Array.from({ length: 8 }, () => runCloudFormAudit({ formUrl: url, approval, ...f })));
  assert.equal(runs.filter((r) => r.status === "fulfilled").length, 1); assert.equal(f.created, 1);
});
test("approval that expires during a slow reservation cannot allocate a VM", async () => {
  const f = fixture(); let at = Date.parse("2098-12-31T23:59:59Z");
  const budgetJournal = { claim: async () => { at = Date.parse(approval.expiresAt); return true; } };
  await assert.rejects(runCloudFormAudit({ formUrl: url, approval, createSandbox: f.createSandbox, budgetJournal, now: () => at }), /expired during reservation/);
  assert.equal(f.created, 0);
});
