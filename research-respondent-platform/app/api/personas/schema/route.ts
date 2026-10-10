import { NextResponse } from "next/server";
import { personaModelContract } from "../../../../lib/domain/personas.ts";
import { getCurrentAuth } from "../../../../lib/services/session.ts";
import { authorize, PERMISSIONS } from "../../../../lib/services/authz.ts";

export const dynamic = "force-dynamic";

/** Model dictionary only. Generation transport is supplied outside Next.js. */
export async function GET() {
  const auth = await getCurrentAuth();
  if (!auth) return NextResponse.json({ error: "auth.required" }, { status: 401 });
  if (!authorize(auth.actor, PERMISSIONS.agentRead).allowed) {
    return NextResponse.json({ error: "auth.denied" }, { status: 403 });
  }
  return NextResponse.json(personaModelContract(), { headers: { "Cache-Control": "private, no-store" } });
}
