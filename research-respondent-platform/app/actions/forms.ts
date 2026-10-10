"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { participantConsentDecision } from "../../lib/services/exports-runner.ts";
import { assertOwned, assertStudyChild } from "../../lib/services/ownership.ts";
import { requireAuth } from "../../lib/services/session.ts";
import { PERMISSIONS, assertAuthorized } from "../../lib/services/authz.ts";
import { recordAudit } from "../../lib/services/audit.ts";
import {
  captureFormVersion,
  createExternalForm,
  deleteFieldMapping,
  recordMappingValidation,
  markMappingsStale,
  toFieldInput,
  toMappingCandidate,
  upsertFieldMapping,
  listFormFields,
  listFieldMappings,
  GOOGLE_FORMS_CAPABILITY_NOTE,
} from "../../lib/repo/forms.ts";
import { buildPreflight, validateMapping } from "../../lib/domain/mapping.ts";
import { loadMappingSourceContext } from "../../lib/services/preflight-context.ts";
import type { Db } from "../../db/index.ts";
import { registerDocumentedSource } from "../../lib/repo/sources.ts";
import { DomainError } from "../../lib/domain/types.ts";
import type { ActionResult } from "./studies.ts";

function failure(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, message: `${error.code}: ${error.message}`, detail: error.detail };
  }
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

const FIELD_TYPES = [
  "short_text",
  "paragraph",
  "multiple_choice",
  "checkbox",
  "dropdown",
  "linear_scale",
  "date",
  "time",
  "grid",
  "file_upload",
  "section_header",
  "unknown",
] as const;

