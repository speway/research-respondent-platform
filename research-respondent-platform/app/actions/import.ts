"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "../../lib/services/session.ts";
import { PERMISSIONS, assertAuthorized } from "../../lib/services/authz.ts";
import { recordAudit } from "../../lib/services/audit.ts";
import {
  buildImportPlan,
  inferColumns,
  parseSourceTable,
  type ItemSpec,
} from "../../lib/import/plan.ts";
import { commitImportPlan } from "../../lib/services/import-commit.ts";
import { listItems, listScales } from "../../lib/repo/assessments.ts";
import {
  createImportDraft,
  discardDraft,
  getImportDraft,
  parseDraftOptions,
  parseDraftPlan,
  markDraftCommitted,
  purgeExpiredDrafts,
} from "../../lib/repo/import-drafts.ts";
import { safeJsonParse } from "../../lib/util/ids.ts";
import { DomainError, type ImportColumn, type ImportOptions, type ImportSourceDescriptor } from "../../lib/domain/types.ts";
import type { ActionResult } from "./studies.ts";

function failure(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, message: `${error.code}: ${error.message}`, detail: error.detail };
  }
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

const CONSENT_BASES = [
  "written_signed",
  "digital_form",
  "verbal_witnessed",
  "guardian_proxy",
  "institutional_blanket",
] as const;

const ORIGIN_TYPES = [
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
] as const;

const ADMIN_MODES = [
  "self_online",
  "self_paper",
  "interviewer_assisted",
  "group_paper",
  "imported_dataset",
  "external_form",
] as const;

function itemSpecs(db: Parameters<typeof listItems>[0], instrumentVersionId: string): ItemSpec[] {
  return listItems(db, instrumentVersionId).map((item) => ({
    itemCode: item.item_code,
    questionText: item.text_verbatim,
    responseType: item.response_type,
    options: safeJsonParse<string[]>(item.options_json, []),
    minValue: item.min_value,
    maxValue: item.max_value,
    required: item.required === 1,
    reverseScored: item.reverse_scored === 1,
    itemDefinitionId: item.id,
    orderIndex: item.order_index,
  }));
}

/** Step 1: parse the upload and return a reviewable plan. Nothing is stored yet. */
export async function planImportAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const instrumentVersionId = String(formData.get("instrumentVersionId") ?? "");
    const studyIdRaw = String(formData.get("studyId") ?? "");
    const studyId = studyIdRaw || null;
    if (!instrumentVersionId) {
      return {
        ok: false,
        message:
          "Select the instrument version this export belongs to. The platform will not guess which items the columns hold.",
      };
    }
    assertAuthorized(actor, PERMISSIONS.importCommit, { studyId });
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, message: "Choose the exported spreadsheet or CSV file to import." };
    }
    if (file.size > 25 * 1024 * 1024) {
      return { ok: false, message: "Files larger than 25 MB are not imported through the browser; split the export first." };
    }

    const originType = String(formData.get("originType") ?? "google_form_export");
    const parsedOrigin = z.enum(ORIGIN_TYPES).safeParse(originType);
    if (!parsedOrigin.success) {
      return { ok: false, message: "Unknown source origin type." };
    }
    const declared = String(formData.get("consentDeclared") ?? "") === "on";
    const consentBasis = String(formData.get("consentBasis") ?? "written_signed");
    const parsedBasis = z.enum(CONSENT_BASES).safeParse(consentBasis);
    if (!parsedBasis.success) {
      return { ok: false, message: "Unknown consent basis." };
    }
    const administrationMode = String(formData.get("administrationMode") ?? "imported_dataset");
    const parsedMode = z.enum(ADMIN_MODES).safeParse(administrationMode);
    if (!parsedMode.success) {
      return { ok: false, message: "Unknown administration mode." };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sheetName = String(formData.get("sheetName") ?? "") || undefined;

    const options: ImportOptions = {
      timepointLabel: String(formData.get("timepointLabel") ?? "").trim(),
      administrationMode: parsedMode.data,
      language: String(formData.get("language") ?? "ru").trim() || "ru",
      consent: {
        declared,
        basis: parsedBasis.data,
        version: String(formData.get("consentVersion") ?? "").trim(),
        scope: String(formData.get("consentScope") ?? "assessment,analysis,reported_aggregate")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        evidenceNote: String(formData.get("consentEvidenceNote") ?? "").trim(),
        grantedAt: String(formData.get("consentGrantedAt") ?? "") || undefined,
      },
      storeIdentity: String(formData.get("storeIdentity") ?? "") === "on",
      commit: false,
      pseudonymPrefix: String(formData.get("pseudonymPrefix") ?? "P").trim() || "P",
    };

    const descriptor: ImportSourceDescriptor = {
      organizationId: actor.organizationId,
      studyId,
      originType: parsedOrigin.data,
      title: String(formData.get("sourceTitle") ?? "").trim(),
      reference: String(formData.get("sourceReference") ?? file.name).trim(),
      location: String(formData.get("sourceLocation") ?? "") || undefined,
      collectedFrom: String(formData.get("collectedFrom") ?? "") || undefined,
      collectedAt: String(formData.get("collectedAt") ?? "") || undefined,
      integrityNotes: String(formData.get("integrityNotes") ?? "") || undefined,
    };

    const specs = itemSpecs(db, instrumentVersionId);
    if (specs.length === 0) {
      return { ok: false, message: "The selected instrument version has no registered items." };
    }

    const table = parseSourceTable({ fileName: file.name, buffer, sheetName });
    const inferred = inferColumns(table.headers, specs);
    const overrides: Record<number, Partial<ImportColumn>> = {};
    for (const column of inferred) {
      const overrideRole = String(formData.get(`role_${column.index}`) ?? "").trim();
      if (!overrideRole) {
        continue;
      }
      if (overrideRole === "instrument_item") {
        const itemCode = String(formData.get(`item_${column.index}`) ?? "").trim();
        if (itemCode) {
          overrides[column.index] = { role: "instrument_item", itemCode };
        }
      } else if (
        ["participant_key", "collected_at", "participant_attribute", "identity_email", "identity_name", "ignore"].includes(
          overrideRole,
        )
      ) {
        overrides[column.index] = { role: overrideRole as ImportColumn["role"] };
      }
    }

    const plan = buildImportPlan({
      fileName: file.name,
      buffer,
      sheetName,
      descriptor,
      options,
      items: specs,
      columnOverrides: overrides,
    });

    const draft = createImportDraft(db, {
      organizationId: actor.organizationId,
      studyId,
      instrumentVersionId,
      fileName: file.name,
      sheetName: sheetName ?? null,
      fileBytes: buffer,
      plan,
      options,
      createdBy: actor.id,
    });
    purgeExpiredDrafts(db);

    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "import.plan",
      entityType: "import_draft",
      entityId: draft.id,
      studyId,
      outcome: plan.blockers.length > 0 ? "partial" : "success",
      severity: plan.blockers.length > 0 ? "warning" : "info",
      detail: {
        fileName: file.name,
        fileSha256: draft.file_sha256,
        instrumentVersionId,
        summary: plan.summary,
        blockers: plan.blockers.map((blocker) => blocker.code),
        columns: plan.columns.map((column) => ({
          index: column.index,
          header: column.header,
          role: column.role,
          itemCode: column.itemCode ?? null,
        })),
      },
    });

    revalidatePath("/participants/import");
    return {
      ok: true,
      message:
        plan.blockers.length > 0
          ? `Plan created with ${plan.blockers.length} blocking issue(s). Nothing was written. Draft ${draft.id}.`
          : `Plan ready: ${plan.summary.usableRows} usable of ${plan.summary.totalRows} row(s), ${plan.summary.missingCells} documented missing cell(s), ${plan.summary.outOfRangeCells} out-of-range value(s). Draft ${draft.id}.`,
      detail: { draftId: draft.id },
    };
  } catch (error) {
    return failure(error);
  }
}

