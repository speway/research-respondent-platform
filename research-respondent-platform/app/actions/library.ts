"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertOwned } from "../../lib/services/ownership.ts";
import { requireAuth } from "../../lib/services/session.ts";
import { PERMISSIONS, assertAuthorized } from "../../lib/services/authz.ts";
import { recordAudit } from "../../lib/services/audit.ts";
import {
  addItems,
  createInstrument,
  createInstrumentVersion,
  createScale,
  createScoreAlgorithm,
  getAssessmentSession,
  listItems,
  listScales,
  listAlgorithms,
  scoreAndPersistSession,
} from "../../lib/repo/assessments.ts";
import { registerDocumentedSource } from "../../lib/repo/sources.ts";
import { DomainError } from "../../lib/domain/types.ts";
import { parseAlgorithm } from "../../lib/domain/scoring.ts";
import { parseRule } from "../../lib/domain/cohort.ts";
import type { ActionResult } from "./studies.ts";

function failure(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, message: `${error.code}: ${error.message}`, detail: error.detail };
  }
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

const RIGHTS = ["public_domain", "open_access", "licensed_local", "permission_pending", "restricted_no_redistribution"] as const;
const TRADITIONS = [
  "big_five",
  "sixteen_pf",
  "temperament_strelau_pavlovian",
  "temperament_strelau_regulative",
  "temperament_other",
  "clinical_mmpi_family",
  "normal_range_mpq_family",
  "self_regulation",
  "tolerance_of_uncertainty",
  "addiction_screening",
  "cognitive_ability",
  "psychosomatic",
  "other",
] as const;

export async function createInstrumentAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.instrumentWrite);
    const parsed = z
      .object({
        slug: z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/, "Use lower-case letters, digits and dashes."),
        title: z.string().trim().min(3).max(200),
        abbreviation: z.string().trim().max(20).optional(),
        authors: z.string().trim().max(300).optional(),
        tradition: z.enum(TRADITIONS).optional(),
        rightsStatus: z.enum(RIGHTS),
        licenseHolder: z.string().trim().max(200).optional(),
        rightsNote: z.string().trim().max(1000).optional(),
        isClinical: z.boolean(),
        requiresSupervision: z.boolean(),
        constructDomains: z.string().trim().max(500).optional(),
      })
      .safeParse({
        slug: formData.get("slug"),
        title: formData.get("title"),
        abbreviation: formData.get("abbreviation") ?? "",
        authors: formData.get("authors") ?? "",
        tradition: (String(formData.get("tradition") ?? "") || undefined) as (typeof TRADITIONS)[number] | undefined,
        rightsStatus: formData.get("rightsStatus"),
        licenseHolder: formData.get("licenseHolder") ?? "",
        rightsNote: formData.get("rightsNote") ?? "",
        isClinical: formData.get("isClinical") === "on",
        requiresSupervision: formData.get("requiresSupervision") === "on",
        constructDomains: formData.get("constructDomains") ?? "",
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
    }
    if (
      (parsed.data.rightsStatus === "licensed_local" ||
        parsed.data.rightsStatus === "permission_pending" ||
        parsed.data.rightsStatus === "restricted_no_redistribution") &&
      !parsed.data.licenseHolder
    ) {
      return {
        ok: false,
        message:
          "A restricted or licensed instrument must name its licence holder or rights contact. The platform will not hold restricted material without a recorded rights owner.",
      };
    }
    const instrument = createInstrument(db, {
      slug: parsed.data.slug,
      title: parsed.data.title,
      abbreviation: parsed.data.abbreviation || null,
      authors: parsed.data.authors || null,
      tradition: parsed.data.tradition ?? null,
      constructDomains: parsed.data.constructDomains
        ? parsed.data.constructDomains.split(",").map((value) => value.trim()).filter(Boolean)
        : [],
      rightsStatus: parsed.data.rightsStatus,
      rightsNote: parsed.data.rightsNote || null,
      licenseHolder: parsed.data.licenseHolder || null,
      isClinical: parsed.data.isClinical,
      requiresSupervision: parsed.data.requiresSupervision,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "instrument.create",
      entityType: "instrument",
      entityId: instrument.id,
      outcome: "success",
      detail: {
        slug: instrument.slug,
        title: instrument.title,
        rightsStatus: instrument.rights_status,
        licenseHolder: instrument.license_holder,
        isClinical: instrument.is_clinical === 1,
      },
    });
    revalidatePath("/library");
    return { ok: true, message: `Instrument ${instrument.title} registered.`, detail: { instrumentId: instrument.id } };
  } catch (error) {
    return failure(error);
  }
}

