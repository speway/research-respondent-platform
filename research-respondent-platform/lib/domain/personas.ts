/** Modeled simulation boundary. No research records, I/O or implicit transport. */
import { createHash } from "node:crypto";
import dimensions from "../../tools/psychological-personas/references/dimensions.json" with { type: "json" };
import { DomainError } from "./types.ts";

export const PERSONA_TOPICS = ["general", "gaming", "ai-decisions", "education", "work", "relationships"] as const;
export type PersonaTopic = (typeof PERSONA_TOPICS)[number];
export interface PersonaConditions { stress: number; support: number; fatigue: number }
export interface PersonaScenario { topic: PersonaTopic; conditions: PersonaConditions }
export interface PersonaGeneration extends PersonaScenario { count: number; seed: number; age_min: number; age_max: number }
export interface PersonaEpisode {
  episode_id: string; topic: PersonaTopic; conditions: PersonaConditions;
  state: Record<string, number>; topic_features: Record<string, number>;
  assumption_status: "author_scenario_uncalibrated"; model_version: string;
  time_frame: "modeled_current_situation";
  unmeasured_context: { actual_performance: null; diagnosis: null };
}
export interface ModeledPersona {
  id: string; data_origin: "modeled"; person_seed: string; model_version: string;
  fictional_context: { age: number; language: string; gender: string | null; occupation: string | null; location: string | null };
  core: Record<string, Record<string, number>>; core_fingerprint: string;
  unknown_dimensions: Record<string, Record<string, string>>;
  unknowns: { medical_history: null; trauma_history: null; measured_intelligence: null; real_identity: null };
  narrative_starter: string[]; authored_edits: unknown[]; episodes: PersonaEpisode[];
}
export interface PersonaCohort {
  schema_version: "1"; model_version: string; data_origin: "modeled";
  purpose: "coverage_for_educational_simulation";
  coordinate_semantics: "author_coordinates_0_100_not_test_scores_or_percentiles";
  calibration: "none"; source_registry: "references/sources.json";
  generator: Pick<PersonaGeneration, "seed" | "count" | "age_min" | "age_max">;
  personas: ModeledPersona[];
}
interface JobEnvelope { protocol_version: "1"; request_id: string; data_origin: "modeled" }
export type PersonaJob = JobEnvelope & (
  { operation: "generate"; parameters: PersonaGeneration } |
  { operation: "adapt"; parameters: PersonaScenario; cohort: PersonaCohort } |
  { operation: "validate"; cohort: PersonaCohort }
);
export interface PersonaValidation { ok: true; count: number; coordinate_count: number; errors: []; warnings: string[]; spread_min: number; spread_median: number }
export interface PersonaResult {
  protocol_version: "1"; request_id: string; operation: PersonaJob["operation"];
  data_origin: "modeled"; ok: true; validation: PersonaValidation; cohort?: PersonaCohort;
}
export type PersonaTransport = (job: PersonaJob) => Promise<unknown>;

