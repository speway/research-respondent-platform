"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { signIn, signOut, SESSION_COOKIE, getCurrentAuth } from "../../lib/services/session.ts";
import { getDb } from "../../lib/db-context.ts";
import { getFirstOrganization } from "../../lib/repo/org.ts";

export interface LoginState {
  error?: string;
  ok?: boolean;
}

export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "E-mail and password are required." };
  }
  const headerList = await headers();
  const result = await signIn({
    email,
    password,
    userAgent: headerList.get("user-agent"),
    ipHint: headerList.get("x-forwarded-for"),
  });
  if (!result.ok) {
    return { error: result.reason };
  }
  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 3600,
  });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const auth = await getCurrentAuth();
  await signOut(token, auth?.actor ?? null);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}

export async function firstRunAction(): Promise<LoginState> {
  const db = getDb();
  const organization = getFirstOrganization(db);
  if (!organization) {
    return {
      error:
        "No organization exists yet. Run `npm run bootstrap -- --org \"<name>\" --email \"<admin e-mail>\" --password \"<password>\"` from the project directory to create the first administrator.",
    };
  }
  const users = db.prepare("SELECT COUNT(*) AS total FROM app_user WHERE organization_id = ?").get(organization.id) as {
    total: number;
  };
  if (users.total === 0) {
    return {
      error:
        "The organization exists but has no users. Run `npm run bootstrap -- --org \"<name>\" --email \"<admin e-mail>\" --password \"<password>\"` to create the first administrator.",
    };
  }
  return { ok: true };
}
