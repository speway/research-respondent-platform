import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import { automationResultSchema } from "../domain/form-automation.ts";
import type { AuditFactory } from "./cloud-form-audit.ts";
import type { FormAutomation } from "./form-automation.ts";
import { AUTOMATION_LIMITS } from "./form-automation.ts";

const workbenchOrigin = "https://research-respondent-platform.vercel.app";
const claimSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export async function runCloudFormTask(input: Awaited<ReturnType<FormAutomation["begin"]>>, journal: Pick<FormAutomation, "claimSubmission" | "cancelled" | "progress">,
  createSandbox: AuditFactory = (options) => Sandbox.create(options)) {
  const [runner, entry, policy, readOnlyPolicy, prepare] = await Promise.all([
    readFile(join(process.cwd(), "tools/browser-agent/runner.mjs")),
    readFile(join(process.cwd(), "tools/cloud-agent/form-entry.mjs")),
    readFile(join(process.cwd(), "tools/cloud-agent/form-policy.mjs")),
    readFile(join(process.cwd(), "tools/cloud-agent/read-only-policy.mjs")),
    readFile(join(process.cwd(), "tools/cloud-agent/prepare-ubuntu.mjs")),
  ]);
  const files = [{ path: "/vercel/sandbox/runner.mjs", content: runner },
    { path: "/vercel/sandbox/form-entry.mjs", content: entry }, { path: "/vercel/sandbox/form-policy.mjs", content: policy },
    { path: "/vercel/sandbox/read-only-policy.mjs", content: readOnlyPolicy }, { path: "/vercel/sandbox/prepare-ubuntu.mjs", content: prepare }];
  const setupAllow = ["registry.npmjs.org", "cdn.playwright.dev", "playwright.download.prss.microsoft.com", "storage.googleapis.com", "archive.ubuntu.com", "security.ubuntu.com"];
  const sandbox = await createSandbox({ timeout: AUTOMATION_LIMITS.sandboxMs, resources: { vcpus: 1 }, persistent: false, ports: [], networkPolicy: { allow: setupAllow } });
  try {
    const stillAllowed = async () => {
      if (Date.parse(input.job.expiresAt) <= Date.now() || await journal.cancelled(input.job)) throw new Error("Cancelled or expired job.");
    };
    const run = async (cmd: string, args: string[], sudo = false, cwd = "/vercel/sandbox") => {
      await stillAllowed(); const result = await sandbox.runCommand({ cmd, args, cwd, ...(sudo ? { sudo: true } : {}) });
      if (result.exitCode !== 0) throw new Error("Cloud setup command failed.");
    };
    await run("mkdir", ["-p", "/vercel/sandbox"], false, "/");
    await sandbox.writeFiles(files);
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "playwright@1.62.1"]);
    await run("node", ["/vercel/sandbox/prepare-ubuntu.mjs"], true);
    await run("node", ["node_modules/playwright/cli.js", "install-deps", "chromium"], true);
    await run("node", ["node_modules/playwright/cli.js", "install", "chromium"]);
    await stillAllowed();
    await sandbox.writeFiles([{ path: "/vercel/sandbox/input.json", content: Buffer.from(JSON.stringify({
      task: input.task, grant: input.grant, participantRef: input.job.request.participantRef, workbenchOrigin })) }]);
    await sandbox.update({ networkPolicy: { allow: ["research-respondent-platform.vercel.app", "docs.google.com", "*.gstatic.com", "fonts.googleapis.com"] } });
    let finished = false, decided = false, lastProgress = "";
    const running = sandbox.runCommand({ cmd: "node", args: ["/vercel/sandbox/form-entry.mjs"], cwd: "/vercel/sandbox" });
    const completion = running.then((r) => { finished = true; if (r.exitCode !== 0) throw new Error("Browser worker failed."); }, (error) => { finished = true; throw error; });
    const monitor = async () => {
      while (!finished) {
        await stillAllowed();
        const progressBytes = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/progress.json" });
        if (progressBytes && progressBytes.length <= 2048 && progressBytes.toString("utf8") !== lastProgress) {
          await journal.progress(input.job, JSON.parse(progressBytes.toString("utf8"))); lastProgress = progressBytes.toString("utf8");
        }
        if (!decided) {
          const bytes = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/claim.json" });
          if (bytes) {
            if (bytes.length > 1024) throw new Error("Invalid receipt request.");
            const claim = claimSchema.parse(JSON.parse(bytes.toString("utf8")));
            const allowed = await journal.claimSubmission(input.job, claim.key);
            // Private provider claim is durable before this permission reaches the browser.
            await sandbox.writeFiles([{ path: "/vercel/sandbox/decision.json", content: Buffer.from(JSON.stringify({ key: claim.key, allowed })) }]);
            decided = true;
          }
        }
        if (!finished) await setTimeout(1000);
      }
    };
    await Promise.all([completion, monitor()]);
    const bytes = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/result.json" });
    if (!bytes || bytes.length > 512 * 1024) throw new Error("Missing or oversized task result.");
    return automationResultSchema.parse(JSON.parse(bytes.toString("utf8")));
  } finally { await sandbox.stop(); }
}
