/**
 * Organization and user repository.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso } from "../util/ids.ts";
import { createSessionToken, hashPassword, sha256, verifyPassword } from "../services/password.ts";
import type { Actor } from "../domain/types.ts";
import { permissionsForRoles, type Permission } from "../services/authz.ts";

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  notes: string | null;
}

export interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  password_params: string;
  is_active: number;
  created_at: string;
  last_login_at: string | null;
}

export interface UserWithRoles extends Omit<UserRow, "password_hash" | "password_salt" | "password_params"> {
  roles: string[];
  studyScopes: string[];
}

export function createOrganization(db: Db, input: { name: string; slug?: string; notes?: string | null }): OrganizationRow {
  const slug = (input.slug ?? input.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "org";
  const existing = db.prepare("SELECT * FROM organization WHERE slug = ?").get(slug) as OrganizationRow | undefined;
  if (existing) {
    return existing;
  }
  const row: OrganizationRow = {
    id: newId("org"),
    name: input.name,
    slug,
    created_at: nowIso(),
    notes: input.notes ?? null,
  };
  db.prepare("INSERT INTO organization (id, name, slug, created_at, notes) VALUES (?, ?, ?, ?, ?)").run(
    row.id,
    row.name,
    row.slug,
    row.created_at,
    row.notes,
  );
  return row;
}

export function getOrganizationBySlug(db: Db, slug: string): OrganizationRow | undefined {
  return db.prepare("SELECT * FROM organization WHERE slug = ?").get(slug) as OrganizationRow | undefined;
}

export function getFirstOrganization(db: Db): OrganizationRow | undefined {
  return db.prepare("SELECT * FROM organization ORDER BY created_at LIMIT 1").get() as OrganizationRow | undefined;
}

export function listOrganizations(db: Db): OrganizationRow[] {
  return db.prepare("SELECT * FROM organization ORDER BY created_at").all() as OrganizationRow[];
}

export function createUser(
  db: Db,
  input: {
    organizationId: string;
    email: string;
    displayName: string;
    password: string;
    roles: Array<{ role: string; studyId?: string | null }>;
    createdBy?: string | null;
  },
): UserRow {
  const email = input.email.trim().toLowerCase();
  const existing = db.prepare("SELECT * FROM app_user WHERE email = ?").get(email) as UserRow | undefined;
  if (existing) {
    throw new Error(`A user with e-mail ${email} already exists.`);
  }
  const password = hashPassword(input.password);
  const row: UserRow = {
    id: newId("usr"),
    organization_id: input.organizationId,
    email,
    display_name: input.displayName.trim(),
    password_hash: password.hash,
    password_salt: password.salt,
    password_params: password.params,
    is_active: 1,
    created_at: nowIso(),
    last_login_at: null,
  };
  const insertUser = db.prepare(
    `INSERT INTO app_user (id, organization_id, email, display_name, password_hash, password_salt, password_params, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRole = db.prepare(
    `INSERT INTO role_assignment (id, user_id, role, study_id, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    insertUser.run(
      row.id,
      row.organization_id,
      row.email,
      row.display_name,
      row.password_hash,
      row.password_salt,
      row.password_params,
      row.is_active,
      row.created_at,
    );
    for (const assignment of input.roles) {
      insertRole.run(
        newId("rol"),
        row.id,
        assignment.role,
        assignment.studyId ?? null,
        input.createdBy ?? null,
        nowIso(),
      );
    }
  });
  tx();
  return row;
}

export function getUserByEmail(db: Db, email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM app_user WHERE email = ?").get(email.trim().toLowerCase()) as UserRow | undefined;
}

export function getUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM app_user WHERE id = ?").get(id) as UserRow | undefined;
}

export function listUsers(db: Db, organizationId: string): UserWithRoles[] {
  const users = db
    .prepare("SELECT * FROM app_user WHERE organization_id = ? ORDER BY display_name")
    .all(organizationId) as UserRow[];
  return users.map((user) => decorateUser(db, user));
}

export function decorateUser(db: Db, user: UserRow): UserWithRoles {
  const roles = db
    .prepare("SELECT role, study_id FROM role_assignment WHERE user_id = ? AND revoked_at IS NULL")
    .all(user.id) as Array<{ role: string; study_id: string | null }>;
  const { password_hash: _hash, password_salt: _salt, password_params: _params, ...rest } = user;
  return {
    ...rest,
    roles: roles.map((row) => row.role),
    studyScopes: roles.filter((row) => row.study_id !== null).map((row) => row.study_id as string),
  };
}

export function authenticate(db: Db, email: string, password: string): UserRow | null {
  const user = getUserByEmail(db, email);
  if (!user || user.is_active !== 1) {
    return null;
  }
  const ok = verifyPassword(password, {
    hash: user.password_hash,
    salt: user.password_salt,
    params: user.password_params,
  });
  return ok ? user : null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  user_agent: string | null;
  ip_hint: string | null;
}

export function createSession(
  db: Db,
  userId: string,
  options: { ttlHours?: number; userAgent?: string | null; ipHint?: string | null } = {},
): { token: string; session: SessionRow } {
  const { token, tokenHash } = createSessionToken();
  const ttlHours = options.ttlHours ?? 12;
  const session: SessionRow = {
    id: newId("ses"),
    user_id: userId,
    token_hash: tokenHash,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
    revoked_at: null,
    user_agent: options.userAgent ?? null,
    ip_hint: options.ipHint ?? null,
  };
  db.prepare(
    `INSERT INTO auth_session (id, user_id, token_hash, created_at, expires_at, revoked_at, user_agent, ip_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.user_id,
    session.token_hash,
    session.created_at,
    session.expires_at,
    session.revoked_at,
    session.user_agent,
    session.ip_hint,
  );
  db.prepare("UPDATE app_user SET last_login_at = ? WHERE id = ?").run(session.created_at, userId);
  return { token, session };
}

export function resolveSession(db: Db, token: string): { session: SessionRow; user: UserRow } | null {
  const tokenHash = sha256(token);
  const session = db
    .prepare("SELECT * FROM auth_session WHERE token_hash = ?")
    .get(tokenHash) as SessionRow | undefined;
  if (!session || session.revoked_at !== null) {
    return null;
  }
  if (!Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.now()) {
    return null;
  }
  const user = getUserById(db, session.user_id);
  if (!user || user.is_active !== 1) {
    return null;
  }
  return { session, user };
}

export function revokeSession(db: Db, token: string): boolean {
  const result = db
    .prepare("UPDATE auth_session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .run(nowIso(), sha256(token));
  return result.changes > 0;
}

export function revokeAllSessions(db: Db, userId: string): number {
  const result = db
    .prepare("UPDATE auth_session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(nowIso(), userId);
  return result.changes;
}

export function grantAccess(
  db: Db,
  input: {
    userId: string;
    scopeType: "study" | "private_identity" | "export" | "integration";
    scopeId?: string | null;
    permission: "read" | "write" | "approve" | "export";
    grantedBy?: string | null;
    expiresAt?: string | null;
    reason?: string | null;
  },
): string {
  const id = newId("agr");
  db.prepare(
    `INSERT INTO access_grant (id, user_id, scope_type, scope_id, permission, granted_by, granted_at, expires_at, revoked_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    input.userId,
    input.scopeType,
    input.scopeId ?? null,
    input.permission,
    input.grantedBy ?? null,
    nowIso(),
    input.expiresAt ?? null,
    input.reason ?? null,
  );
  return id;
}

export interface AccessGrantRow {
  id: string;
  user_id: string;
  scope_type: string;
  scope_id: string | null;
  permission: string;
  granted_by: string | null;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  reason: string | null;
}

export function listAccessGrants(db: Db, userId?: string): AccessGrantRow[] {
  if (userId) {
    return db
      .prepare("SELECT * FROM access_grant WHERE user_id = ? ORDER BY granted_at DESC")
      .all(userId) as AccessGrantRow[];
  }
  return db.prepare("SELECT * FROM access_grant ORDER BY granted_at DESC").all() as AccessGrantRow[];
}

export function revokeAccessGrant(db: Db, grantId: string): boolean {
  const result = db
    .prepare("UPDATE access_grant SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(nowIso(), grantId);
  return result.changes > 0;
}

/**
 * Builds the effective actor for a user: role permissions plus explicit
 * study-scoped grants. Agents never receive identity permissions.
 */
