"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertOwned, assertParticipantPermission } from "../../lib/services/ownership.ts";
import { requireAuth } from "../../lib/services/session.ts";
import { PERMISSIONS, assertAuthorized } from "../../lib/services/authz.ts";
import { recordAudit } from "../../lib/services/audit.ts";
import {
  addAnnotation,
  createParticipant,
  getParticipant,
  getPrivateIdentity,
  recordConsent,
  updateParticipantAttributes,
  upsertPrivateIdentity,
  type AttributeField,
} from "../../lib/repo/participants.ts";
import { registerDocumentedSource } from "../../lib/repo/sources.ts";
import { DomainError } from "../../lib/domain/types.ts";
import type { ActionResult } from "./studies.ts";

function failure(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, message: `${error.code}: ${error.message}`, detail: error.detail };
  }
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

const attributeSchema = z.object({
  birth_year: z.coerce.number().int().min(1900).max(2100).optional(),
  age_at_enrolment: z.coerce.number().int().min(10).max(120).optional(),
  self_described_gender: z.string().trim().max(80).optional(),
  preferred_language: z.string().trim().max(40).optional(),
  education_level: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  recruitment_channel: z.string().trim().max(120).optional(),
});

function collectAttributes(formData: FormData): Partial<Record<AttributeField, string | number | null>> {
  const raw: Record<string, string> = {};
  for (const field of [
    "birth_year",
    "age_at_enrolment",
    "self_described_gender",
    "preferred_language",
    "education_level",
    "region",
    "recruitment_channel",
  ]) {
    const value = formData.get(field);
    if (typeof value === "string" && value.trim().length > 0) {
      raw[field] = value.trim();
    }
  }
  const parsed = attributeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError("participant.attribute_invalid", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return parsed.data as Partial<Record<AttributeField, string | number | null>>;
}

export async function createParticipantAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const pseudonymPrefix = String(formData.get("pseudonymPrefix") ?? "P");
    const sourceTitle = String(formData.get("sourceTitle") ?? "").trim();
    const sourceReference = String(formData.get("sourceReference") ?? "").trim();
    const sourceOrigin = String(formData.get("sourceOrigin") ?? "manual_entry_signed");
    const sourceCollectedAt = String(formData.get("sourceCollectedAt") ?? "");
    const evidenceLocator = String(formData.get("evidenceLocator") ?? "").trim();
    const consentVersion = String(formData.get("consentVersion") ?? "").trim();
    const consentBasis = String(formData.get("consentBasis") ?? "written_signed");
    const consentEvidenceNote = String(formData.get("consentEvidenceNote") ?? "").trim();
    const studyIdRaw = String(formData.get("studyId") ?? "");
    const studyId = studyIdRaw.length > 0 ? studyIdRaw : null;
    if (studyId) assertOwned(db, actor, "study", studyId);
    assertAuthorized(actor, PERMISSIONS.consentWrite, { studyId });
    assertAuthorized(actor, PERMISSIONS.participantWrite, { studyId });
    const identityName = String(formData.get("identityName") ?? "").trim();
    const identityEmail = String(formData.get("identityEmail") ?? "").trim();
    const lawfulBasis = String(formData.get("lawfulBasis") ?? "").trim();

    if (sourceTitle.length < 3 || sourceReference.length < 3) {
      return {
        ok: false,
        message:
          "A documented source needs a title and a reference (file name, archive id or signed-form location). Participant records are never created without provenance.",
      };
    }
    if (!evidenceLocator) {
      return { ok: false, message: "State where in the source this participant appears (row, page, archive number)." };
    }
    if (!consentVersion || consentEvidenceNote.length < 8) {
      return {
        ok: false,
        message: "Record the consent version and describe the consent evidence. Consent is never assumed.",
      };
    }
    const identityRequested = identityName.length > 0 || identityEmail.length > 0;
    if (identityRequested && lawfulBasis.length < 4) {
      return { ok: false, message: "Storing identity data requires a documented lawful basis." };
    }

    const originSchema = z.enum([
      "google_form_export",
      "spreadsheet",
      "spss_dataset",
      "csv_export",
      "paper_form",
      "interview_transcript",
      "observation_log",
      "external_api",
      "manual_entry_signed",
      "instrument_report",
    ]);
    const parsedOrigin = originSchema.safeParse(sourceOrigin);
    if (!parsedOrigin.success) {
      return { ok: false, message: "Unknown source origin type." };
    }
    const basisSchema = z.enum([
      "written_signed",
      "digital_form",
      "verbal_witnessed",
      "guardian_proxy",
      "institutional_blanket",
    ]);
    const parsedBasis = basisSchema.safeParse(consentBasis);
    if (!parsedBasis.success) {
      return { ok: false, message: "Unknown consent basis." };
    }

    const registration = registerDocumentedSource(db, {
      organizationId: actor.organizationId,
      originType: parsedOrigin.data,
      studyId,
      title: sourceTitle,
      reference: sourceReference,
      collectedAt: sourceCollectedAt ? new Date(sourceCollectedAt).toISOString() : undefined,
      integrityNotes: `Participant record created manually by ${actor.label}; source declared by the operator.`,
      recordedBy: actor.id,
    });

    const created = createParticipant(db, {
      organizationId: actor.organizationId,
      pseudonymPrefix,
      attributes: collectAttributes(formData),
      notes: String(formData.get("notes") ?? "") || null,
      createdBy: actor.id,
      evidenceDocumentedSourceId: registration.id,
      evidenceLocator,
      consent: {
        studyId,
        version: consentVersion,
        basis: parsedBasis.data,
        status: "granted",
        grantedAt: String(formData.get("consentGrantedAt") ?? "") || null,
        scope: ["assessment", "analysis", "reported_aggregate"],
        notes: consentEvidenceNote,
      },
      identity: identityRequested
        ? {
            fullName: identityName || null,
            contactEmail: identityEmail || null,
            lawfulBasis,
          }
        : null,
    });

    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "participant.create",
      entityType: "participant",
      entityId: created.participant.id,
      studyId,
      participantId: created.participant.id,
      outcome: "success",
      severity: "notice",
      detail: {
        pseudonym: created.participant.pseudonym,
        documentedSourceId: registration.id,
        sourceTitle,
        consentVersion,
        identityStored: created.identityWritten,
      },
    });
    revalidatePath("/participants");
    revalidatePath("/");
    return {
      ok: true,
      message: `Participant ${created.participant.pseudonym} created with provenance and a consent record.`,
      detail: { participantId: created.participant.id },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function updateAttributesAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const participantId = String(formData.get("participantId") ?? "");
    assertOwned(db, actor, "participant", participantId);
    assertParticipantPermission(db, actor, participantId, PERMISSIONS.participantWrite);
    const before = getParticipant(db, participantId);
    if (!before) {
      return { ok: false, message: "Participant not found." };
    }
    const attributes = collectAttributes(formData);
    const updated = updateParticipantAttributes(db, participantId, attributes);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "participant.attributes.update",
      entityType: "participant",
      entityId: participantId,
      participantId,
      outcome: "success",
      detail: {
        before: {
          birth_year: before.birth_year,
          age_at_enrolment: before.age_at_enrolment,
          education_level: before.education_level,
          region: before.region,
        },
        after: attributes,
        missingness: JSON.parse(updated.attribute_missingness_json) as Record<string, string>,
      },
    });
    revalidatePath(`/participants/${participantId}`);
    return { ok: true, message: "Attributes updated. Unknown fields remain recorded as not documented." };
  } catch (error) {
    return failure(error);
  }
}

