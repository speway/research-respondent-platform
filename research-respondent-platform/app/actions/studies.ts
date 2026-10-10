"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "../../lib/services/session.ts";
import { PERMISSIONS, assertAuthorized } from "../../lib/services/authz.ts";
import { recordAudit } from "../../lib/services/audit.ts";
import {
  createCriterion,
  createProtocolVersion,
  createStudy,
  deleteCriterion,
  enrolParticipant,
  getStudy,
  setEnrolmentStatus,
  updateStudy,
} from "../../lib/repo/studies.ts";
import { listParticipants } from "../../lib/repo/participants.ts";
import { parseRule } from "../../lib/domain/cohort.ts";
import { DomainError } from "../../lib/domain/types.ts";

export interface ActionResult {
  ok: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

function failure(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, message: `${error.code}: ${error.message}`, detail: error.detail };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, message };
}

const studySchema = z.object({
  code: z.string().trim().min(2).max(24).regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, dash or underscore."),
  title: z.string().trim().min(3).max(200),
  researchQuestion: z.string().trim().min(10).max(4000),
  principalEmail: z.string().trim().email().optional().or(z.literal("")),
});

export async function createStudyAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.studyWrite);
    const parsed = studySchema.safeParse({
      code: formData.get("code"),
      title: formData.get("title"),
      researchQuestion: formData.get("researchQuestion"),
      principalEmail: formData.get("principalEmail") ?? "",
    });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
    }
    const study = createStudy(db, {
      organizationId: actor.organizationId,
      code: parsed.data.code,
      title: parsed.data.title,
      researchQuestion: parsed.data.researchQuestion,
      principalEmail: parsed.data.principalEmail || null,
      createdBy: actor.id,
      status: "draft",
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "study.create",
      entityType: "study",
      entityId: study.id,
      studyId: study.id,
      outcome: "success",
      detail: { code: study.code, title: study.title },
    });
    revalidatePath("/studies");
    revalidatePath("/");
    return { ok: true, message: `Study ${study.code} created in draft status.`, detail: { studyId: study.id } };
  } catch (error) {
    return failure(error);
  }
}

export async function updateStudyAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    assertAuthorized(actor, PERMISSIONS.studyWrite, { studyId });
    const status = String(formData.get("status") ?? "");
    const parsed = z
      .object({
        title: z.string().trim().min(3).max(200),
        researchQuestion: z.string().trim().min(10).max(4000),
        status: z.enum(["draft", "active", "paused", "closed", "archived"]),
      })
      .safeParse({
        title: formData.get("title"),
        researchQuestion: formData.get("researchQuestion"),
        status,
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    const before = getStudy(db, studyId);
    updateStudy(db, studyId, {
      title: parsed.data.title,
      research_question: parsed.data.researchQuestion,
      status: parsed.data.status,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "study.update",
      entityType: "study",
      entityId: studyId,
      studyId,
      outcome: "success",
      detail: { before: before ? { title: before.title, status: before.status } : null, after: parsed.data },
    });
    revalidatePath(`/studies/${studyId}`);
    revalidatePath("/studies");
    return { ok: true, message: "Study updated." };
  } catch (error) {
    return failure(error);
  }
}

export async function createProtocolAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    assertAuthorized(actor, PERMISSIONS.studyWrite, { studyId });
    const parsed = z
      .object({
        versionLabel: z.string().trim().min(1).max(40),
        designSummary: z.string().trim().max(4000).optional(),
        inclusionCriteria: z.string().trim().max(4000).optional(),
        exclusionCriteria: z.string().trim().max(4000).optional(),
        ethicalApproval: z.string().trim().max(1000).optional(),
        consentTemplate: z.string().trim().max(4000).optional(),
        dataAccessNotes: z.string().trim().max(2000).optional(),
      })
      .safeParse({
        versionLabel: formData.get("versionLabel"),
        designSummary: formData.get("designSummary") ?? "",
        inclusionCriteria: formData.get("inclusionCriteria") ?? "",
        exclusionCriteria: formData.get("exclusionCriteria") ?? "",
        ethicalApproval: formData.get("ethicalApproval") ?? "",
        consentTemplate: formData.get("consentTemplate") ?? "",
        dataAccessNotes: formData.get("dataAccessNotes") ?? "",
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    const protocol = createProtocolVersion(db, {
      studyId,
      versionLabel: parsed.data.versionLabel,
      designSummary: parsed.data.designSummary || null,
      inclusionCriteria: parsed.data.inclusionCriteria || null,
      exclusionCriteria: parsed.data.exclusionCriteria || null,
      ethicalApproval: parsed.data.ethicalApproval || null,
      consentTemplate: parsed.data.consentTemplate || null,
      dataAccessNotes: parsed.data.dataAccessNotes || null,
      approvedBy: actor.id,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "study.protocol.create",
      entityType: "study_protocol_version",
      entityId: protocol.id,
      studyId,
      outcome: "success",
      severity: "notice",
      detail: { versionLabel: protocol.version_label, supersedes: protocol.supersedes_id },
    });
    revalidatePath(`/studies/${studyId}`);
    return { ok: true, message: `Protocol version ${protocol.version_label} recorded.` };
  } catch (error) {
    return failure(error);
  }
}

