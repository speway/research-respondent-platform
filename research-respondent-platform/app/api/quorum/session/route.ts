import { cookies } from "next/headers";
import { z } from "zod";
import { configuredQuorum, QUORUM_COOKIE } from "../../../../lib/services/quorum.ts";
import { requireQuorumPerson } from "../../../../lib/services/quorum-http.ts";
import { cabinetFailure, cabinetJson, cabinetResponse, requireCabinetOrigin } from "../../../../lib/services/cabinet-http.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const inputSchema = z.discriminatedUnion("command", [z.object({ command: z.literal("login"), login: z.string().max(100), password: z.string().max(128) }).strict(), z.object({ command: z.literal("activate"), invitationToken: z.string().max(100), password: z.string().min(10).max(128), age18: z.literal(true), terms: z.literal(true) }).strict()]);
export async function GET() { try { const { person } = await requireQuorumPerson(); return cabinetResponse({ person }); } catch(e) { return cabinetFailure(e); } }
export async function POST(request: Request) { try { requireCabinetOrigin(request); const input = inputSchema.parse(await cabinetJson(request)), q = configuredQuorum();
  const result = input.command === "login" ? await q.login(input.login, input.password) : await q.activate(input.invitationToken, input.password, input.age18, input.terms);
  (await cookies()).set(QUORUM_COOKIE, result.token, { httpOnly: true, secure: process.env.VERCEL === "1" || process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 8 * 3600 });
  return cabinetResponse({ person: result.person }); } catch(e) { return cabinetFailure(e); } }
export async function DELETE(request: Request) { try { requireCabinetOrigin(request); const jar = await cookies(); await configuredQuorum().logout(jar.get(QUORUM_COOKIE)?.value); jar.delete(QUORUM_COOKIE); return cabinetResponse({ signedOut: true }); } catch(e) { return cabinetFailure(e); } }