export async function recordConsentAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const participantId = String(formData.get("participantId") ?? "");
    assertOwned(db, actor, "participant", participantId);
    const studyIdRaw = String(formData.get("studyId") ?? "");
    const studyId = studyIdRaw.length > 0 ? studyIdRaw : null;
    if (studyId) assertOwned(db, actor, "study", studyId);
    assertAuthorized(actor, PERMISSIONS.consentWrite, { studyId });
    const version = String(formData.get("version") ?? "").trim();
    const status = String(formData.get("status") ?? "granted");
    const basis = String(formData.get("basis") ?? "written_signed");
    const note = String(formData.get("note") ?? "").trim();
    const parsed = z
      .object({
        version: z.string().min(1).max(40),
        status: z.enum(["granted", "declined", "withdrawn", "expired"]),
        basis: z.enum(["written_signed", "digital_form", "verbal_witnessed", "guardian_proxy", "institutional_blanket"]),
      })
      .safeParse({ version, status, basis });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    if (note.length < 8) {
      return { ok: false, message: "Describe the consent evidence (form, date or archive reference)." };
    }
    const result = recordConsent(db, {
      participantId,
      studyId,
      version: parsed.data.version,
      status: parsed.data.status,
      basis: parsed.data.basis,
      scope: ["assessment", "analysis", "reported_aggregate"],
      recordedBy: actor.id,
      notes: note,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "consent.record",
      entityType: "consent_record",
      entityId: result.id,
      studyId,
      participantId,
      outcome: "success",
      severity: parsed.data.status === "withdrawn" ? "warning" : "notice",
      detail: {
        status: parsed.data.status,
        version: parsed.data.version,
        supersededConsentId: result.supersededConsentId,
        note,
      },
    });
    revalidatePath(`/participants/${participantId}`);
    revalidatePath("/participants");
    return {
      ok: true,
      message:
        parsed.data.status === "withdrawn"
          ? "Consent withdrawn. Exports and submissions for this participant are now blocked."
          : `Consent status recorded as ${parsed.data.status}.`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function upsertIdentityAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const participantId = String(formData.get("participantId") ?? "");
    assertOwned(db, actor, "participant", participantId);
    assertParticipantPermission(db, actor, participantId, PERMISSIONS.identityWrite);
    const lawfulBasis = String(formData.get("lawfulBasis") ?? "").trim();
    if (lawfulBasis.length < 4) {
      return { ok: false, message: "A documented lawful basis is required to store identity data." };
    }
    const before = getPrivateIdentity(db, participantId);
    upsertPrivateIdentity(db, {
      participantId,
      fullName: String(formData.get("fullName") ?? "") || null,
      contactEmail: String(formData.get("contactEmail") ?? "") || null,
      contactPhone: String(formData.get("contactPhone") ?? "") || null,
      contactHandle: String(formData.get("contactHandle") ?? "") || null,
      lawfulBasis,
      retentionUntil: String(formData.get("retentionUntil") ?? "") || null,
      recordedBy: actor.id,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "identity.upsert",
      entityType: "participant_private_identity",
      entityId: participantId,
      participantId,
      outcome: "success",
      severity: "warning",
      detail: {
        lawfulBasis,
        hadRecordBefore: before !== undefined,
        fieldsChanged: ["fullName", "contactEmail", "contactPhone", "contactHandle"].filter((field) =>
          Boolean(formData.get(field)),
        ),
      },
    });
    revalidatePath(`/participants/${participantId}`);
    return { ok: true, message: "Restricted identity record saved and audited." };
  } catch (error) {
    return failure(error);
  }
}

