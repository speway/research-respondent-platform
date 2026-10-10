/**
 * First-run bootstrap: organization, administrator and retention defaults.
 *
 * Deliberately creates no participants, no instrument responses and no scores.
 * The research tables stay empty until real documented data is imported.
 */
import type { Db } from "../../db/index.ts";
import { createOrganization, createUser, getFirstOrganization, getUserByEmail } from "../repo/org.ts";
import { upsertRetentionPolicy } from "../repo/exports.ts";
import { recordAudit } from "./audit.ts";
import { permissionsForRoles } from "./authz.ts";

export interface BootstrapInput {
  organizationName: string;
  slug?: string;
  adminEmail: string;
  adminPassword: string;
  adminDisplayName?: string;
  createDemoData?: boolean;
}

export interface BootstrapResult {
  organizationId: string;
  organizationName: string;
  adminUserId: string;
  createdOrganization: boolean;
  createdAdmin: boolean;
}

export function bootstrap(db: Db, input: BootstrapInput): BootstrapResult {
  const existingOrganization = getFirstOrganization(db);
  const organization =
    existingOrganization ??
    createOrganization(db, { name: input.organizationName, slug: input.slug, notes: "Created by bootstrap." });

  let createdAdmin = false;
  let admin = getUserByEmail(db, input.adminEmail);
  if (!admin) {
    admin = createUser(db, {
      organizationId: organization.id,
      email: input.adminEmail,
      displayName: input.adminDisplayName ?? input.adminEmail.split("@")[0] ?? "Administrator",
      password: input.adminPassword,
      roles: [{ role: "admin" }],
      createdBy: null,
    });
    createdAdmin = true;
  }

  const systemActorForAudit = {
    type: "system" as const,
    id: admin.id,
    label: "bootstrap",
    roles: ["admin"],
    organizationId: organization.id,
    permissions: permissionsForRoles(["admin"]),
  };

  upsertRetentionPolicy(db, {
    organizationId: organization.id,
    entityType: "participant_private_identity",
    retentionMonths: 60,
    actionOnExpiry: "review",
    lawfulBasis: "Institutional research retention schedule; review before deletion.",
    updatedBy: admin.id,
  });
  upsertRetentionPolicy(db, {
    organizationId: organization.id,
    entityType: "audit_event",
    retentionMonths: 120,
    actionOnExpiry: "review",
    lawfulBasis: "Auditability of research data processing.",
    updatedBy: admin.id,
  });

  recordAudit(db, {
    organizationId: organization.id,
    actor: systemActorForAudit,
    action: "system.bootstrap",
    entityType: "organization",
    entityId: organization.id,
    outcome: "success",
    severity: "notice",
    detail: {
      createdOrganization: existingOrganization === undefined,
      createdAdmin,
      adminEmail: admin.email,
      note: "No research data seeded. Participants and responses must be imported from documented sources.",
      demoDataRequested: input.createDemoData === true,
    },
  });

  return {
    organizationId: organization.id,
    organizationName: organization.name,
    adminUserId: admin.id,
    createdOrganization: existingOrganization === undefined,
    createdAdmin,
  };
}
