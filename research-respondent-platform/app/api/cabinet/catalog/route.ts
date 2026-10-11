import { z } from "zod";
import { cabinetFailure, cabinetJson, cabinetResponse, requireCabinetAccount, requireCabinetOrigin } from "../../../../lib/services/cabinet-http.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const command = z.discriminatedUnion("command", [
  z.object({ command: z.literal("upload"), file: z.unknown() }).strict(),
  z.object({ command: z.literal("project"), project: z.unknown() }).strict(),
  z.object({ command: z.literal("agent_key"), projectId: z.string().uuid() }).strict(),
  z.object({ command: z.literal("revoke_key"), keyId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ command: z.literal("snapshot"), projectId: z.string().uuid(), settings: z.unknown() }).strict(),
]);
export async function GET(request: Request) {
  try { const { cabinet, account } = await requireCabinetAccount(); const id = new URL(request.url).searchParams.get("project");
    return cabinetResponse(id ? await cabinet.bundle(account, id) : await cabinet.catalog(account)); }
  catch (error) { return cabinetFailure(error); }
}
export async function POST(request: Request) {
  try { requireCabinetOrigin(request); const { cabinet, account } = await requireCabinetAccount();
    const input = command.parse(await cabinetJson(request));
    if (input.command === "upload") return cabinetResponse({ asset: await cabinet.upload(account, input.file) }, 201);
    if (input.command === "project") return cabinetResponse({ project: await cabinet.createProject(account, input.project) }, 201);
    if (input.command === "agent_key") return cabinetResponse(await cabinet.agentKey(account, input.projectId), 201);
    if (input.command === "snapshot") return cabinetResponse({ project: await cabinet.saveSnapshot(account, input.projectId, input.settings) }, 201);
    await cabinet.revokeKey(account, input.keyId); return cabinetResponse({ revoked: true });
  } catch (error) { return cabinetFailure(error); }
}
