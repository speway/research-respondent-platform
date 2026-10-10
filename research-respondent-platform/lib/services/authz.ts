/**
 * Authorization layer.
 *
 * Every consequential operation goes through `authorize`, which returns a
 * decision instead of throwing so callers can audit denials explicitly.
 */
import type { Actor, AuthorizationDecision, RuleIssue } from "../domain/types.ts";
import { DomainError } from "../domain/types.ts";

export const PERMISSIONS = {
  studyRead: "study:read",
  studyWrite: "study:write",
  participantRead: "participant:read",
  participantWrite: "participant:write",
  identityRead: "identity:read",
  identityWrite: "identity:write",
  consentWrite: "consent:write",
  instrumentRead: "instrument:read",
  instrumentWrite: "instrument:write",
  assessmentRead: "assessment:read",
  assessmentWrite: "assessment:write",
  scoreWrite: "score:write",
  cohortRead: "cohort:read",
  cohortWrite: "cohort:write",
  mappingRead: "mapping:read",
  mappingWrite: "mapping:write",
  mappingApprove: "mapping:approve",
  agentRead: "agent:read",
  agentWrite: "agent:write",
  taskApprove: "task:approve",
  taskExecute: "task:execute",
  auditRead: "audit:read",
  exportCreate: "export:create",
  exportApprove: "export:approve",
  settingsWrite: "settings:write",
  importCommit: "import:commit",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: Object.values(PERMISSIONS) as Permission[],
  principal_investigator: [
    PERMISSIONS.studyRead,
    PERMISSIONS.studyWrite,
    PERMISSIONS.participantRead,
    PERMISSIONS.participantWrite,
    PERMISSIONS.consentWrite,
    PERMISSIONS.instrumentRead,
    PERMISSIONS.instrumentWrite,
    PERMISSIONS.assessmentRead,
    PERMISSIONS.assessmentWrite,
    PERMISSIONS.scoreWrite,
    PERMISSIONS.cohortRead,
    PERMISSIONS.cohortWrite,
    PERMISSIONS.mappingRead,
    PERMISSIONS.mappingWrite,
    PERMISSIONS.mappingApprove,
    PERMISSIONS.agentRead,
    PERMISSIONS.agentWrite,
    PERMISSIONS.taskApprove,
    PERMISSIONS.taskExecute,
    PERMISSIONS.auditRead,
    PERMISSIONS.exportCreate,
    PERMISSIONS.exportApprove,
    PERMISSIONS.importCommit,
    // Note: identity:read is deliberately absent. It is granted per user.
  ],
  researcher: [
    PERMISSIONS.studyRead,
    PERMISSIONS.participantRead,
    PERMISSIONS.participantWrite,
    PERMISSIONS.consentWrite,
    PERMISSIONS.instrumentRead,
    PERMISSIONS.assessmentRead,
    PERMISSIONS.assessmentWrite,
    PERMISSIONS.scoreWrite,
    PERMISSIONS.cohortRead,
    PERMISSIONS.cohortWrite,
    PERMISSIONS.mappingRead,
    PERMISSIONS.mappingWrite,
    PERMISSIONS.agentRead,
    PERMISSIONS.auditRead,
    PERMISSIONS.exportCreate,
    PERMISSIONS.importCommit,
  ],
  data_steward: [
    PERMISSIONS.studyRead,
    PERMISSIONS.participantRead,
    PERMISSIONS.identityRead,
    PERMISSIONS.identityWrite,
    PERMISSIONS.consentWrite,
    PERMISSIONS.auditRead,
    PERMISSIONS.exportCreate,
    PERMISSIONS.exportApprove,
    PERMISSIONS.settingsWrite,
  ],
  reviewer: [
    PERMISSIONS.studyRead,
    PERMISSIONS.participantRead,
    PERMISSIONS.assessmentRead,
    PERMISSIONS.cohortRead,
    PERMISSIONS.mappingRead,
    PERMISSIONS.mappingApprove,
    PERMISSIONS.agentRead,
    PERMISSIONS.taskApprove,
    PERMISSIONS.auditRead,
  ],
  agent_operator: [
    PERMISSIONS.studyRead,
    PERMISSIONS.participantRead,
    PERMISSIONS.mappingRead,
    PERMISSIONS.agentRead,
    PERMISSIONS.agentWrite,
    PERMISSIONS.taskExecute,
    PERMISSIONS.auditRead,
  ],
  viewer: [
    PERMISSIONS.studyRead,
    PERMISSIONS.participantRead,
    PERMISSIONS.instrumentRead,
    PERMISSIONS.assessmentRead,
    PERMISSIONS.cohortRead,
    PERMISSIONS.mappingRead,
    PERMISSIONS.agentRead,
    PERMISSIONS.auditRead,
  ],
};

