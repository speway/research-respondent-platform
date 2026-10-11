/** One owner-scoped read-only launch; immutable private receipts prevent retries. */
import { createHash } from "node:crypto";
import { get, put } from "@vercel/blob";
import { z } from "zod";
import type { AuditApproval } from "./cloud-form-audit.ts";
import { cloudDiagnosticsEnabled } from "./cloud-preview-policy.ts";
import { createPrivateCloudBudgetJournal } from "./private-cloud-budget.ts";
import { privateCloudProbeDependencies, readCloudProbeReport } from "./private-cloud-probe.ts";
import { isReadOnlyFormUrl } from "../../tools/cloud-agent/read-only-policy.mjs";

const inputSchema = z.object({ formUrl: z.string().refine(isReadOnlyFormUrl), approval: z.object({
  purpose: z.literal("read_only_form_audit"), evidenceReference: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
  expiresAt: z.iso.datetime(), maxRuns: z.literal(1),
}).strict() }).strict();
export interface HostedAuditInput { formUrl: string; approval: AuditApproval }
const recordSchema = z.object({ schema: z.literal("rrp.hosted-audit-run.v1"),
  runId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), formHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type HostedAuditRecord = z.infer<typeof recordSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const recordPath = (input: HostedAuditInput) => `rrp/hosted-audit/v1/${hash(input.approval.evidenceReference)}.json`;

export function hostedAuditInput(env: Record<string, string | undefined>): HostedAuditInput | null {
  if (!cloudDiagnosticsEnabled(env) || !env.VERCEL_DEPLOYMENT_ID) return null;
  const result = inputSchema.safeParse({ formUrl: env.RRP_CLOUD_AUDIT_FORM_URL, approval: {
    purpose: "read_only_form_audit", evidenceReference: env.RRP_CLOUD_AUDIT_APPROVAL_REF,
    expiresAt: env.RRP_CLOUD_AUDIT_EXPIRES_AT, maxRuns: 1,
  } });
  return result.success ? result.data : null;
}

export interface HostedAuditDependencies {
  read(path: string): Promise<string | null>;
  save(path: string, record: HostedAuditRecord): Promise<unknown>;
  claim(key: string): Promise<boolean>;
  storageVerified(): Promise<boolean>;
  launch(input: HostedAuditInput): Promise<string>;
  now(): number;
}
export function hostedAuditDependencies(storeId: string, launch: HostedAuditDependencies["launch"]): HostedAuditDependencies {
  const journal = createPrivateCloudBudgetJournal({ storeId });
  return {
    async read(path) {
      const response = await get(path, { access: "private", storeId, useCache: false });
      if (!response) return null;
      if (response.statusCode !== 200 || response.blob.size > 4096) throw new Error("Invalid cloud receipt.");
      return new Response(response.stream).text();
    },
    save: (path, record) => put(path, JSON.stringify(record), { access: "private", storeId,
      addRandomSuffix: false, allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: 60 }),
    claim: (key) => journal.claim(key),
    storageVerified: async () => !!await readCloudProbeReport(privateCloudProbeDependencies(storeId)),
    launch, now: () => Date.now(),
  };
}
export async function readHostedAudit(input: HostedAuditInput, deps: Pick<HostedAuditDependencies, "read">): Promise<HostedAuditRecord | null> {
  inputSchema.parse(input);
  const body = await deps.read(recordPath(input));
  if (body === null) return null;
  const record = recordSchema.parse(JSON.parse(body));
  if (record.formHash !== hash(input.formUrl)) throw new Error("Cloud receipt scope changed.");
  return record;
}
export async function startHostedAudit(input: HostedAuditInput, deps: HostedAuditDependencies): Promise<HostedAuditRecord> {
  inputSchema.parse(input);
  const previous = await readHostedAudit(input, deps);
  if (previous) return previous;
  const expires = Date.parse(input.approval.expiresAt);
  if (expires <= deps.now()) throw new Error("Cloud approval expired.");
  if (!await deps.storageVerified()) throw new Error("Cloud storage not verified.");
  if (!await deps.claim(hash(`rrp.hosted-audit-start.v1/${input.approval.evidenceReference}`))) throw new Error("Cloud launch reserved.");
  if (expires <= deps.now()) throw new Error("Cloud approval expired during reservation.");
  // If launch/save is uncertain, the marker remains: never enqueue another run.
  const runId = await deps.launch(input);
  console.info("Read-only cloud workflow registered", { runId });
  const record = recordSchema.parse({ schema: "rrp.hosted-audit-run.v1", runId, formHash: hash(input.formUrl) });
  await deps.save(recordPath(input), record);
  const persisted = await readHostedAudit(input, deps);
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(record)) throw new Error("Cloud receipt persistence not verified.");
  return persisted;
}
