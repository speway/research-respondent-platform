import { CabinetError, configuredCabinet } from "../../../../lib/services/cabinet.ts";
import { cabinetFailure, cabinetResponse, privateHeaders } from "../../../../lib/services/cabinet-http.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new CabinetError(401, "Передайте ключ проекта в Authorization: Bearer.");
    const cabinet = configuredCabinet(); const token = authorization.slice(7);
    const params = new URL(request.url).searchParams;
    const lineageId = params.get("lineage");
    if (lineageId) return cabinetResponse(await cabinet.forAgentLineage(token, lineageId));
    const assetId = params.get("asset");
    if (assetId) {
      const file = await cabinet.forAgentFile(token, assetId);
      return new Response(Buffer.from(file.body.base64, "base64"), { headers: { ...privateHeaders,
        "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.meta.name)}` } });
    }
    return cabinetResponse(await cabinet.forAgent(token)); }
  catch (error) { return cabinetFailure(error); }
}
