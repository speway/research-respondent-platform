import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudDiagnosticsEnabled } from "../../lib/services/cloud-preview-policy.ts";
import { CLOUD_PROBE_RESULT_PATH, runPrivateCloudProbe, type CloudProbeDependencies } from "../../lib/services/private-cloud-probe.ts";

function fixture() {
  const records = new Map<string, string>();
  let calls = 0;
  const deps: CloudProbeDependencies = {
    async claim(key) {
      calls++;
      const path = `rrp/cloud-audit-budget/v1/${key}.json`;
      if (records.has(path)) throw new Error("Fixture create-only collision");
      records.set(path, '{"schema":"rrp.cloud-budget-reservation.v1"}'); return true;
    },
    async read(path) { const body = records.get(path); return body ? { body, url: "https://fixture.private.blob.vercel-storage.com/marker.json" } : null; },
    async save(report) { records.set(CLOUD_PROBE_RESULT_PATH, JSON.stringify(report)); },
    async anonymousStatus() { return 403; },
    now: () => new Date("2026-10-10T20:00:00Z"),
  };
  return { deps, records, calls: () => calls };
}
test("cloud diagnostics require an explicitly enabled Preview with a configured store", () => {
  const env = { VERCEL: "1", VERCEL_ENV: "preview", RRP_CLOUD_DIAGNOSTICS: "1", BLOB_STORE_ID: "store_fixture" };
  assert.equal(cloudDiagnosticsEnabled(env), true);
  for (const patch of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: "development" }, { VERCEL: "0" }, { RRP_CLOUD_DIAGNOSTICS: "0" }, { BLOB_STORE_ID: "../records" }]) {
    assert.equal(cloudDiagnosticsEnabled({ ...env, ...patch }), false);
  }
});
test("probe requires provider readback, access denial and immutable evidence; repeat is read-only", async () => {
  const f = fixture(); const report = await runPrivateCloudProbe(f.deps);
  assert.equal(report.status, "verified"); assert.equal(f.calls(), 10); assert.equal(f.records.size, 3);
  assert.deepEqual(await runPrivateCloudProbe(f.deps), report); assert.equal(f.calls(), 10);
});
test("partial or unknown provider outcomes never create a verified report or retry the probe", async () => {
  for (const failure of ["uncertain", "public", "missing", "overwrite", "persistence"] as const) {
    const f = fixture();
    if (failure === "uncertain") f.deps.claim = async () => { throw new Error("Unknown acknowledgement"); };
    if (failure === "public") f.deps.anonymousStatus = async () => 200;
    if (failure === "missing") f.deps.read = async () => null;
    if (failure === "overwrite") f.deps.claim = async () => true;
    if (failure === "persistence") f.deps.save = async () => {};
    await assert.rejects(runPrivateCloudProbe(f.deps));
    assert.equal(f.records.has(CLOUD_PROBE_RESULT_PATH), false);
    if (failure !== "overwrite" && failure !== "uncertain") await assert.rejects(runPrivateCloudProbe(f.deps));
  }
});

test("simultaneous probe requests share a durable reservation and perform one collision probe", async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([runPrivateCloudProbe(f.deps), runPrivateCloudProbe(f.deps)]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(f.calls(), 11);
  assert.equal(f.records.size, 3);
});