export async function addAnnotationAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const participantId = String(formData.get("participantId") ?? "");
    assertOwned(db, actor, "participant", participantId);
    assertParticipantPermission(db, actor, participantId, PERMISSIONS.assessmentWrite);
    const body = String(formData.get("body") ?? "").trim();
    if (body.length < 5) {
      return { ok: false, message: "Write the annotation text." };
    }
    const type = String(formData.get("annotationType") ?? "assessor_note");
    const parsed = z
      .enum(["assessor_note", "hypothesis", "limitation", "norm_caution", "clinical_flag", "follow_up_required"])
      .safeParse(type);
    if (!parsed.success) {
      return { ok: false, message: "Unknown annotation type." };
    }
    const id = addAnnotation(db, {
      participantId,
      annotationType: parsed.data,
      body,
      confidence: (String(formData.get("confidence") ?? "") || null) as "low" | "moderate" | "high" | null,
      authorUserId: actor.id,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "annotation.create",
      entityType: "interpretation_annotation",
      entityId: id,
      participantId,
      outcome: "success",
      detail: { annotationType: parsed.data, excerpt: body.slice(0, 200) },
    });
    revalidatePath(`/participants/${participantId}`);
    return { ok: true, message: "Annotation stored separately from raw responses and scores." };
  } catch (error) {
    return failure(error);
  }
}
