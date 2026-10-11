import { getRun, start } from "workflow/api";
import { cloudFormAuditWorkflow } from "../../../workflows/cloud-form-audit.ts";
import { hostedAuditInput, hostedAuditDependencies, readHostedAudit, startHostedAudit } from "../../../lib/services/hosted-cloud-audit.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Result = Awaited<ReturnType<typeof cloudFormAuditWorkflow>>;
export async function POST(request: Request) {
  const input = hostedAuditInput(process.env);
  if (!input) return new Response(null, { status: 404 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response(null, { status: 403 });
  // Scope is server-configured. Request bodies cannot select URLs or budgets.
  try {
    await startHostedAudit(input, hostedAuditDependencies(process.env.BLOB_STORE_ID!, async (args) => {
      const run = await start(cloudFormAuditWorkflow, [args]);
      return run.runId;
    }));
    return Response.redirect(new URL("/cloud/setup?audit=registered", request.url), 303);
  } catch {
    console.error("Cloud workflow registration unverified; no automatic retry");
    return Response.redirect(new URL("/cloud/setup?audit=failed", request.url), 303);
  }
}
export async function GET() {
  const input = hostedAuditInput(process.env);
  if (!input) return new Response(null, { status: 404 });
  try {
    const record = await readHostedAudit(input, hostedAuditDependencies(process.env.BLOB_STORE_ID!, async () => { throw new Error("Read only."); }));
    if (!record) return Response.json({ status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
    const run = getRun<Result>(record.runId);
    const status = await run.status;
    return Response.json({ status, runId: record.runId, ...(status === "completed" ? { result: await run.returnValue } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
