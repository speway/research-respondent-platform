import { FatalError } from "workflow";
import { automationFlags, configuredAutomation } from "../lib/services/form-automation.ts";
import { runCloudFormTask } from "../lib/services/cloud-form-task.ts";

export async function cabinetFormTaskWorkflow(accountId: string, jobId: string) {
  "use workflow";
  return await executeCabinetFormTask(accountId, jobId);
}
async function executeCabinetFormTask(accountId: string, jobId: string) {
  "use step";
  console.info("Cabinet form task started", { jobId });
  const automation = configuredAutomation();
  const job = await automation.job(accountId, jobId);
  try {
    const flags = automationFlags(); if (!flags.enabled) throw new Error("Automation disabled.");
    const input = await automation.begin(accountId, jobId, flags.writes);
    const result = await runCloudFormTask(input, automation);
    const persisted = await automation.finish(job, result);
    console.info("Cabinet form task completed", { jobId, status: persisted.status });
    return { jobId, status: persisted.status }; // No source cells in Workflow I/O.
  } catch {
    await automation.fail(job, await automation.cancelled(job) ? "cancelled" : "failed");
    console.error("Cabinet form task stopped without retry", { jobId });
    throw new FatalError("Task stopped. Inspect the private cabinet result; do not retry an unknown submission.");
  }
}
executeCabinetFormTask.maxRetries = 0;
