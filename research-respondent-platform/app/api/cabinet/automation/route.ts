import { z } from "zod";
import { start } from "workflow/api";
import { cabinetFormTaskWorkflow } from "../../../../workflows/cabinet-form-task.ts";
import { automationFlags, configuredAutomation } from "../../../../lib/services/form-automation.ts";
import { CabinetError } from "../../../../lib/services/cabinet.ts";
import { cabinetFailure, cabinetJson, cabinetResponse, requireCabinetAccount, requireCabinetOrigin } from "../../../../lib/services/cabinet-http.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  try {
    const { account } = await requireCabinetAccount(); const automation = configuredAutomation();
    const params = new URL(request.url).searchParams;
    if (params.get("project")) return cabinetResponse(await automation.candidates(account, z.string().uuid().parse(params.get("project"))));
    if (params.get("job")) return cabinetResponse(await automation.view(account.id, z.string().uuid().parse(params.get("job"))));
    return cabinetResponse({ flags: automationFlags(), limits: { dailyRuns: 3, minutesPerRun: 5 }, jobs: await automation.list(account) });
  } catch (error) { return cabinetFailure(error); }
}
export async function POST(request: Request) {
  try {
    requireCabinetOrigin(request); const { account } = await requireCabinetAccount(); const automation = configuredAutomation();
    const input = z.discriminatedUnion("command", [z.object({ command: z.literal("start"), request: z.unknown() }).strict(),
      z.object({ command: z.literal("cancel"), jobId: z.string().uuid() }).strict()]).parse(await cabinetJson(request));
    if (input.command === "cancel") return cabinetResponse(await automation.cancel(account, input.jobId));
    const flags = automationFlags(); if (!flags.enabled) throw new CabinetError(503, "Облачный исполнитель ещё не подключён.");
    const job = await automation.reserve(account, input.request, flags.writes);
    return cabinetResponse(await automation.dispatch(job, async (accountId, jobId) => (await start(cabinetFormTaskWorkflow, [accountId, jobId])).runId), 202);
  } catch (error) { return cabinetFailure(error); }
}
