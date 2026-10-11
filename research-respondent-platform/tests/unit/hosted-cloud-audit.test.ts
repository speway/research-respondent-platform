import assert from "node:assert/strict";
import { it } from "node:test";
import { hostedAuditInput, readHostedAudit, startHostedAudit, type HostedAuditDependencies, type HostedAuditInput } from "../../lib/services/hosted-cloud-audit.ts";

const input: HostedAuditInput = { formUrl: "https://docs.google.com/forms/d/e/fixture/viewform", approval: {
  purpose: "read_only_form_audit", evidenceReference: "fixture-one", expiresAt: "2030-01-01T00:00:00Z", maxRuns: 1,
} };
function fixture() {
  const records = new Map<string, string>();
  const claims = new Set<string>();
  let launches = 0;
  const deps: HostedAuditDependencies = {
    read: async (path) => records.get(path) ?? null,
    save: async (path, record) => { if (records.has(path)) throw new Error("duplicate"); records.set(path, JSON.stringify(record)); },
    claim: async (key) => { if (claims.has(key)) throw new Error("reserved"); claims.add(key); return true; },
    storageVerified: async () => true,
    launch: async () => { launches++; return "wrun_fixture"; }, now: () => Date.parse("2026-10-11T00:00:00Z"),
  };
  return { deps, records, claims, launches: () => launches };
}
it("requires explicit Preview, deployment, immutable source scope and valid expiry", () => {
  const env = { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_DEPLOYMENT_ID: "dpl_fixture", RRP_CLOUD_DIAGNOSTICS: "1", BLOB_STORE_ID: "store_fixture",
    RRP_CLOUD_AUDIT_FORM_URL: input.formUrl, RRP_CLOUD_AUDIT_APPROVAL_REF: input.approval.evidenceReference, RRP_CLOUD_AUDIT_EXPIRES_AT: input.approval.expiresAt };
  assert.deepEqual(hostedAuditInput(env), input);
  for (const change of [{ VERCEL_ENV: "production" }, { VERCEL_DEPLOYMENT_ID: "" }, { RRP_CLOUD_AUDIT_EXPIRES_AT: "invalid" },
    { RRP_CLOUD_AUDIT_FORM_URL: `${input.formUrl}?entry.123=answer` }, { RRP_CLOUD_AUDIT_APPROVAL_REF: "../../override" }]) {
    assert.equal(hostedAuditInput({ ...env, ...change }), null);
  }
});
it("launches once under concurrency, reuses persisted receipt and rejects changed form", async () => {
  const f = fixture();
  const runs = await Promise.allSettled(Array.from({ length: 8 }, () => startHostedAudit(input, f.deps)));
  assert.equal(runs.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(f.launches(), 1);
  const stored = await readHostedAudit(input, f.deps);
  assert.ok(stored);
  f.deps.now = () => Date.parse("2031-01-01T00:00:00Z");
  assert.deepEqual(await startHostedAudit(input, f.deps), stored);
  assert.equal(f.launches(), 1);
  await assert.rejects(startHostedAudit({ ...input, formUrl: "https://docs.google.com/forms/d/e/other/viewform" }, f.deps));
});
it("uncertain launch or receipt persistence never enqueues a second workflow", async () => {
  for (const phase of ["launch", "save"] as const) {
    const f = fixture();
    let effects = 0;
    if (phase === "launch") f.deps.launch = async () => { effects++; throw new Error("unknown"); };
    else f.deps.save = async () => { effects++; throw new Error("unknown"); };
    await assert.rejects(startHostedAudit(input, f.deps));
    await assert.rejects(startHostedAudit(input, f.deps));
    assert.equal(effects, 1);
    assert.equal(f.claims.size, 1);
  }
});
it("invalid, expired, unverified and expiry-during-reservation scopes cannot launch", async () => {
  const invalid = fixture();
  await assert.rejects(startHostedAudit({ ...input, formUrl: "https://example.com" }, invalid.deps));
  assert.equal(invalid.claims.size, 0);
  const expired = fixture(); expired.deps.now = () => Date.parse("2031-01-01T00:00:00Z");
  await assert.rejects(startHostedAudit(input, expired.deps)); assert.equal(expired.claims.size, 0);
  const unverified = fixture(); unverified.deps.storageVerified = async () => false;
  await assert.rejects(startHostedAudit(input, unverified.deps)); assert.equal(unverified.claims.size, 0);
  const delayed = fixture(); const claim = delayed.deps.claim;
  delayed.deps.claim = async (key) => { const result = await claim(key); delayed.deps.now = () => Date.parse("2031-01-01T00:00:00Z"); return result; };
  await assert.rejects(startHostedAudit(input, delayed.deps));
  for (const f of [invalid, expired, unverified, delayed]) assert.equal(f.launches(), 0);
});