export async function createExternalFormAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.mappingWrite);
    const parsed = z
      .object({
        provider: z.enum(["google_forms", "microsoft_forms", "limesurvey", "other"]),
        externalId: z.string().trim().min(2).max(200),
        title: z.string().trim().min(3).max(300),
        editUrl: z.string().trim().max(500).optional(),
        responderUrl: z.string().trim().max(500).optional(),
        ownerAccount: z.string().trim().max(200).optional(),
        capabilityEvidence: z.string().trim().max(1000).optional(),
      })
      .safeParse({
        provider: formData.get("provider"),
        externalId: formData.get("externalId"),
        title: formData.get("title"),
        editUrl: formData.get("editUrl") ?? "",
        responderUrl: formData.get("responderUrl") ?? "",
        ownerAccount: formData.get("ownerAccount") ?? "",
        capabilityEvidence: formData.get("capabilityEvidence") ?? "",
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    const form = createExternalForm(db, {
      organizationId: actor.organizationId,
      provider: parsed.data.provider,
      externalId: parsed.data.externalId,
      title: parsed.data.title,
      editUrl: parsed.data.editUrl || null,
      responderUrl: parsed.data.responderUrl || null,
      ownerAccount: parsed.data.ownerAccount || null,
      capabilityEvidence: parsed.data.capabilityEvidence || null,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "form.create",
      entityType: "external_form",
      entityId: form.id,
      outcome: "success",
      detail: {
        provider: form.provider,
        externalId: form.external_id,
        apiCanReadStructure: form.api_can_read_structure === 1,
        apiCanReadResponses: form.api_can_read_responses === 1,
        apiCanSubmitResponses: form.api_can_submit_responses === 1,
        capabilityNote: GOOGLE_FORMS_CAPABILITY_NOTE,
      },
    });
    revalidatePath("/forms");
    return { ok: true, message: `Form "${form.title}" registered.`, detail: { externalFormId: form.id } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Captures a form structure version from a documented source. The platform does
 * not scrape a live form: the operator supplies the captured structure (for
 * example from the Forms API `forms.get` response or an exported schema) and it
 * is stored verbatim with its hash.
 */
export async function captureFormVersionAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.mappingWrite);
    const externalFormId = String(formData.get("externalFormId") ?? "");
    assertOwned(db, actor, "form", externalFormId);
    const versionLabel = String(formData.get("versionLabel") ?? "").trim();
    const revisionId = String(formData.get("revisionId") ?? "").trim();
    const fieldsJson = String(formData.get("fieldsJson") ?? "").trim();
    const sourceTitle = String(formData.get("sourceTitle") ?? "").trim();
    const sourceReference = String(formData.get("sourceReference") ?? "").trim();
    if (versionLabel.length === 0) {
      return { ok: false, message: "A version label is required." };
    }
    if (sourceTitle.length < 3 || sourceReference.length < 3) {
      return {
        ok: false,
        message:
          "Record where this structure capture came from (Forms API response file, exported schema, manual transcription). Captures without provenance are refused.",
      };
    }
    let rawFields: unknown;
    try {
      rawFields = JSON.parse(fieldsJson);
    } catch {
      return { ok: false, message: "The field list must be valid JSON." };
    }
    if (!Array.isArray(rawFields)) {
      return { ok: false, message: "The field list must be a JSON array." };
    }
    const fieldSchema = z.object({
      fieldId: z.string().min(1),
      orderIndex: z.number().int().min(0),
      title: z.string().min(1),
      fieldType: z.enum(FIELD_TYPES),
      isRequired: z.boolean(),
      options: z.array(z.string()).default([]),
      section: z.string().nullable().default(null),
    });
    const parsedFields = rawFields.map((field, index) => {
      const result = fieldSchema.safeParse(field);
      if (!result.success) {
        throw new DomainError(
          "form.field_invalid",
          `Field ${index + 1} is invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
        );
      }
      return result.data;
    });

    const source = registerDocumentedSource(db, {
      organizationId: actor.organizationId,
      originType: "external_api",
      title: sourceTitle,
      reference: sourceReference,
      integrityNotes: `Form structure captured by ${actor.label}; stored verbatim.`,
      recordedBy: actor.id,
    });
    const captured = captureFormVersion(db, {
      externalFormId,
      versionLabel,
      revisionId: revisionId || null,
      fields: parsedFields,
      capturedBy: actor.id,
      sourceDocumentId: source.id,
    });
    // Any mapping pointing at an older version becomes stale until revalidated.
    if (captured.version.supersedes_id) {
      markMappingsStale(db, captured.version.supersedes_id, `superseded by ${captured.version.version_label}`);
    }
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "form.version.capture",
      entityType: "external_form_version",
      entityId: captured.version.id,
      outcome: "success",
      severity: "notice",
      detail: {
        externalFormId,
        versionLabel: captured.version.version_label,
        fieldCount: parsedFields.length,
        structureSha256: captured.version.structure_sha256,
        supersededVersionId: captured.version.supersedes_id,
        documentedSourceId: source.id,
      },
    });
    revalidatePath("/forms");
    return {
      ok: true,
      message: `Captured version ${captured.version.version_label} with ${parsedFields.length} fields (structure hash ${captured.version.structure_sha256.slice(0, 12)}…).`,
      detail: { externalFormVersionId: captured.version.id },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function upsertMappingAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    assertOwned(db, actor, "study", studyId);
    const externalFormVersionId = String(formData.get("externalFormVersionId") ?? "");
    assertOwned(db, actor, "formVersion", externalFormVersionId);
    const externalFormFieldId = String(formData.get("externalFormFieldId") ?? "");
    assertOwned(db, actor, "formField", externalFormFieldId);
    const fieldVersion = db.prepare("SELECT external_form_version_id FROM external_form_field WHERE id = ?").get(externalFormFieldId) as { external_form_version_id: string };
    if (fieldVersion.external_form_version_id !== externalFormVersionId) throw new DomainError("auth.denied", "Field does not belong to the selected form version.");
    assertAuthorized(actor, PERMISSIONS.mappingWrite, { studyId });
    const mappingKind = String(formData.get("mappingKind") ?? "unmapped");
    const parsedKind = z
      .enum(["observed_answer", "derived_score", "participant_attribute", "fixed_constant", "unmapped"])
      .safeParse(mappingKind);
    if (!parsedKind.success) {
      return { ok: false, message: "Unknown mapping kind." };
    }
    const valueTransform = String(formData.get("valueTransform") ?? "verbatim");
    const parsedTransform = z.enum(["verbatim", "option_label", "option_index", "numeric_round", "date_iso"]).safeParse(valueTransform);
    if (!parsedTransform.success) {
      return { ok: false, message: "Unknown value transform." };
    }
    const sourceRefRaw = String(formData.get("sourceRefJson") ?? "{}").trim();
    let sourceRef: Record<string, unknown>;
    try {
      sourceRef = JSON.parse(sourceRefRaw) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        message:
          'The source reference must be JSON, e.g. {"itemCode":"07"} for a documented answer, {"scaleCode":"TOTAL"} for a score, or {"value":"P-23"} for a constant.',
      };
    }
    if (parsedKind.data !== "unmapped" && Object.keys(sourceRef).length === 0) {
      return { ok: false, message: "A binding requires a source reference; an empty reference would be a guess." };
    }
    const mapping = upsertFieldMapping(db, {
      studyId,
      externalFormVersionId,
      externalFormFieldId,
      mappingKind: parsedKind.data,
      sourceRef,
      valueTransform: parsedTransform.data,
      status: "draft",
      rationale: String(formData.get("rationale") ?? "") || null,
      createdBy: actor.id,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "mapping.upsert",
      entityType: "field_mapping",
      entityId: mapping.id,
      studyId,
      outcome: "success",
      detail: {
        externalFormVersionId,
        externalFormFieldId,
        mappingKind: parsedKind.data,
        valueTransform: parsedTransform.data,
        sourceRef,
      },
    });
    revalidatePath("/forms");
    return { ok: true, message: "Mapping saved in draft status; run validation to promote it." };
  } catch (error) {
    return failure(error);
  }
}

export async function validateMappingAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    assertOwned(db, actor, "study", studyId);
    const externalFormVersionId = String(formData.get("externalFormVersionId") ?? "");
    assertOwned(db, actor, "formVersion", externalFormVersionId);
    assertAuthorized(actor, PERMISSIONS.mappingWrite, { studyId });
    const fields = listFormFields(db, externalFormVersionId);
    const mappings = listFieldMappings(db, studyId, externalFormVersionId);
    if (fields.length === 0) {
      return { ok: false, message: "No fields captured for this form version." };
    }
    const mappingByField = new Map(mappings.map((mapping) => [mapping.external_form_field_id, mapping]));
    let pass = 0;
    let warn = 0;
    let fail = 0;
    const issues: Array<Record<string, unknown>> = [];
    for (const field of fields) {
      const mapping = mappingByField.get(field.id);
      const candidate = mapping
        ? toMappingCandidate(mapping)
        : {
            mappingId: "unmapped",
            mappingKind: "unmapped" as const,
            valueTransform: "verbatim" as const,
            sourceRef: {},
            status: "draft" as const,
            rationale: null,
          };
      const fieldInput = toFieldInput(field);
      const validation = validateMapping(fieldInput, candidate, {
        participantId: "validation",
        pseudonym: "validation",
        answers: [],
        scores: [],
        attributes: {},
      });
      if (validation.outcome === "pass") {
        pass += 1;
      } else if (validation.outcome === "warn") {
        warn += 1;
      } else {
        fail += 1;
      }
      issues.push({
        fieldId: field.field_id,
        fieldTitle: field.title,
        required: field.is_required === 1,
        outcome: validation.outcome,
        issues: validation.issues.map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message })),
      });
      if (mapping) {
        recordMappingValidation(db, {
          fieldMappingId: mapping.id,
          outcome: validation.outcome,
          issues: validation.issues,
          checkedCount: 1,
          runBy: actor.id,
        });
      }
    }
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "mapping.validate",
      entityType: "external_form_version",
      entityId: externalFormVersionId,
      studyId,
      outcome: fail > 0 ? "partial" : "success",
      severity: fail > 0 ? "warning" : "info",
      detail: { pass, warn, fail, fieldCount: fields.length, issues },
    });
    revalidatePath("/forms");
    return {
      ok: true,
      message: `Structure-level validation: ${pass} pass, ${warn} warn, ${fail} fail. Full answer-level checks run in the preflight for a specific participant.`,
      detail: { pass, warn, fail },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function preflightAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    assertOwned(db, actor, "study", studyId);
    const participantId = String(formData.get("participantId") ?? "");
    assertOwned(db, actor, "participant", participantId);
    const externalFormVersionId = String(formData.get("externalFormVersionId") ?? "");
    assertOwned(db, actor, "formVersion", externalFormVersionId);
    assertAuthorized(actor, PERMISSIONS.mappingRead, { studyId });
    const report = buildParticipantPreflight(db, { studyId, participantId, externalFormVersionId });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "mapping.preflight",
      entityType: "external_form_version",
      entityId: externalFormVersionId,
      studyId,
      participantId,
      outcome: report.outcome === "fail" ? "partial" : "success",
      severity: report.outcome === "fail" ? "warning" : "info",
      detail: {
        outcome: report.outcome,
        counts: report.counts,
        blockingReasons: report.blockingReasons,
        submissionAllowedByPlatform: report.authorization.submissionAllowedByPlatform,
      },
    });
    revalidatePath("/forms");
    const summary = `Preflight ${report.outcome.toUpperCase()}: ${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail. Submission allowed by the platform: ${report.authorization.submissionAllowedByPlatform}.`;
    return { ok: true, message: summary, detail: { blockingReasons: report.blockingReasons } };
  } catch (error) {
    return failure(error);
  }
}

function buildParticipantPreflight(
  db: Db,
  input: { studyId: string; participantId: string; externalFormVersionId: string },
) {
  const fields = listFormFields(db, input.externalFormVersionId);
  const mappings = listFieldMappings(db, input.studyId, input.externalFormVersionId);
  const context = loadMappingSourceContext(db, {
    participantId: input.participantId,
    studyId: input.studyId,
  });
  const consentRow = db
    .prepare(
      `SELECT status, consent_version, withdrawn_at FROM consent_record
       WHERE participant_id = ? AND (study_id = ? OR study_id IS NULL)
       ORDER BY CASE WHEN study_id = ? THEN 0 ELSE 1 END, recorded_at DESC, rowid DESC LIMIT 1`,
    )
    .get(input.participantId, input.studyId, input.studyId) as
    | { status: string; consent_version: string; withdrawn_at: string | null }
    | undefined;
  return buildPreflight({
    studyId: input.studyId,
    participantId: input.participantId,
    externalFormVersionId: input.externalFormVersionId,
    fields: fields.map(toFieldInput),
    mappings: mappings.map(toMappingCandidate),
    context,
    consent: {
      status: participantConsentDecision(db, input.participantId, input.studyId).allowed ? "granted" : "inactive",
      version: consentRow?.consent_version ?? null,
      withdrawnAt: consentRow?.withdrawn_at ?? null,
    },
    platformSubmissionAuthorized: false,
    generatedAt: new Date().toISOString(),
  });
}

export async function deleteMappingAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    assertOwned(db, actor, "study", studyId);
    const mappingId = String(formData.get("mappingId") ?? "");
    assertStudyChild(db, studyId, "mapping", mappingId);
    assertAuthorized(actor, PERMISSIONS.mappingWrite, { studyId });
    const removed = deleteFieldMapping(db, mappingId);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "mapping.delete",
      entityType: "field_mapping",
      entityId: mappingId,
      studyId,
      outcome: removed ? "success" : "failure",
      severity: "warning",
      detail: { mappingId },
    });
    revalidatePath("/forms");
    return { ok: removed, message: removed ? "Mapping removed." : "Mapping not found." };
  } catch (error) {
    return failure(error);
  }
}