export async function createInstrumentVersionAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.instrumentWrite);
    const instrumentId = String(formData.get("instrumentId") ?? "");
    assertOwned(db, actor, "instrument", instrumentId);
    const sourceTitle = String(formData.get("sourceTitle") ?? "").trim();
    const sourceReference = String(formData.get("sourceReference") ?? "").trim();
    const parsed = z
      .object({
        versionLabel: z.string().trim().min(1).max(40),
        language: z.string().trim().min(2).max(20),
        adaptation: z.string().trim().max(200).optional(),
        publicationYear: z.string().trim().max(20).optional(),
        normReference: z.string().trim().max(400).optional(),
        responseFormat: z.string().trim().max(200).optional(),
        scoringNotes: z.string().trim().max(2000).optional(),
        limitations: z.string().trim().max(2000).optional(),
        isProvisional: z.boolean(),
        clinicalUsePermitted: z.boolean(),
      })
      .safeParse({
        versionLabel: formData.get("versionLabel"),
        language: formData.get("language"),
        adaptation: formData.get("adaptation") ?? "",
        publicationYear: formData.get("publicationYear") ?? "",
        normReference: formData.get("normReference") ?? "",
        responseFormat: formData.get("responseFormat") ?? "",
        scoringNotes: formData.get("scoringNotes") ?? "",
        limitations: formData.get("limitations") ?? "",
        isProvisional: formData.get("isProvisional") === "on",
        clinicalUsePermitted: formData.get("clinicalUsePermitted") === "on",
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    if (sourceTitle.length < 3 || sourceReference.length < 3) {
      return {
        ok: false,
        message:
          "Record the documented source of this version (manual, adaptation article, licence documentation). Versions without provenance are not accepted.",
      };
    }
    const source = registerDocumentedSource(db, {
      organizationId: actor.organizationId,
      originType: "instrument_report",
      title: sourceTitle,
      reference: sourceReference,
      integrityNotes: `Instrument version declared by ${actor.label}.`,
      recordedBy: actor.id,
    });
    const version = createInstrumentVersion(db, {
      instrumentId,
      versionLabel: parsed.data.versionLabel,
      language: parsed.data.language,
      adaptation: parsed.data.adaptation || null,
      publicationYear: parsed.data.publicationYear || null,
      normReference: parsed.data.normReference || null,
      responseFormat: parsed.data.responseFormat || null,
      scoringNotes: parsed.data.scoringNotes || null,
      isProvisional: parsed.data.isProvisional,
      clinicalUsePermitted: parsed.data.clinicalUsePermitted,
      limitations: parsed.data.limitations || null,
      sourceDocumentId: source.id,
      createdBy: actor.id,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "instrument.version.create",
      entityType: "instrument_version",
      entityId: version.id,
      outcome: "success",
      severity: "notice",
      detail: {
        instrumentId,
        versionLabel: version.version_label,
        language: version.language,
        isProvisional: version.is_provisional === 1,
        clinicalUsePermitted: version.clinical_use_permitted === 1,
        documentedSourceId: source.id,
      },
    });
    revalidatePath("/library");
  return { ok: true, message: `Version ${version.version_label} (${version.language}) recorded.`, detail: { instrumentVersionId: version.id } };
  } catch (error) {
    return failure(error);
  }
}

