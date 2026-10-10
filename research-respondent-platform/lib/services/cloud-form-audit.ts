/** Bounded cloud reader, deliberately separate from participant submission.
 * Caller must establish official auth and explicit budget approval. No public start route.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import { observationSchema } from "../domain/agent-workbench.ts";
import { validFormUrl } from "../domain/workbench.ts";
import { isReadOnlyFormUrl } from "../../tools/cloud-agent/read-only-policy.mjs";

export const CLOUD_AUDIT_LIMITS = Object.freeze({ timeoutMs: 300000, vcpus: 1, persistent: false, maxOutputBytes: 1024 * 1024 });
const setupNetwork = { allow: ["registry.npmjs.org", "cdn.playwright.dev", "playwright.download.prss.microsoft.com", "storage.googleapis.com", "archive.ubuntu.com", "security.ubuntu.com"] };
const formNetwork = { allow: ["docs.google.com", "forms.gle", "*.gstatic.com", "fonts.googleapis.com", "*.googleusercontent.com"] };
const approvalSchema = z.object({ purpose: z.literal("read_only_form_audit"), evidenceReference: z.string().trim().min(1).max(2000), expiresAt: z.iso.datetime(), maxRuns: z.literal(1) }).strict();
const resultSchema = z.object({ status: z.literal("observed"), sectionNumber: z.number().int().min(1).max(100), observation: observationSchema, externalSubmission: z.literal(false) }).strict();
export type AuditApproval = z.infer<typeof approvalSchema>;
interface FinishedCommand { exitCode: number | null; stdout(): Promise<string> }
interface AuditSandbox {
  writeFiles(files: { path: string; content: Buffer }[]): Promise<unknown>;
  runCommand(options: { cmd: string; args: string[]; cwd: string; sudo?: boolean }): Promise<FinishedCommand>;
  update(options: { networkPolicy: { allow: string[] } }): Promise<unknown>;
  readFileToBuffer(options: { path: string }): Promise<Buffer | null>;
  stop(): Promise<unknown>;
}
export type AuditFactory = (options: { timeout: number; resources: { vcpus: number }; persistent: boolean; networkPolicy: { allow: string[] }; ports: number[] }) => Promise<AuditSandbox>;

export async function runCloudFormAudit({ formUrl, approval, budgetJournal, createSandbox = (options) => Sandbox.create(options), now = () => Date.now() }: { formUrl: string; approval: AuditApproval; budgetJournal: { claim(key: string): Promise<boolean> }; createSandbox?: AuditFactory; now?: () => number }) {
  if (!validFormUrl(formUrl)) throw new Error("Invalid Google Forms destination.");
  if (!isReadOnlyFormUrl(formUrl)) throw new Error("Cloud audit requires an unfilled Google Forms link.");
  const permission = approvalSchema.parse(approval);
  const expires = Date.parse(permission.expiresAt);
  if (expires <= now()) throw new Error("Cloud audit budget approval expired.");
  if (!budgetJournal || typeof budgetJournal.claim !== "function") throw new Error("A durable atomic budget journal is required.");
  // Read traced application files before spending a budget or allocating a VM.
  const [runner, entry, prepare, policy] = await Promise.all([
    readFile(join(process.cwd(), "tools/browser-agent/runner.mjs")),
    readFile(join(process.cwd(), "tools/cloud-agent/audit-entry.mjs")),
    readFile(join(process.cwd(), "tools/cloud-agent/prepare-ubuntu.mjs")),
    readFile(join(process.cwd(), "tools/cloud-agent/read-only-policy.mjs")),
  ]);
  const budgetKey = createHash("sha256").update(JSON.stringify([permission.purpose, permission.evidenceReference])).digest("hex");
  if (!await budgetJournal.claim(budgetKey)) throw new Error("Cloud audit budget already reserved; no automatic retry.");
  if (expires <= now()) throw new Error("Cloud audit approval expired during reservation; no allocation or automatic retry.");
  const sandbox = await createSandbox({ timeout: CLOUD_AUDIT_LIMITS.timeoutMs, resources: { vcpus: CLOUD_AUDIT_LIMITS.vcpus }, persistent: false, ports: [], networkPolicy: setupNetwork });
  try {
    const run = async (cmd: string, args: string[], sudo = false, cwd = "/vercel/sandbox") => {
      const result = await sandbox.runCommand({ cmd, args, cwd, ...(sudo ? { sudo: true } : {}) });
      if (result.exitCode !== 0) throw new Error("Cloud audit command failed; inspect private provider logs. No automatic retry.");
    };
    await run("mkdir", ["-p", "/vercel/sandbox"], false, "/");
    await sandbox.writeFiles([{ path: "/vercel/sandbox/runner.mjs", content: runner }, { path: "/vercel/sandbox/audit-entry.mjs", content: entry }, { path: "/vercel/sandbox/prepare-ubuntu.mjs", content: prepare }, { path: "/vercel/sandbox/read-only-policy.mjs", content: policy }]);
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "playwright@1.62.1"]);
    await run("node", ["/vercel/sandbox/prepare-ubuntu.mjs"], true);
    // Browser binaries must be installed as the same user that launches them.
    await run("node", ["node_modules/playwright/cli.js", "install-deps", "chromium"], true);
    await run("node", ["node_modules/playwright/cli.js", "install", "chromium"]);
    await sandbox.update({ networkPolicy: formNetwork });
    if (expires <= now()) throw new Error("Cloud audit approval expired before opening the form.");
    await run("node", ["/vercel/sandbox/audit-entry.mjs", formUrl]);
    const bytes = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/observation.json" });
    if (!bytes || bytes.length > CLOUD_AUDIT_LIMITS.maxOutputBytes) throw new Error("Missing or oversized cloud audit evidence.");
    const result = resultSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (result.observation.requestedUrl !== formUrl && result.observation.url !== formUrl) throw new Error("Cloud audit evidence has a different destination.");
    return result;
  } finally { await sandbox.stop(); }
}
