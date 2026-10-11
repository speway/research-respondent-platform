import { cookies } from "next/headers";
import { z } from "zod";
import { CABINET_COOKIE, configuredCabinet } from "../../../../lib/services/cabinet.ts";
import { cabinetFailure, cabinetJson, cabinetResponse, requireCabinetAccount, requireCabinetOrigin } from "../../../../lib/services/cabinet-http.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { const { account } = await requireCabinetAccount(); return cabinetResponse({ account: { id: account.id, label: account.label } }); }
  catch (error) { return cabinetFailure(error); }
}
export async function POST(request: Request) {
  try {
    requireCabinetOrigin(request);
    const input = z.object({ login: z.string().max(100), password: z.string().max(128) }).strict().parse(await cabinetJson(request));
    const result = await configuredCabinet().login(input.login, input.password);
    (await cookies()).set(CABINET_COOKIE, result.token, { httpOnly: true, secure: process.env.VERCEL === "1" || process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 8 * 3600 });
    return cabinetResponse({ account: result.account });
  } catch (error) { return cabinetFailure(error); }
}
export async function DELETE(request: Request) {
  try { requireCabinetOrigin(request); const jar = await cookies(); await configuredCabinet().logout(jar.get(CABINET_COOKIE)?.value);
    jar.delete(CABINET_COOKIE); return cabinetResponse({ signedOut: true }); }
  catch (error) { return cabinetFailure(error); }
}
