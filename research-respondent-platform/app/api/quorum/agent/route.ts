import { configuredQuorum } from "../../../../lib/services/quorum.ts";
import { CabinetError } from "../../../../lib/services/cabinet.ts";
import { cabinetFailure, cabinetJson, cabinetResponse } from "../../../../lib/services/cabinet-http.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function token(request: Request) { const auth = request.headers.get("authorization") ?? ""; if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw new CabinetError(401, "Нужен ключ сравнения."); return auth.slice(7); }
export async function GET(request: Request) { try { const key = token(request); return cabinetResponse(await configuredQuorum().agentTask(key)); } catch(e) { return cabinetFailure(e); } }
export async function POST(request: Request) { try { const key = token(request); if (!request.headers.get("content-type")?.startsWith("application/json")) throw new CabinetError(415, "Нужен JSON."); const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) throw new CabinetError(403, "Недопустимый источник запроса."); return cabinetResponse(await configuredQuorum().predict(key, await cabinetJson(request))); } catch(e) { return cabinetFailure(e); } }
