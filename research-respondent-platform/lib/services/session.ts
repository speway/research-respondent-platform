/**
 * Server-side session access.
 *
 * Session cookies are httpOnly and SameSite=Lax. Every page and server action
 * resolves the actor through `requireActor`, so no screen renders without an
 * authenticated, authorized identity.
 */
import { hostingMode } from "./hosting-policy.ts";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Db } from "../../db/index.ts";
import { getDb } from "../db-context.ts";
import {
  authenticate,
  buildActor,
  createSession,
  resolveSession,
  revokeSession,
  type UserRow,
} from "../repo/org.ts";
import { recordAudit } from "./audit.ts";
import type { Actor } from "../domain/types.ts";

export const SESSION_COOKIE = "rrp_session";

export interface AuthContext {
  db: Db;
  user: UserRow;
  actor: Actor;
  sessionId: string;
}

export async function getCurrentAuth(): Promise<AuthContext | null> {
  if (hostingMode(process.env) !== "persistent-local") return null;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }
  const db = getDb();
  const resolved = resolveSession(db, token);
  if (!resolved) {
    return null;
  }
  return {
    db,
    user: resolved.user,
    actor: buildActor(db, resolved.user),
    sessionId: resolved.session.id,
  };
}

export async function requireAuth(): Promise<AuthContext> {
  const auth = await getCurrentAuth();
  if (!auth) {
    redirect("/login");
  }
  return auth;
}

export async function signIn(input: {
  email: string;
  password: string;
  userAgent?: string | null;
  ipHint?: string | null;
}): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  if (hostingMode(process.env) !== "persistent-local") return { ok: false, reason: "Sign-in is disabled in this infrastructure preview." };
  const db = getDb();
  const user = authenticate(db, input.email, input.password);
  if (!user) {
    recordAudit(db, {
      organizationId:
        (db.prepare("SELECT id FROM organization ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id ??
        "unknown",
      actor: { type: "system", id: null, label: `anonymous:${input.email}`, roles: [], organizationId: "unknown", permissions: [] },
      action: "auth.sign_in",
      entityType: "app_user",
      entityId: null,
      outcome: "denied",
      severity: "warning",
      detail: { email: input.email, reason: "invalid_credentials_or_inactive" },
      ipHint: input.ipHint ?? null,
    });
    return { ok: false, reason: "E-mail or password is incorrect, or the account is inactive." };
  }
  const { token, session } = createSession(db, user.id, {
    userAgent: input.userAgent ?? null,
    ipHint: input.ipHint ?? null,
  });
  recordAudit(db, {
    organizationId: user.organization_id,
    actor: buildActor(db, user),
    action: "auth.sign_in",
    entityType: "auth_session",
    entityId: session.id,
    outcome: "success",
    detail: { email: user.email },
    ipHint: input.ipHint ?? null,
  });
  return { ok: true, token };
}

export async function signOut(token: string | undefined, actor: Actor | null): Promise<void> {
  if (!token) {
    return;
  }
  const db = getDb();
  const revoked = revokeSession(db, token);
  if (actor && revoked) {
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "auth.sign_out",
      entityType: "auth_session",
      entityId: null,
      outcome: "success",
    });
  }
}