export function permissionsForRoles(roles: string[]): Permission[] {
  const set = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) {
      set.add(permission);
    }
  }
  return [...set].sort();
}

export function actorHasPermission(actor: Actor, permission: Permission): boolean {
  return actor.permissions.includes(permission);
}

export function authorize(actor: Actor, permission: Permission, subject?: { studyId?: string | null }): AuthorizationDecision {
  if (!actorHasPermission(actor, permission)) {
    return {
      allowed: false,
      reason: `Role set [${actor.roles.join(", ") || "none"}] does not include ${permission}.`,
      missingPermission: permission,
      policyCode: "rbac.missing_permission",
    };
  }
  const restricted: readonly Permission[] = [
    PERMISSIONS.identityRead,
    PERMISSIONS.identityWrite,
    PERMISSIONS.exportApprove,
    PERMISSIONS.mappingApprove,
  ];
  if (restricted.includes(permission) && actor.type === "agent") {
    return {
      allowed: false,
      reason: `Agents may not exercise ${permission}; human approval is required.`,
      missingPermission: permission,
      policyCode: "rbac.agent_forbidden",
    };
  }
  if (subject?.studyId) {
    const scoped = actor.permissions.includes(`study:${subject.studyId}:write`);
    const globalWrite = actor.permissions.includes(PERMISSIONS.studyWrite);
    // Agent registration is organization-scoped; it is not a write to a study's research data.
    const writeIntent = (permission.endsWith(":write") && permission !== PERMISSIONS.agentWrite) || permission === PERMISSIONS.importCommit;
    if (writeIntent && !scoped && !globalWrite) {
      return {
        allowed: false,
        reason: `No write grant recorded for study ${subject.studyId}.`,
        missingPermission: `study:${subject.studyId}:write`,
        policyCode: "rbac.study_scope",
      };
    }
  }
  return { allowed: true, reason: `Granted by ${permission}.`, policyCode: "rbac.allowed" };
}

export function assertAuthorized(
  actor: Actor,
  permission: Permission,
  subject?: { studyId?: string | null },
): void {
  const decision = authorize(actor, permission, subject);
  if (!decision.allowed) {
    throw new DomainError("auth.denied", decision.reason, {
      policyCode: decision.policyCode,
      permission,
      actorLabel: actor.label,
    });
  }
}

/** Consent gate used before export, assignment or any external submission. */
export function requireActiveConsent(
  consents: Array<{ status: string; studyId: string | null; withdrawnAt: string | null; expiresAt: string | null; version: string }>,
  studyId: string | null,
  at: string,
): AuthorizationDecision {
  const relevant = consents.filter((consent) => consent.studyId === studyId || consent.studyId === null);
  if (relevant.length === 0) {
    return {
      allowed: false,
      reason: studyId
        ? `No consent record on file for study ${studyId}.`
        : "No study-level or global consent record on file.",
      policyCode: "consent.absent",
    };
  }
  const atTime = Date.parse(at);
  const active = relevant.find((consent) => {
    if (consent.status !== "granted") {
      return false;
    }
    if (consent.withdrawnAt !== null) {
      return false;
    }
    if (consent.expiresAt !== null && Number.isFinite(Date.parse(consent.expiresAt)) && Date.parse(consent.expiresAt) < atTime) {
      return false;
    }
    return true;
  });
  if (!active) {
    const withdrawn = relevant.find((consent) => consent.status === "withdrawn");
    return {
      allowed: false,
      reason: withdrawn
        ? `Consent version ${withdrawn.version} was withdrawn${withdrawn.withdrawnAt ? ` on ${withdrawn.withdrawnAt}` : ""}.`
        : `Latest consent status is "${relevant[0]?.status ?? "unknown"}"; only "granted" permits export or submission.`,
      policyCode: withdrawn ? "consent.withdrawn" : "consent.inactive",
    };
  }
  return {
    allowed: true,
    reason: `Consent version ${active.version} is active.`,
    policyCode: "consent.active",
  };
}

export function roleIssues(roles: string[]): RuleIssue[] {
  const known = Object.keys(ROLE_PERMISSIONS);
  return roles
    .filter((role) => !known.includes(role))
    .map((role) => ({
      code: "rbac.unknown_role",
      severity: "fail" as const,
      message: `Unknown role "${role}". Known roles: ${known.join(", ")}.`,
      detail: { role },
    }));
}

export const KNOWN_ROLES = Object.keys(ROLE_PERMISSIONS);
