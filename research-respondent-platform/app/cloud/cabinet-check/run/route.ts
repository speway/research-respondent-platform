import { cabinetProofEnabled, runCabinetProof } from "../../../../lib/services/cabinet-proof.ts";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!cabinetProofEnabled()) return new Response("Not found", { status: 404 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response("Forbidden", { status: 403 });
  try { await runCabinetProof(); return Response.redirect(new URL("/cloud/cabinet-check", request.url), 303); }
  catch { return new Response("Verification incomplete. Inspect the private reservation before any further action.", { status: 503 }); }
}
