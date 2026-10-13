/* global fetch, AbortSignal, structuredClone */
import { URL } from "node:url";
/** Capability-scoped client. Caller supplies its model callback; no hidden retries or human-data access. */
function endpoint(site) {
  const url = new URL(site);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Use a trusted HTTPS site origin.");
  return new URL("/api/quorum/agent", url).href;
}
async function request(site, token, body, transport) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("A scoped comparison key is required.");
  const response = await transport(endpoint(site), { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(45000), headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Quorum returned ${response.status}; inspect saved state before retry.`);
  return response.json();
}
export async function readQuorumTask({ site, token, transport = fetch }) {
  const task = await request(site, token, undefined, transport);
  if (task.schema !== "quorum.agent-task.v1" || !["personal", "baseline"].includes(task.arm) || !Array.isArray(task.questions) || task.permissions?.readHumanAnswers !== false || task.permissions?.readOtherArm !== false || task.permissions?.externalSubmission !== false || task.arm === "baseline" && "profile" in task || "human" in task || "retest" in task) throw new Error("Unexpected or over-scoped comparison task.");
  return task;
}
export async function commitQuorumPrediction({ site, token, prediction, transport = fetch }) { return request(site, token, prediction, transport); }
export async function runQuorumAgent({ site, token, predict, transport = fetch }) {
  const task = await readQuorumTask({ site, token, transport });
  if (task.alreadyCommitted) return { alreadyCommitted: true };
  const prediction = await predict(structuredClone(task)); // One callback, no candidate selection or answer perturbation.
  return commitQuorumPrediction({ site, token, prediction, transport });
}