export async function createCriterionAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    assertAuthorized(actor, PERMISSIONS.studyWrite, { studyId });
    const label = String(formData.get("label") ?? "").trim();
    const kind = String(formData.get("kind") ?? "inclusion");
    const ruleJson = String(formData.get("ruleJson") ?? "").trim();
    if (!label) {
      return { ok: false, message: "A human-readable label is required; it is what the eligibility explanation shows." };
    }
    if (kind !== "inclusion" && kind !== "exclusion") {
      return { ok: false, message: "kind must be inclusion or exclusion." };
    }
    let rawRule: unknown;
    try {
      rawRule = JSON.parse(ruleJson);
    } catch {
      return { ok: false, message: "The rule must be valid JSON, e.g. {\"subject\":\"consent\",\"operator\":\"consent_status\",\"value\":\"granted\"}." };
    }
    const rule = parseRule(rawRule);
    const criterion = createCriterion(db, {
      studyId,
      kind,
      label,
      rule,
      rationale: String(formData.get("rationale") ?? "") || null,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "study.criterion.create",
      entityType: "recruitment_criterion",
      entityId: criterion.id,
      studyId,
      outcome: "success",
      detail: { kind, label, rule },
    });
    revalidatePath(`/studies/${studyId}`);
    return { ok: true, message: `Criterion "${label}" added.` };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteCriterionAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    const criterionId = String(formData.get("criterionId") ?? "");
    assertAuthorized(actor, PERMISSIONS.studyWrite, { studyId });
    const removed = deleteCriterion(db, criterionId);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "study.criterion.delete",
      entityType: "recruitment_criterion",
      entityId: criterionId,
      studyId,
      outcome: removed ? "success" : "failure",
      severity: "warning",
      detail: { criterionId },
    });
    revalidatePath(`/studies/${studyId}`);
    return { ok: removed, message: removed ? "Criterion removed." : "Criterion not found." };
  } catch (error) {
    return failure(error);
  }
}

export async function enrolParticipantAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    const participantId = String(formData.get("participantId") ?? "");
    assertAuthorized(actor, PERMISSIONS.participantWrite, { studyId });
    const participant = db.prepare("SELECT pseudonym FROM participant WHERE id = ?").get(participantId) as
      | { pseudonym: string }
      | undefined;
    if (!participant) {
      return { ok: false, message: "Participant not found." };
    }
    const consent = db
      .prepare(
        `SELECT status FROM consent_record WHERE participant_id = ? AND (study_id = ? OR study_id IS NULL)
         ORDER BY recorded_at DESC LIMIT 1`,
      )
      .get(participantId, studyId) as { status: string } | undefined;
    if (!consent || consent.status !== "granted") {
      recordAudit(db, {
        organizationId: actor.organizationId,
        actor,
        action: "study.enrol",
        entityType: "study_participant",
        entityId: participantId,
        studyId,
        participantId,
        outcome: "denied",
        severity: "warning",
        detail: { reason: "no active consent on file", consentStatus: consent?.status ?? "absent" },
      });
      return {
        ok: false,
        message: `Enrolment denied: ${participant.pseudonym} has no granted consent for this study. Record consent first.`,
      };
    }
    enrolParticipant(db, {
      studyId,
      participantId,
      enrolmentSource: `manual enrolment by ${actor.label}`,
      status: "enrolled",
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "study.enrol",
      entityType: "study_participant",
      entityId: participantId,
      studyId,
      participantId,
      outcome: "success",
      detail: { pseudonym: participant.pseudonym },
    });
    revalidatePath(`/studies/${studyId}`);
    return { ok: true, message: `${participant.pseudonym} enrolled.` };
  } catch (error) {
    return failure(error);
  }
}

export async function setEnrolmentStatusAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    const participantId = String(formData.get("participantId") ?? "");
    const status = String(formData.get("status") ?? "");
    assertAuthorized(actor, PERMISSIONS.participantWrite, { studyId });
    const parsedStatus = z
      .enum(["invited", "enrolled", "active", "completed", "withdrawn", "excluded"])
      .safeParse(status);
    if (!parsedStatus.success) {
      return { ok: false, message: "Unknown enrolment status." };
    }
    const reason = String(formData.get("reason") ?? "") || null;
    const changed = setEnrolmentStatus(db, studyId, participantId, parsedStatus.data, reason);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "study.enrolment.status",
      entityType: "study_participant",
      entityId: participantId,
      studyId,
      participantId,
      outcome: changed ? "success" : "failure",
      detail: { status: parsedStatus.data, reason },
    });
    revalidatePath(`/studies/${studyId}`);
    return { ok: changed, message: changed ? `Status set to ${parsedStatus.data}.` : "Enrolment not found." };
  } catch (error) {
    return failure(error);
  }
}

export async function listEnrollableParticipantsAction(studyId: string) {
  const { db, actor } = await requireAuth();
  assertAuthorized(actor, PERMISSIONS.participantRead, { studyId });
  return listParticipants(db, actor.organizationId, { limit: 200 }).map((row) => ({
    id: row.id,
    pseudonym: row.pseudonym,
    consentStatus: row.consent_status,
  }));
}