export async function addItemAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.instrumentWrite);
    const instrumentVersionId = String(formData.get("instrumentVersionId") ?? "");
    assertOwned(db, actor, "instrumentVersion", instrumentVersionId);
    const parsed = z
      .object({
        itemCode: z.string().trim().min(1).max(20),
        orderIndex: z.coerce.number().int().min(1).max(2000),
        textVerbatim: z.string().trim().min(1).max(2000),
        textLanguage: z.string().trim().min(2).max(20),
        responseType: z.enum(["likert", "yes_no", "multiple_choice", "numeric", "open_text", "date", "categorical"]),
        options: z.string().max(2000).optional(),
        minValue: z.string().optional(),
        maxValue: z.string().optional(),
        reverseScored: z.boolean(),
        required: z.boolean(),
        section: z.string().trim().max(120).optional(),
      })
      .safeParse({
        itemCode: formData.get("itemCode"),
        orderIndex: formData.get("orderIndex"),
        textVerbatim: formData.get("textVerbatim"),
        textLanguage: formData.get("textLanguage"),
        responseType: formData.get("responseType"),
        options: formData.get("options") ?? "",
        minValue: formData.get("minValue") ?? "",
        maxValue: formData.get("maxValue") ?? "",
        reverseScored: formData.get("reverseScored") === "on",
        required: formData.get("required") === "on",
        section: formData.get("section") ?? "",
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    const minValue = parsed.data.minValue ? Number(parsed.data.minValue) : null;
    const maxValue = parsed.data.maxValue ? Number(parsed.data.maxValue) : null;
    if ((minValue !== null && !Number.isFinite(minValue)) || (maxValue !== null && !Number.isFinite(maxValue))) {
      return { ok: false, message: "Minimum and maximum must be numbers." };
    }
    if (minValue !== null && maxValue !== null && minValue >= maxValue) {
      return { ok: false, message: "Minimum must be smaller than maximum for reverse keying to be well defined." };
    }
    addItems(db, instrumentVersionId, [
      {
        itemCode: parsed.data.itemCode,
        orderIndex: parsed.data.orderIndex,
        textVerbatim: parsed.data.textVerbatim,
        textLanguage: parsed.data.textLanguage,
        responseType: parsed.data.responseType,
        options: parsed.data.options
          ? parsed.data.options.split("|").map((value) => value.trim()).filter(Boolean)
          : [],
        minValue,
        maxValue,
        reverseScored: parsed.data.reverseScored,
        required: parsed.data.required,
        section: parsed.data.section || null,
      },
    ]);
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "instrument.item.create",
      entityType: "item_definition",
      entityId: instrumentVersionId,
      outcome: "success",
      severity: "notice",
      detail: {
        itemCode: parsed.data.itemCode,
        responseType: parsed.data.responseType,
        reverseScored: parsed.data.reverseScored,
        note: "Item wording is stored verbatim and is not rewritten when the instrument version already holds answers.",
      },
    });
    revalidatePath(`/library/${instrumentVersionId}`);
    return { ok: true, message: `Item ${parsed.data.itemCode} added.` };
  } catch (error) {
    return failure(error);
  }
}

export async function createScaleAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.instrumentWrite);
    const instrumentVersionId = String(formData.get("instrumentVersionId") ?? "");
    assertOwned(db, actor, "instrumentVersion", instrumentVersionId);
    const parsed = z
      .object({
        scaleCode: z.string().trim().min(1).max(24),
        title: z.string().trim().min(2).max(200),
        kind: z.enum(["raw_sum", "mean", "weighted_sum", "factor_score", "clinical_elevation", "index"]),
        direction: z.enum(["higher_is_more", "higher_is_less", "bipolar"]),
        minPossible: z.string().optional(),
        maxPossible: z.string().optional(),
        normNotes: z.string().trim().max(1000).optional(),
      })
      .safeParse({
        scaleCode: formData.get("scaleCode"),
        title: formData.get("title"),
        kind: formData.get("kind"),
        direction: formData.get("direction"),
        minPossible: formData.get("minPossible") ?? "",
        maxPossible: formData.get("maxPossible") ?? "",
        normNotes: formData.get("normNotes") ?? "",
      });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join("; ") };
    }
    const scale = createScale(db, {
      instrumentVersionId,
      scaleCode: parsed.data.scaleCode,
      title: parsed.data.title,
      kind: parsed.data.kind,
      direction: parsed.data.direction,
      minPossible: parsed.data.minPossible ? Number(parsed.data.minPossible) : null,
      maxPossible: parsed.data.maxPossible ? Number(parsed.data.maxPossible) : null,
      normNotes: parsed.data.normNotes || null,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "instrument.scale.create",
      entityType: "scale_definition",
      entityId: scale.id,
      outcome: "success",
      detail: { scaleCode: scale.scale_code, kind: scale.kind },
    });
    revalidatePath(`/library/${instrumentVersionId}`);
    return { ok: true, message: `Scale ${scale.scale_code} created.` };
  } catch (error) {
    return failure(error);
  }
}

