import { FatalError } from "workflow";
import { hostedAuditInput, type HostedAuditInput } from "../lib/services/hosted-cloud-audit.ts";
import { runCloudFormAudit } from "../lib/services/cloud-form-audit.ts";
import { createPrivateCloudBudgetJournal } from "../lib/services/private-cloud-budget.ts";
import { privateCloudProbeDependencies, readCloudProbeReport } from "../lib/services/private-cloud-probe.ts";

export async function cloudFormAuditWorkflow(input: HostedAuditInput) {
  "use workflow";
  return await readFirstSection(input);
}

async function readFirstSection(input: HostedAuditInput) {
  "use step";
  console.info("Read-only cloud form step started");
  try {
    const configured = hostedAuditInput(process.env);
    if (!configured || JSON.stringify(configured) !== JSON.stringify(input)) throw new Error("Scope changed.");
    if (!await readCloudProbeReport(privateCloudProbeDependencies(process.env.BLOB_STORE_ID!))) throw new Error("Unverified storage.");
    const result = await runCloudFormAudit({ ...input, budgetJournal: createPrivateCloudBudgetJournal() });
    console.info("Read-only cloud form step completed", { section: result.sectionNumber, questions: result.observation.questions.length });
    return result;
  } catch {
    console.error("Read-only cloud form step failed; no automatic retry");
    throw new FatalError("Read-only audit failed; inspect private provider evidence. No automatic retry.");
  }
}
readFirstSection.maxRetries = 0;
