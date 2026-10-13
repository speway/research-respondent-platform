import { simulationCommandSchema } from "../../../../lib/domain/simulation-lab.ts";
import { configuredSimulationLab } from "../../../../lib/services/simulation-lab.ts";
import { cabinetFailure, cabinetJson, cabinetResponse, requireCabinetAccount, requireCabinetOrigin } from "../../../../lib/services/cabinet-http.ts";
import { CabinetError } from "../../../../lib/services/cabinet.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  try { const lab = configuredSimulationLab(), auth = request.headers.get("authorization");
    if (auth !== null) { if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw new CabinetError(401, "Нужен ключ лаборатории."); return cabinetResponse(await lab.forAgent(auth.slice(7))); }
    const { account } = await requireCabinetAccount(), asset = new URL(request.url).searchParams.get("asset");
    return cabinetResponse(asset ? await lab.cohort(account, asset) : { grants: await lab.grants(account) });
  } catch (error) { return cabinetFailure(error); }
}
export async function POST(request: Request) {
  try { requireCabinetOrigin(request); const { account } = await requireCabinetAccount(), lab = configuredSimulationLab(), input = simulationCommandSchema.parse(await cabinetJson(request));
    if (input.command === "generate") return cabinetResponse(await lab.generate(account, input.config), 201);
    if (input.command === "reliability") return cabinetResponse(await lab.measure(account, input.request));
    if (input.command === "agent_key") return cabinetResponse(await lab.key(account, input.assetId), 201);
    await lab.revoke(account, input.keyId); return cabinetResponse({ revoked: true });
  } catch (error) { return cabinetFailure(error); }
}