export function buildActor(db: Db, user: UserRow): Actor {
  const decorated = decorateUser(db, user);
  const assignments = db.prepare("SELECT role, study_id FROM role_assignment WHERE user_id = ? AND revoked_at IS NULL")
    .all(user.id) as Array<{ role: string; study_id: string | null }>;
  const permissions = new Set<Permission>();
  const permissionStudyScopes: Record<string, string[]> = {};
  const globalPermissions = new Set<string>();
  for (const assignment of assignments) {
    for (const permission of permissionsForRoles([assignment.role])) {
      const consequential = permission.endsWith(":write") || permission.endsWith(":approve") ||
        permission === "task:execute" || permission === "export:create" || permission === "import:commit";
      if (consequential && assignment.study_id) {
        (permissionStudyScopes[permission] ??= []).push(assignment.study_id);
        if (permission.endsWith(":write") && permission !== "agent:write") permissions.add(`study:${assignment.study_id}:write` as Permission);
      } else if (!assignment.study_id) globalPermissions.add(permission);
      // A study-owned PI is not an organization-wide study administrator.
      if (permission === "study:write" && assignment.study_id) {
        permissions.add(`study:${assignment.study_id}:write` as Permission);
      } else {
        permissions.add(permission);
      }
    }
  }
  for (const permission of globalPermissions) delete permissionStudyScopes[permission];
  const grants = db
    .prepare(
      `SELECT scope_type, scope_id, permission FROM access_grant
       WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(user.id, nowIso()) as Array<{ scope_type: string; scope_id: string | null; permission: string }>;
  for (const grant of grants) {
    if (grant.scope_type === "study" && grant.scope_id) {
      permissions.add(`study:${grant.scope_id}:${grant.permission === "approve" ? "write" : grant.permission}` as Permission);
      if (grant.permission === "write" || grant.permission === "approve") {
        for (const scopes of Object.values(permissionStudyScopes)) if (!scopes.includes(grant.scope_id)) scopes.push(grant.scope_id);
      }
    }
    if (grant.scope_type === "private_identity") {
      const permission = grant.permission === "write" ? "identity:write" : "identity:read";
      permissions.add(permission);
      delete permissionStudyScopes[permission];
    }
    if (grant.scope_type === "export") {
      const permission = grant.permission === "approve" ? "export:approve" : "export:create";
      permissions.add(permission);
      delete permissionStudyScopes[permission];
    }
    if (grant.scope_type === "integration") {
      permissions.add("agent:write");
      delete permissionStudyScopes["agent:write"];
    }
  }
  return {
    type: "user",
    id: user.id,
    label: user.email,
    roles: decorated.roles,
    organizationId: user.organization_id,
    permissions: [...permissions].sort(),
    permissionStudyScopes,
  };
}

export function systemActor(organizationId: string, label = "system"): Actor {
  return {
    type: "system",
    id: null,
    label,
    roles: ["admin"],
    organizationId,
    permissions: permissionsForRoles(["admin"]),
  };
}

export function agentActor(input: {
  organizationId: string;
  agentId: string;
  agentName: string;
  capabilities: string[];
}): Actor {
  const permissions = ["study:read", "participant:read", "mapping:read", "agent:read", "audit:read"];
  if (input.capabilities.includes("submit_external_response")) {
    permissions.push("task:execute");
  }
  return {
    type: "agent",
    id: input.agentId,
    label: input.agentName,
    roles: ["agent_operator"],
    organizationId: input.organizationId,
    permissions,
  };
}