export async function createAlgorithmAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    assertAuthorized(actor, PERMISSIONS.instrumentWrite);
    const instrumentVersionId = String(formData.get("instrumentVersionId") ?? "");
    assertOwned(db, actor, "instrumentVersion", instrumentVersionId);
    const scaleDefinitionId = String(formData.get("scaleDefinitionId") ?? "");
    const algorithmJson = String(formData.get("algorithmJson") ?? "").trim();
    let rawAlgorithm: unknown;
    try {
      rawAlgorithm = JSON.parse(algorithmJson);
    } catch {
      return { ok: false, message: "The algorithm must be valid JSON." };
    }
    const algorithm = parseAlgorithm(rawAlgorithm);
    const row = createScoreAlgorithm(db, {
      instrumentVersionId,
      scaleDefinitionId: scaleDefinitionId || null,
      algorithm,
      createdBy: actor.id,
    });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "instrument.algorithm.create",
      entityType: "score_algorithm",
      entityId: row.id,
      outcome: "success",
      severity: "notice",
      detail: {
        algorithmVersion: row.algorithm_version,
        missingPolicy: row.missing_policy,
        minItemsRequired: row.min_items_required,
        steps: algorithm.steps.map((step) => step.kind),
      },
    });
    revalidatePath(`/library/${instrumentVersionId}`);
    return { ok: true, message: `Scoring algorithm ${row.algorithm_version} registered.` };
  } catch (error) {
    return failure(error);
  }
}

export async function scoreSessionAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const sessionId = String(formData.get("sessionId") ?? "");
    assertOwned(db, actor, "session", sessionId);
    const session = getAssessmentSession(db, sessionId);
    if (!session) {
      return { ok: false, message: "Assessment session not found." };
    }
    assertAuthorized(actor, PERMISSIONS.scoreWrite, { studyId: session.study_id });
    const result = scoreAndPersistSession(db, sessionId, { computedBy: actor.id });
    recordAudit(db, {
      organizationId: actor.organizationId,
      actor,
      action: "score.compute",
      entityType: "assessment_session",
      entityId: sessionId,
      studyId: session.study_id,
      participantId: session.participant_id,
      outcome: "success",
      severity: "notice",
      detail: {
        scores: result.result.scores.map((score) => ({
          scaleCode: score.scaleCode,
          computability: score.computability,
          rawScore: score.rawScore,
          itemsUsed: score.itemsUsed,
          itemsMissing: score.itemsMissing,
          provisional: score.methodologicallyProvisional,
          reason: score.notComputableReason,
        })),
        supersededScoreIds: result.supersededScoreIds,
        coverage: result.result.coverage,
      },
    });
    revalidatePath(`/participants/sessions/${sessionId}`);
    revalidatePath(`/participants/${session.participant_id}`);
    const computed = result.result.scores.filter((score) => score.computability === "computed").length;
    return {
      ok: true,
      message: `Computed ${computed} of ${result.result.scores.length} scale score(s); previous results were superseded, never overwritten.`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function validateRuleJsonAction(formData: FormData): Promise<ActionResult> {
  try {
    const ruleJson = String(formData.get("ruleJson") ?? "");
    const rule = parseRule(JSON.parse(ruleJson));
    return { ok: true, message: `Rule parsed: ${JSON.stringify(rule)}` };
  } catch (error) {
    return failure(error);
  }
}

export async function listInstrumentStructureAction(instrumentVersionId: string) {
  const { db, actor } = await requireAuth();
  assertAuthorized(actor, PERMISSIONS.instrumentRead);
  return {
    items: listItems(db, instrumentVersionId),
    scales: listScales(db, instrumentVersionId),
    algorithms: listAlgorithms(db, instrumentVersionId),
  };
}
