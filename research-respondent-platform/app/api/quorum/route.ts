import { requireQuorumPerson } from "../../../lib/services/quorum-http.ts";
import { cabinetFailure, cabinetJson, cabinetResponse, requireCabinetOrigin } from "../../../lib/services/cabinet-http.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { const { quorum, person } = await requireQuorumPerson(), study = new URL(request.url).searchParams.get("export"); return cabinetResponse(study ? await quorum.exportStudy(person.id, study) : await quorum.dashboard(person.id)); } catch(e) { return cabinetFailure(e); } }
export async function POST(request: Request) { try { requireCabinetOrigin(request); const { quorum, person } = await requireQuorumPerson(); return cabinetResponse(await quorum.studentCommand(person.id, await cabinetJson(request))); } catch(e) { return cabinetFailure(e); } }
