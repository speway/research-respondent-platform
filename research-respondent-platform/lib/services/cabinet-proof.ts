/** One explicitly enabled, protected Preview proof. Fixtures have their own namespace. */
import { Cabinet, cabinetConfiguration } from "./cabinet.ts";
import { privateCabinetStore } from "./cabinet-store.ts";
import { hashPassword } from "./password.ts";
const reportPath = "rrp/cabinet-verification/v1/result.json";
const reservationPath = "rrp/cabinet-verification/v1/reserved.json";
export function cabinetProofEnabled(env = process.env) {
  return env.VERCEL === "1" && env.VERCEL_ENV === "preview" && env.RRP_CABINET_PROOF === "1" && !!env.RRP_CABINET_STORE_ID;
}
export async function cabinetProofReport() {
  if (!cabinetProofEnabled()) return null;
  const record = await privateCabinetStore(process.env.RRP_CABINET_STORE_ID!).read(reportPath, 4096);
  return record ? JSON.parse(record.body) as { schema: string; status: string; checkedAt: string; checks: string[] } : null;
}
export async function runCabinetProof() {
  if (!cabinetProofEnabled()) throw new Error("Preview proof not enabled.");
  const existing = await cabinetProofReport(); if (existing) return existing;
  const config = cabinetConfiguration(process.env); if (!config) throw new Error("No cabinet configuration.");
  const store = privateCabinetStore(config.storeId);
  // Immutable provider reservation: a failure or uncertain launch cannot run another proof.
  await store.write(reservationPath, { schema: "rrp.cabinet-proof-reservation.v1" });
  const password = "isolated-cloud-verification-only";
  const accounts = config.accounts.map((a) => ({ ...a, login: a.id, password: hashPassword(password) }));
  const proofConfig = { ...cabinetConfiguration({ ...process.env, RRP_CABINET_ACCOUNTS: JSON.stringify(accounts) })!, namespace: "isolated-verification" };
  const first = new Cabinet(proofConfig, store); const login = await first.login("owner", password);
  const owner = await first.session(login.token); if (!owner) throw new Error("Cloud login failed.");
  const encode = (s: string) => Buffer.from(s).toString("base64");
  const text = "participant_id,fixture_answer\nISOLATED-TEST,2\n";
  const source = await first.upload(owner, { kind: "source", name: "isolated-verification.csv", reference: "Isolated software verification, not study data", rights: "test-only, no external transfer", base64: encode(text) });
  const methodText = "Isolated verification document. Item fixture_answer, options 1,2,3.";
  const questionnaire = await first.upload(owner, { kind: "questionnaire", name: "isolated-verification.txt", reference: "Software fixture v1", rights: "test-only", base64: encode(methodText) });
  const project = await first.createProject(owner, { name: "ISOLATED VERIFICATION ONLY", sourceId: source.id,
    questionnaireIds: [questionnaire.id], idHeader: "participant_id", purpose: "software verification; no submission",
    formUrl: "https://docs.google.com/forms/d/e/isolated-verification/viewform", criteria: [] });
  const key = await first.agentKey(owner, project.id);
  const reopened = new Cabinet(proofConfig, privateCabinetStore(config.storeId));
  if (!(await reopened.session(login.token)) || (await reopened.forAgent(key.token)).task.source.text !== text
    || (await reopened.forAgentFile(key.token, questionnaire.id)).body.base64 !== encode(methodText)) throw new Error("Durable readback failed.");
  const team = await reopened.session((await reopened.login("team", password)).token);
  if (!team || (await reopened.catalog(team)).assets.length !== 0) throw new Error("Account isolation failed.");
  let rejected = false; try { await reopened.bundle(team, project.id); } catch { rejected = true; }
  if (!rejected) throw new Error("Cross-account project access allowed.");
  await reopened.revokeKey(owner, key.keyId); rejected = false;
  try { await reopened.forAgent(key.token); } catch { rejected = true; }
  if (!rejected) throw new Error("Revoked key allowed.");
  await reopened.logout(login.token); if (await reopened.session(login.token)) throw new Error("Logout failed.");
  const report = { schema: "rrp.cabinet-proof.v1", status: "verified", checkedAt: new Date().toISOString(),
    checks: ["private source persistence", "literal source readback", "questionnaire download", "project-scoped key",
      "new service instance readback", "account isolation", "key revocation", "session login/logout", "provider ETag update"] };
  await store.write(reportPath, report);
  const persisted = await cabinetProofReport(); if (JSON.stringify(persisted) !== JSON.stringify(report)) throw new Error("Proof persistence failed.");
  return report;
}