/** Step 2: commit a reviewed plan. Requires an explicit confirmation string. */
export async function commitImportAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const draftId = String(formData.get("draftId") ?? "");
    const confirmation = String(formData.get("confirmation") ?? "").trim();
    if (confirmation !== "IMPORT") {
      return {
        ok: false,
        message: 'Type IMPORT in the confirmation box to confirm that consent is documented and the plan was reviewed.',
      };
    }
    const draft = getImportDraft(db, draftId);
    if (!draft) {
      return { ok: false, message: "Import draft not found." };
    }
    if (draft.organization_id !== actor.organizationId) {
      return { ok: false, message: "Import draft belongs to another organization." };
    }
    if (draft.status !== "planned") {
      return { ok: false, message: `Import draft is ${draft.status} and cannot be committed again.` };
    }
    if (Date.parse(draft.expires_at) < Date.now()) {
      discardDraft(db, draftId);
      return { ok: false, message: "This import draft expired. Re-upload the export to continue." };
    }
    assertAuthorized(actor, PERMISSIONS.importCommit, { studyId: draft.study_id });

    const plan = parseDraftPlan(draft);
    const options = parseDraftOptions(draft);
    if (plan.blockers.length > 0) {
      return {
        ok: false,
        message: `Refusing to commit: ${plan.blockers.map((blocker) => blocker.code).join(", ")}.`,
        detail: { blockers: plan.blockers },
      };
    }
    const items = listItems(db, draft.instrument_version_id);
    const itemByCode = new Map(items.map((item) => [item.item_code, item]));
    const scales = listScales(db, draft.instrument_version_id);

    const result = commitImportPlan(db, { ...plan, options: { ...options, commit: true } }, {
      actor,
      itemByCode,
      instrumentVersionId: draft.instrument_version_id,
      studyId: draft.study_id,
      attachConsent: true,
    });

    markDraftCommitted(db, draftId, {
      documentedSourceId: result.documentedSourceId,
      summary: {
        participantsCreated: result.participantsCreated,
        participantsMatched: result.participantsMatched,
        sessionsCreated: result.sessionsCreated,
        answersCreated: result.answersCreated,
        skippedRows: result.skippedRows,
        scalesAvailable: scales.map((scale) => scale.scale_code),
        auditEventIds: result.auditEventIds,
      },
    });

    revalidatePath("/participants/import");
    revalidatePath("/participants");
    revalidatePath("/");
    return {
      ok: true,
      message: `Imported ${result.sessionsCreated} session(s) and ${result.answersCreated} answer(s) from source ${result.documentedSourceId}; ${result.participantsCreated} participant(s) created, ${result.participantsMatched} matched, ${result.skippedRows} row(s) skipped.`,
      detail: { ...result },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function discardImportAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const draftId = String(formData.get("draftId") ?? "");
    const draft = getImportDraft(db, draftId);
    if (!draft || draft.organization_id !== actor.organizationId) {
      return { ok: false, message: "Import draft not found." };
    }
    const discarded = discardDraft(db, draftId);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "import.discard",
      entityType: "import_draft",
      entityId: draftId,
      studyId: draft.study_id,
      outcome: discarded ? "success" : "failure",
      severity: "notice",
      detail: { fileName: draft.file_name },
    });
    revalidatePath("/participants/import");
    return { ok: discarded, message: discarded ? "Draft discarded. No research data was written." : "Draft could not be discarded." };
  } catch (error) {
    return failure(error);
  }
}