type Obj = Record<string, unknown>;
function ensure(test: unknown, message: string): asserts test {
  if (!test) throw new DomainError("persona.invalid", message, {});
}
function object(value: unknown): Obj {
  ensure(typeof value === "object" && value !== null && !Array.isArray(value), "Expected object.");
  return value as Obj;
}
function exact(value: Obj, keys: readonly string[]): void {
  ensure(Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k)), "Unexpected or missing fields.");
}
function coordinate(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100; }
function integer(value: unknown, low: number, high: number): asserts value is number {
  ensure(typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high, "Integer outside permitted range.");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Python's sorted UTF-8 JSON with float coordinates, including integer .0. */
export function personaCoreFingerprint(core: Record<string, Record<string, number>>): string {
  const encoded = `{${Object.keys(core).sort().map((g) => `${JSON.stringify(g)}:{${Object.keys(core[g]!).sort().map((k) => {
    const n = core[g]![k]!;
    return `${JSON.stringify(k)}:${Number.isInteger(n) ? `${n}.0` : JSON.stringify(n)}`;
  }).join(",")}}`).join(",")}}`;
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}
function scenario(value: unknown, generation: boolean): asserts value is PersonaScenario | PersonaGeneration {
  const p = object(value);
  exact(p, generation ? ["topic", "conditions", "count", "seed", "age_min", "age_max"] : ["topic", "conditions"]);
  ensure(PERSONA_TOPICS.includes(p.topic as PersonaTopic), "Unsupported topic adapter.");
  const c = object(p.conditions); exact(c, ["stress", "support", "fatigue"]);
  ensure(Object.values(c).every(coordinate), "Invalid scenario conditions.");
  if (generation) {
    integer(p.count, 1, 1000); integer(p.seed, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    integer(p.age_min, 18, 100); integer(p.age_max, p.age_min, 100);
  }
}
export function validatePersonaCohort(value: unknown): asserts value is PersonaCohort {
  const c = object(value);
  exact(c, ["schema_version", "model_version", "data_origin", "purpose", "coordinate_semantics", "calibration", "generator", "source_registry", "personas"]);
  ensure(c.schema_version === "1" && c.model_version === dimensions.model_version && c.data_origin === "modeled", "Unsupported cohort version or origin.");
  ensure(c.purpose === "coverage_for_educational_simulation" && c.calibration === "none" && c.source_registry === "references/sources.json", "Invalid simulation provenance.");
  ensure(c.coordinate_semantics === "author_coordinates_0_100_not_test_scores_or_percentiles", "Coordinates cannot be presented as test scores.");
  const gen = object(c.generator); exact(gen, ["seed", "count", "age_min", "age_max"]);
  integer(gen.seed, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); integer(gen.count, 1, 1000);
  integer(gen.age_min, 18, 100); integer(gen.age_max, gen.age_min, 100);
  ensure(Array.isArray(c.personas) && c.personas.length === gen.count, "Invalid persona count.");
  const ids = new Set<string>();
  const expectedUnknown = Object.fromEntries(Object.entries(dimensions.groups).filter(([, g]) => Object.keys(g.unknown_dimensions).length).map(([name, g]) => [name, g.unknown_dimensions]));
  for (const raw of c.personas) {
    const p = object(raw);
    exact(p, ["id", "data_origin", "person_seed", "model_version", "fictional_context", "core", "core_fingerprint", "unknown_dimensions", "unknowns", "narrative_starter", "authored_edits", "episodes"]);
    ensure(typeof p.id === "string" && /^P-[a-f0-9]{6}-\d{5}$/.test(p.id) && !ids.has(p.id), "Invalid or repeated persona identifier."); ids.add(p.id);
    ensure(p.data_origin === "modeled" && p.model_version === dimensions.model_version, "Persona origin/version lost.");
    ensure(typeof p.person_seed === "string" && /^(0|[1-9][0-9]{0,19})$/.test(p.person_seed) && BigInt(p.person_seed) < 2n ** 64n, "Seed must be a decimal uint64 string.");
    const ctx = object(p.fictional_context); exact(ctx, ["age", "language", "gender", "occupation", "location"]);
    integer(ctx.age, gen.age_min, gen.age_max);
    ensure(typeof ctx.language === "string" && [ctx.gender, ctx.occupation, ctx.location].every((x) => x === null || typeof x === "string"), "Invalid fictional context.");
    const core = object(p.core); exact(core, Object.keys(dimensions.groups));
    for (const [group, spec] of Object.entries(dimensions.groups)) {
      const values = object(core[group]); exact(values, Object.keys(spec.dimensions));
      ensure(Object.values(values).every(coordinate), "Invalid core coordinates.");
    }
    ensure(p.core_fingerprint === personaCoreFingerprint(core as PersonaCohort["personas"][number]["core"]), "Core fingerprint mismatch.");
    ensure(canonical(p.unknown_dimensions) === canonical(expectedUnknown), "Unknown dimension metadata lost.");
    ensure(canonical(p.unknowns) === canonical({ medical_history: null, trauma_history: null, measured_intelligence: null, real_identity: null }), "Unmeasured facts must remain null.");
    ensure(Array.isArray(p.narrative_starter) && p.narrative_starter.every((s) => typeof s === "string") && Array.isArray(p.authored_edits), "Narrative/history missing.");
    ensure(Array.isArray(p.episodes) && p.episodes.length >= 1 && p.episodes.length <= 100, "Invalid episode history length.");
    const episodeIds = new Set<string>();
    for (const rawEp of p.episodes) {
      const ep = object(rawEp);
      exact(ep, ["episode_id", "topic", "time_frame", "conditions", "state", "topic_features", "assumption_status", "unmeasured_context", "model_version"]);
      ensure(typeof ep.episode_id === "string" && /^[a-f0-9]{12}$/.test(ep.episode_id) && !episodeIds.has(ep.episode_id), "Invalid or repeated episode identifier."); episodeIds.add(ep.episode_id);
      scenario({ topic: ep.topic, conditions: ep.conditions }, false);
      ensure(ep.model_version === dimensions.model_version && ep.assumption_status === "author_scenario_uncalibrated" && ep.time_frame === "modeled_current_situation", "Episode provenance lost.");
      const state = object(ep.state); exact(state, ["anxiety_now", "tension_now", "positive_affect_now", "negative_affect_now", "available_regulation_now"]);
      const features = object(ep.topic_features);
      ensure(Object.values(state).every(coordinate) && Object.keys(features).length > 0 && Object.values(features).every(coordinate), "Invalid episode coordinates.");
      ensure(canonical(ep.unmeasured_context) === canonical({ actual_performance: null, diagnosis: null }), "Unmeasured outcomes must remain null.");
    }
  }
}
export function validatePersonaJob(value: unknown): asserts value is PersonaJob {
  const j = object(value);
  const fields = ["protocol_version", "request_id", "operation", "data_origin"];
  if (j.operation === "generate" || j.operation === "adapt") fields.push("parameters");
  if (j.operation === "adapt" || j.operation === "validate") fields.push("cohort");
  exact(j, fields);
  ensure(j.protocol_version === "1" && j.data_origin === "modeled" && ["generate", "adapt", "validate"].includes(String(j.operation)), "Unsupported job protocol or origin.");
  ensure(typeof j.request_id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(j.request_id), "Invalid request identifier.");
  if (j.operation !== "validate") scenario(j.parameters, j.operation === "generate");
  if (j.operation !== "generate") validatePersonaCohort(j.cohort);
}
export function personaModelContract() {
  return {
    protocol_version: "1", model_version: dimensions.model_version, data_origin: "modeled",
    purpose: "coverage_for_educational_simulation", calibration: "none", topics: [...PERSONA_TOPICS],
    limits: { personas_per_job: 1000, episodes_per_persona: 100, input_bytes: 25_000_000 },
    person_seed_encoding: "decimal_uint64_string", coordinate_semantics: "author_coordinates_0_100_not_test_scores_or_percentiles",
    groups: structuredClone(dimensions.groups),
  };
}
/** The caller supplies and bounds transport execution; no Python assumption in Next.js. */
export async function runPersonaJob(value: unknown, transport: PersonaTransport): Promise<PersonaResult> {
  validatePersonaJob(value);
  const job = structuredClone(value);
  const r = object(await transport(structuredClone(job)));
  ensure(r.ok === true && r.protocol_version === "1" && r.data_origin === "modeled" && r.request_id === job.request_id && r.operation === job.operation, "Worker failure or response binding mismatch.");
  exact(r, job.operation === "validate" ? ["protocol_version", "request_id", "operation", "data_origin", "ok", "validation"] : ["protocol_version", "request_id", "operation", "data_origin", "ok", "validation", "cohort"]);
  const report = object(r.validation);
  exact(report, ["ok", "count", "coordinate_count", "errors", "warnings", "spread_min", "spread_median"]);
  const count = job.operation === "generate" ? job.parameters.count : job.cohort.personas.length;
  ensure(report.ok === true && report.count === count && report.coordinate_count === 169 && Array.isArray(report.errors) && report.errors.length === 0 && Array.isArray(report.warnings) && report.warnings.every((x) => typeof x === "string"), "Invalid worker validation report.");
  ensure(coordinate(report.spread_min) && coordinate(report.spread_median), "Invalid spread report.");
  if (job.operation !== "validate") {
    validatePersonaCohort(r.cohort);
    const cohort = r.cohort;
    ensure(cohort.personas.length === count, "Worker returned an unexpected count.");
    if (job.operation === "generate") {
      const p = job.parameters;
      ensure(canonical(cohort.generator) === canonical({ count: p.count, seed: p.seed, age_min: p.age_min, age_max: p.age_max }), "Generation parameters changed.");
    } else {
      ensure(canonical(cohort.generator) === canonical(job.cohort.generator), "Adaptation changed generator metadata.");
      job.cohort.personas.forEach((old, i) => {
        const next = cohort.personas[i]!;
        const { episodes: before, ...oldStable } = old;
        const { episodes: after, ...newStable } = next;
        ensure(canonical(oldStable) === canonical(newStable) && after.length >= before.length && canonical(before) === canonical(after.slice(0, before.length)), "Adaptation changed identity, core or existing history.");
      });
    }
    for (const p of cohort.personas) ensure(p.episodes.some((ep) => ep.topic === job.parameters.topic && canonical(ep.conditions) === canonical(job.parameters.conditions)), "Requested scenario is missing.");
  }
  return r as unknown as PersonaResult;
}
