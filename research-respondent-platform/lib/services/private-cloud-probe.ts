/** One bounded provider probe: immutable markers only, no respondents or VMs. */
import { createHash } from "node:crypto";
import { get, put } from "@vercel/blob";
import { z } from "zod";
import { createPrivateCloudBudgetJournal } from "./private-cloud-budget.ts";

export const CLOUD_PROBE_RESULT_PATH = "rrp/cloud-diagnostics/v1/result.json";
const reservationKey = createHash("sha256").update("rrp.cloud-storage-probe.v1/reservation").digest("hex");
const collisionKey = createHash("sha256").update("rrp.cloud-storage-probe.v1/collision").digest("hex");
const markerBody = '{"schema":"rrp.cloud-budget-reservation.v1"}';
const reportSchema = z.object({ schema: z.literal("rrp.cloud-storage-probe.v1"), status: z.literal("verified"),
  contenders: z.literal(8), acknowledged: z.literal(1), rejected: z.literal(7), privateRead: z.literal(true),
  anonymousReadDenied: z.literal(true), repeatDenied: z.literal(true), verifiedAt: z.iso.datetime() }).strict();
export type CloudProbeReport = z.infer<typeof reportSchema>;
type PrivateRead = { body: string; url: string } | null;
export interface CloudProbeDependencies {
  claim(key: string): Promise<boolean>;
  read(path: string): Promise<PrivateRead>;
  save(report: CloudProbeReport): Promise<unknown>;
  anonymousStatus(url: string): Promise<number>;
  now(): Date;
}
export function privateCloudProbeDependencies(storeId: string): CloudProbeDependencies {
  const journal = createPrivateCloudBudgetJournal({ storeId });
  return {
    claim: (key) => journal.claim(key),
    async read(path) {
      const result = await get(path, { access: "private", storeId, useCache: false });
      if (result === null) return null;
      if (result.statusCode !== 200 || result.blob.size > 4096) throw new Error("Invalid private probe record.");
      return { body: await new Response(result.stream).text(), url: result.blob.url };
    },
    save: (report) => put(CLOUD_PROBE_RESULT_PATH, JSON.stringify(report), { access: "private", storeId,
      addRandomSuffix: false, allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: 60 }),
    async anonymousStatus(url) {
      const destination = new URL(url);
      if (destination.protocol !== "https:" || !destination.hostname.endsWith(".private.blob.vercel-storage.com")
        || destination.username || destination.password || destination.port || destination.search || destination.hash) {
        throw new Error("Invalid private probe destination.");
      }
      // No auth headers, cookies, presigned links or redirects.
      const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000) });
      await response.body?.cancel();
      return response.status;
    },
    now: () => new Date(),
  };
}
export async function readCloudProbeReport(deps: Pick<CloudProbeDependencies, "read">): Promise<CloudProbeReport | null> {
  const record = await deps.read(CLOUD_PROBE_RESULT_PATH);
  return record ? reportSchema.parse(JSON.parse(record.body)) : null;
}
export async function runPrivateCloudProbe(deps: CloudProbeDependencies): Promise<CloudProbeReport> {
  // Existing evidence is read-only on subsequent requests, never a fresh probe.
  const previous = await readCloudProbeReport(deps);
  if (previous) return previous;
  if (!await deps.claim(reservationKey)) throw new Error("Probe already reserved.");
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => deps.claim(collisionKey)));
  const acknowledged = outcomes.filter((entry) => entry.status === "fulfilled" && entry.value === true).length;
  const rejected = outcomes.filter((entry) => entry.status === "rejected").length;
  if (acknowledged !== 1 || rejected !== 7) throw new Error("Private reservation concurrency not verified.");
  const record = await deps.read(`rrp/cloud-audit-budget/v1/${collisionKey}.json`);
  if (record?.body !== markerBody) throw new Error("Private marker readback not verified.");
  const denied = await deps.anonymousStatus(record.url);
  if (![401, 403, 404].includes(denied)) throw new Error("Anonymous access denial not verified.");
  let repeatDenied = false;
  try { await deps.claim(collisionKey); } catch { repeatDenied = true; }
  if (!repeatDenied) throw new Error("Repeat reservation denial not verified.");
  const report = reportSchema.parse({ schema: "rrp.cloud-storage-probe.v1", status: "verified", contenders: 8,
    acknowledged: 1, rejected: 7, privateRead: true, anonymousReadDenied: true, repeatDenied: true,
    verifiedAt: deps.now().toISOString() });
  await deps.save(report);
  const persisted = await readCloudProbeReport(deps);
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(report)) throw new Error("Probe report persistence not verified.");
  return persisted;
}
