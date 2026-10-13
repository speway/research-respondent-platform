import { FatalError } from "workflow";
import { configuredPersonaBank, personaWorkerEnabled } from "../lib/services/persona-bank.ts";
import { runCloudPersonaJob } from "../lib/services/persona-worker.ts";
export async function personaJobWorkflow(accountId:string,jobId:string) {
  "use workflow";
  return await executePersonaJob(accountId,jobId);
}
async function executePersonaJob(accountId:string,jobId:string) {
  "use step";
  const bank = configuredPersonaBank();
  try {
    if(!personaWorkerEnabled()) throw new Error("Persona worker disabled.");
    const job = await bank.job(accountId,jobId);
    const result = await bank.execute(accountId,jobId,input=>runCloudPersonaJob(input,async()=>{
      if(!personaWorkerEnabled()) throw new Error("Persona worker disabled.");
      await bank.allowed(job);
    }));
    return {jobId,status:result.status}; // Never put persona coordinates in Workflow I/O.
  } catch {
    await bank.fail(await bank.job(accountId,jobId));
    throw new FatalError("Persona task stopped. Inspect saved private status; do not retry this job.");
  }
}
executePersonaJob.maxRetries=0;
