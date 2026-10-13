/** Exercises the real Python worker through JavaScript serialization, no DB. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { personaCoreFingerprint, personaModelContract, runPersonaJob, validatePersonaJob, type PersonaJob, type PersonaCohort } from "../../lib/domain/personas.ts";

const root = new URL("../../tools/psychological-personas/", import.meta.url);
const worker = fileURLToPath(new URL("scripts/worker.py", root));
function execute(job: unknown): { status: number | null; result: unknown; raw: string } {
  const output = spawnSync("python3", [worker], { input: JSON.stringify(job), encoding: "utf8", timeout: 15_000, maxBuffer: 25_000_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.ifError(output.error);
  assert.equal(output.stderr, "");
  return { status: output.status, result: JSON.parse(output.stdout), raw: output.stdout };
}
async function transport(job: PersonaJob): Promise<unknown> {
  const { status, result } = execute(job); assert.equal(status, 0); return result;
}
const generation: PersonaJob = {
  protocol_version: "1", request_id: "integration-generate", operation: "generate", data_origin: "modeled",
  parameters: { count: 4, seed: 42, age_min: 18, age_max: 25, topic: "education", conditions: { stress: 50, support: 50, fatigue: 30 } },
};
function cohort(): PersonaCohort {
  return (execute(generation).result as { cohort: PersonaCohort }).cohort;
}

test("bundled model and worker match their pinned source manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as { model_version: string; sha256: Record<string, string> };
  for (const [path, hash] of Object.entries(manifest.sha256)) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex"), hash, path);
  }
  const contract = personaModelContract();
  assert.equal(contract.model_version, manifest.model_version);
  assert.equal(Object.keys(contract.groups).length, 17);
  assert.equal(Object.values(contract.groups).reduce((n, g) => n + Object.keys(g.dimensions).length, 0), 169);
});

test("generation is reproducible and preserves uint64 seeds as strings", async () => {
  const a = await runPersonaJob(generation, transport);
  const b = await runPersonaJob(JSON.parse(JSON.stringify(generation)), transport);
  assert.deepEqual(a, b);
  assert.equal(a.validation.coordinate_count, 169);
  assert.ok(a.cohort!.personas.some((p) => BigInt(p.person_seed) > BigInt(Number.MAX_SAFE_INTEGER)));
  for (const p of a.cohort!.personas) assert.equal(personaCoreFingerprint(p.core), p.core_fingerprint);
  const result = await runPersonaJob({ protocol_version: "1", request_id: "validate-roundtrip", operation: "validate", data_origin: "modeled", cohort: JSON.parse(JSON.stringify(a.cohort)) }, transport);
  assert.equal(result.validation.ok, true);
  assert.equal(result.cohort, undefined);
});

test("adaptation keeps identity, core and history across JavaScript round-trip", async () => {
  const before = cohort();
  const job: PersonaJob = { protocol_version: "1", request_id: "adapt-ai", operation: "adapt", data_origin: "modeled", cohort: before, parameters: { topic: "ai-decisions", conditions: { stress: 85, support: 30, fatigue: 70 } } };
  const after = (await runPersonaJob(job, transport)).cohort!;
  assert.deepEqual(job.cohort, before, "caller data must not be mutated");
  before.personas.forEach((p, i) => {
    assert.equal(after.personas[i]!.person_seed, p.person_seed);
    assert.equal(after.personas[i]!.core_fingerprint, p.core_fingerprint);
    assert.deepEqual(after.personas[i]!.core, p.core);
    assert.equal(after.personas[i]!.episodes.length, 2);
  });
  const repeated = await runPersonaJob({ ...job, cohort: JSON.parse(JSON.stringify(after)) }, transport);
  assert.deepEqual(repeated.cohort, after, "repeated scenario must not add duplicate history");
});

test("all six adapters can reuse the same psychological core", async () => {
  const before = cohort();
  for (const topic of personaModelContract().topics) {
    const result = await runPersonaJob({ protocol_version: "1", request_id: `topic-${topic}`, operation: "adapt", data_origin: "modeled", cohort: before, parameters: { topic, conditions: { stress: 50, support: 50, fatigue: 30 } } }, transport);
    assert.deepEqual(result.cohort!.personas.map((p) => p.core_fingerprint), before.personas.map((p) => p.core_fingerprint));
  }
});

test("invalid jobs fail before invoking transport", async () => {
  const changes = [{ data_origin: "observed" }, { parameters: { ...(generation as Extract<PersonaJob, { operation: "generate" }>).parameters, count: 0 } }, { parameters: { ...(generation as Extract<PersonaJob, { operation: "generate" }>).parameters, seed: Number.MAX_SAFE_INTEGER + 1 } }, { submit: true }];
  for (const change of changes) {
    let invoked = false;
    await assert.rejects(runPersonaJob({ ...generation, ...change }, async () => { invoked = true; return {}; }));
    assert.equal(invoked, false);
  }
});

test("tampered core, numeric wire seed and invented unmeasured facts are rejected", () => {
  for (const mutate of [
    (c: PersonaCohort) => { c.personas[0]!.core.bfi2_facets!.sociability! += 1; },
    (c: PersonaCohort) => { (c.personas[0]! as unknown as Record<string, unknown>).person_seed = 42; },
    (c: PersonaCohort) => { (c.personas[0]!.unknowns as unknown as Record<string, unknown>).measured_intelligence = 120; },
    (c: PersonaCohort) => { c.personas[0]!.data_origin = "observed" as "modeled"; },
  ]) {
    const c = cohort(); mutate(c);
    const job = { protocol_version: "1", request_id: "invalid-cohort", operation: "validate", data_origin: "modeled", cohort: c };
    assert.throws(() => validatePersonaJob(job));
    const result = execute(job); assert.equal(result.status, 1);
    assert.equal((result.result as { ok: boolean }).ok, false);
  }
});

test("response binding and adaptation invariants are checked independently of worker", async () => {
  const correct = execute(generation).result as Record<string, unknown>;
  await assert.rejects(runPersonaJob(generation, async () => ({ ...correct, request_id: "another-request" })));
  const before = cohort();
  const job: PersonaJob = { protocol_version: "1", request_id: "bad-adapt", operation: "adapt", data_origin: "modeled", cohort: before, parameters: { topic: "work", conditions: { stress: 50, support: 50, fatigue: 30 } } };
  const response = execute(job).result as { cohort: PersonaCohort };
  response.cohort.personas[0]!.fictional_context.age += 1;
  await assert.rejects(runPersonaJob(job, async () => response));
});

test("malformed worker jobs return a bounded error without echoing input", () => {
  const output = execute({ private_note: "DO_NOT_ECHO_PRIVATE_DATA", request_id: "bad request id" });
  assert.equal(output.status, 1);
  assert.equal(output.raw.includes("DO_NOT_ECHO_PRIVATE_DATA"), false);
  assert.equal((output.result as { request_id: unknown }).request_id, null);
});
