"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "../../lib/services/session.ts";
import { PERMISSIONS, assertAuthorized } from "../../lib/services/authz.ts";
import { createStudySegment, snapshotSegment, updateSegmentRules } from "../../lib/services/cohorts.ts";
import { parseRule } from "../../lib/domain/cohort.ts";
import { parseSegmentRule, listSegmentRules, getSegment, deleteSegment } from "../../lib/repo/cohorts.ts";
import { DomainError } from "../../lib/domain/types.ts";
import type { ActionResult } from "./studies.ts";

function failure(error: unknown): ActionResult {
  if (error instanceof DomainError) {
    return { ok: false, message: `${error.code}: ${error.message}`, detail: error.detail };
  }
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

export async function createSegmentAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    const name = String(formData.get("name") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    const rulesJson = String(formData.get("rulesJson") ?? "").trim();
    if (!studyId) {
      return { ok: false, message: "Select the study this cohort belongs to." };
    }
    if (name.length < 2) {
      return { ok: false, message: "Give the cohort a name a reviewer will recognise." };
    }
    let rawRules: unknown;
    try {
      rawRules = rulesJson ? JSON.parse(rulesJson) : [];
    } catch {
      return { ok: false, message: "Rules must be a JSON array of {kind, label, rule} objects." };
    }
    if (!Array.isArray(rawRules)) {
      return { ok: false, message: "Rules must be a JSON array." };
    }
    const rules = rawRules.map((entry, index) => {
      const record = entry as { kind?: string; label?: string; rule?: unknown };
      const kind = record.kind === "exclude" ? ("exclude" as const) : ("include" as const);
      const parsedRule = parseRule(record.rule);
      return { kind, label: record.label ?? parsedRule.label ?? `rule ${index + 1}`, rule: parsedRule };
    });
    const segment = createStudySegment(db, actor, {
      studyId,
      name,
      description,
      rules,
    });
    revalidatePath("/cohorts");
    return { ok: true, message: `Cohort "${segment.name}" saved with ${rules.length} rule(s).`, detail: { segmentId: segment.id } };
  } catch (error) {
    return failure(error);
  }
}

export async function updateSegmentRulesAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const segmentId = String(formData.get("segmentId") ?? "");
    const rulesJson = String(formData.get("rulesJson") ?? "").trim();
    let rawRules: unknown;
    try {
      rawRules = rulesJson ? JSON.parse(rulesJson) : [];
    } catch {
      return { ok: false, message: "Rules must be valid JSON." };
    }
    if (!Array.isArray(rawRules)) {
      return { ok: false, message: "Rules must be a JSON array." };
    }
    const rules = rawRules.map((entry, index) => {
      const record = entry as { kind?: string; label?: string; rule?: unknown };
      return {
        kind: record.kind === "exclude" ? ("exclude" as const) : ("include" as const),
        label: record.label ?? `rule ${index + 1}`,
        rule: parseRule(record.rule),
      };
    });
    updateSegmentRules(db, actor, segmentId, rules);
    revalidatePath("/cohorts");
    return { ok: true, message: `Cohort rules replaced with ${rules.length} rule(s). A new snapshot is required.` };
  } catch (error) {
    return failure(error);
  }
}

export async function snapshotSegmentAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const segmentId = String(formData.get("segmentId") ?? "");
    assertAuthorized(actor, PERMISSIONS.cohortRead);
    const { snapshot } = snapshotSegment(db, actor, segmentId);
    revalidatePath("/cohorts");
    return {
      ok: true,
      message: `Snapshot revision ${snapshot.revision}: denominator ${snapshot.denominator}, included ${snapshot.included_count}, excluded ${snapshot.excluded_count}, indeterminate ${snapshot.indeterminate_count}.`,
      detail: { snapshotId: snapshot.id, rulesSha256: snapshot.rules_sha256 },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteSegmentAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const segmentId = String(formData.get("segmentId") ?? "");
    const segment = getSegment(db, segmentId);
    if (!segment) {
      return { ok: false, message: "Cohort not found." };
    }
    assertAuthorized(actor, PERMISSIONS.cohortWrite, { studyId: segment.study_id });
    const rules = listSegmentRules(db, segmentId).map((row) => parseSegmentRule(row));
    deleteSegment(db, segmentId);
    revalidatePath("/cohorts");
    return { ok: true, message: `Cohort "${segment.name}" deleted (${rules.length} rule(s) removed).` };
  } catch (error) {
    return failure(error);
  }
}

export async function previewRulesAction(formData: FormData): Promise<ActionResult> {
  const { db, actor } = await requireAuth();
  try {
    const studyId = String(formData.get("studyId") ?? "");
    const rulesJson = String(formData.get("rulesJson") ?? "").trim();
    assertAuthorized(actor, PERMISSIONS.cohortRead, { studyId });
    let rawRules: unknown;
    try {
      rawRules = rulesJson ? JSON.parse(rulesJson) : [];
    } catch {
      return { ok: false, message: "Rules must be valid JSON." };
    }
    if (!Array.isArray(rawRules)) {
      return { ok: false, message: "Rules must be a JSON array of rule objects." };
    }
    const rules = rawRules.map((entry) => parseRule(entry));
    const { getStudyCohortPreview } = await import("../../lib/services/cohorts.ts");
    const preview = getStudyCohortPreview(db, studyId, actor, { includeRules: rules });
    return {
      ok: true,
      message: `Denominator ${preview.denominator}: included ${preview.included}, excluded ${preview.excluded}, indeterminate ${preview.indeterminate}.`,
      detail: {
        included: preview.included,
        excluded: preview.excluded,
        indeterminate: preview.indeterminate,
        warnings: preview.warnings.map((warning) => warning.message),
      },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function validateRulesAction(formData: FormData): Promise<ActionResult> {
  try {
    const rulesJson = String(formData.get("rulesJson") ?? "[]");
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(rulesJson));
    if (!parsed.success) {
      return { ok: false, message: "Rules must be a JSON array." };
    }
    const rules = parsed.data.map((entry) => parseRule(entry));
    return { ok: true, message: `All ${rules.length} rule(s) parsed successfully.` };
  } catch (error) {
    return failure(error);
  }
}
