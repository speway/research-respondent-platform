import { randomUUID } from "node:crypto";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { cabinetConfiguration } from "../../lib/services/cabinet.ts";
import { hashPassword } from "../../lib/services/password.ts";
import { Quorum } from "../../lib/services/quorum.ts";
import type { CabinetStore } from "../../lib/services/cabinet-store.ts";
export const fixturePassword = "quorum-isolated-password";
export const fixtureQuestions = [{ id: "q1", kind: "scale", label: "Isolated scale fixture", low: 1, high: 5, required: true }, { id: "q2", kind: "choice", label: "Isolated choice fixture", options: [{ code: "A", label: "First" }, { code: "B", label: "Second" }], required: true }] as const;
export function quorumFixture(namespace = "local") {
  const config = cabinetConfiguration({ ...(namespace === "production" ? { VERCEL: "1" } : {}), RRP_CABINET_STORE_ID: "store_fixture", RRP_CABINET_ACCOUNTS: JSON.stringify([{ id: "owner", login: "fixture", label: "Fixture owner", password: hashPassword(fixturePassword) }]) })!;
  let clock = Date.parse("2026-10-13T00:00:00Z"), seq = 0;
  const records = new Map<string, { body: string; etag: string }>();
  const store: CabinetStore = { async read(path) { return records.get(path) ?? null; }, async write(path, value, etag) { const old = records.get(path); if (etag ? old?.etag !== etag : !!old) throw new BlobPreconditionFailedError(); records.set(path, { body: JSON.stringify(value), etag: `fixture-${++seq}` }); }, async paths(prefix) { return [...records.keys()].filter(p => p.startsWith(prefix)); } };
  const now = () => clock, q = new Quorum(config, store, now);
  return { q, config, store, records, now, advance: (ms: number) => { clock += ms; } };
}
export async function addPerson(f: ReturnType<typeof quorumFixture>, login: string, credits = 5) {
  const invite = await f.q.adminCommand("owner", { command: "invite", login, label: login, group: "fixture-group", starterCredits: credits });
  const result = await f.q.activate("invitationToken" in invite ? invite.invitationToken as string : "", fixturePassword, true, true);
  return { ...result.person, token: result.token, invitation: invite };
}
export async function addExperiment(f: ReturnType<typeof quorumFixture>, people: string[], extra: Record<string, unknown> = {}) {
  for (const p of people) await f.q.studentCommand(p, { command: "profile", profile: { narrative: "Isolated self-description fixture for protocol verification, not a real participant.", reference: "isolated test", consentModeling: true, excludesHoldoutAnswers: true } });
  const experimentId = randomUUID();
  await f.q.adminCommand("owner", { command: "experiment", requestId: experimentId, experiment: { title: "Isolated blind comparison", hypothesis: "Test fixture only, no empirical hypothesis claim", holdoutReference: "unseen fixture questions", modelId: "fixture/model", promptVersion: "fixture-v1", settings: "fixture-fixed", retestDays: 1, participantIds: people, questions: fixtureQuestions, holdoutConfirmed: true, ...extra } });
  for (const participantId of people) await f.q.studentCommand(participantId, { command: "consent_experiment", experimentId, consent: true });
  return experimentId;
}
export async function scopedKey(f: ReturnType<typeof quorumFixture>, experimentId: string, participantId: string, arm: "personal" | "baseline") { const k = await f.q.adminCommand("owner", { command: "agent_key", experimentId, participantId, arm }); return k as { token: string; keyId: string }; }
export const fixturePrediction = (answers: Record<string, number | string | null>) => ({ answers, modelId: "fixture/model", promptVersion: "fixture-v1", settings: "fixture-fixed" });
