import { quorumModelStatus, runQuorumPrediction } from "../../../../lib/services/quorum-model.ts";
import { configuredQuorum } from "../../../../lib/services/quorum.ts";
import { cabinetFailure, cabinetJson, cabinetResponse, requireCabinetAccount, requireCabinetOrigin } from "../../../../lib/services/cabinet-http.ts";
import { CabinetError } from "../../../../lib/services/cabinet.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) { try { const { account } = await requireCabinetAccount(); if (account.id !== "owner") throw new CabinetError(403, "Управление пилотом доступно владельцу."); const q = configuredQuorum(), params = new URL(request.url).searchParams;
  return cabinetResponse(params.has("report") ? await q.report(account.id, params.get("report")!) : params.has("export") ? await q.exportStudy(account.id, params.get("export")!, true) : { ...await q.admin(account.id), hostedModel: quorumModelStatus() }); } catch(e) { return cabinetFailure(e); } }
export async function POST(request: Request) { try { requireCabinetOrigin(request); const { account } = await requireCabinetAccount(); const input = await cabinetJson(request); if (input && typeof input === "object" && "command" in input && input.command === "run_prediction") return cabinetResponse(await runQuorumPrediction(account.id, input)); return cabinetResponse(await configuredQuorum().adminCommand(account.id, input)); } catch(e) { return cabinetFailure(e); } }
