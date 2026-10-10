/**
 * External form repository: form definitions, versioned structure captures and
 * field mappings. Structure is captured from documented sources; nothing is
 * scraped or guessed.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, safeJsonParse, sha256Hex } from "../util/ids.ts";
import { DomainError } from "../domain/types.ts";
import type { ExternalFormFieldInput, MappingCandidate } from "../domain/types.ts";

export interface ExternalFormRow {
  id: string;
  organization_id: string;
  provider: "google_forms" | "microsoft_forms" | "limesurvey" | "other";
  external_id: string;
  title: string;
  edit_url: string | null;
  responder_url: string | null;
  owner_account: string | null;
  api_can_read_structure: number;
  api_can_read_responses: number;
  api_can_submit_responses: number;
  capability_evidence: string | null;
  created_at: string;
}

export interface ExternalFormVersionRow {
  id: string;
  external_form_id: string;
  version_label: string;
  revision_id: string | null;
  captured_at: string;
  structure_sha256: string;
  captured_by: string | null;
  supersedes_id: string | null;
  source_document_id: string | null;
}

export interface ExternalFormFieldRow {
  id: string;
  external_form_version_id: string;
  field_id: string;
  order_index: number;
  title: string;
  field_type: string;
  is_required: number;
  options_json: string;
  section: string | null;
  raw_json: string | null;
}

export interface FieldMappingRow {
  id: string;
  study_id: string;
  external_form_version_id: string;
  external_form_field_id: string;
  mapping_kind: string;
  source_ref_json: string;
  value_transform: string;
  status: string;
  validation_json: string;
  rationale: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const GOOGLE_FORMS_CAPABILITY_NOTE =
  "Documented Google Forms API capability as of the platform's last review: the Forms API can read form structure and, " +
  "with the responses scope, read submitted responses of a form the caller owns. It does not expose a supported endpoint " +
  "for creating a response on behalf of a respondent. The platform therefore never claims programmatic submission: " +
  "external submission stays disabled until an authorized, evidenced path is configured.";

export function createExternalForm(
  db: Db,
  input: {
    organizationId: string;
    provider: "google_forms" | "microsoft_forms" | "limesurvey" | "other";
    externalId: string;
    title: string;
    editUrl?: string | null;
    responderUrl?: string | null;
    ownerAccount?: string | null;
    apiCanReadStructure?: boolean;
    apiCanReadResponses?: boolean;
    apiCanSubmitResponses?: boolean;
    capabilityEvidence?: string | null;
  },
): ExternalFormRow {
  const existing = db
    .prepare("SELECT * FROM external_form WHERE provider = ? AND external_id = ?")
    .get(input.provider, input.externalId) as ExternalFormRow | undefined;
  if (existing) {
    return existing;
  }
  const row: ExternalFormRow = {
    id: newId("frm"),
    organization_id: input.organizationId,
    provider: input.provider,
    external_id: input.externalId.trim(),
    title: input.title.trim(),
    edit_url: input.editUrl ?? null,
    responder_url: input.responderUrl ?? null,
    owner_account: input.ownerAccount ?? null,
    api_can_read_structure: input.apiCanReadStructure ? 1 : 0,
    api_can_read_responses: input.apiCanReadResponses ? 1 : 0,
    api_can_submit_responses: input.apiCanSubmitResponses ? 1 : 0,
    capability_evidence: input.capabilityEvidence ?? (input.provider === "google_forms" ? GOOGLE_FORMS_CAPABILITY_NOTE : null),
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO external_form (id, organization_id, provider, external_id, title, edit_url, responder_url, owner_account,
       api_can_read_structure, api_can_read_responses, api_can_submit_responses, capability_evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.organization_id,
    row.provider,
    row.external_id,
    row.title,
    row.edit_url,
    row.responder_url,
    row.owner_account,
    row.api_can_read_structure,
    row.api_can_read_responses,
    row.api_can_submit_responses,
    row.capability_evidence,
    row.created_at,
  );
  return row;
}

export function listExternalForms(db: Db, organizationId: string): Array<ExternalFormRow & { version_count: number }> {
  return db
    .prepare(
      `SELECT f.*, (SELECT COUNT(*) FROM external_form_version v WHERE v.external_form_id = f.id) AS version_count
       FROM external_form f WHERE f.organization_id = ? ORDER BY f.created_at DESC`,
    )
    .all(organizationId) as Array<ExternalFormRow & { version_count: number }>;
}

export function getExternalForm(db: Db, id: string): ExternalFormRow | undefined {
  return db.prepare("SELECT * FROM external_form WHERE id = ?").get(id) as ExternalFormRow | undefined;
}

export function listExternalFormVersions(
  db: Db,
  externalFormId: string,
): Array<ExternalFormVersionRow & { field_count: number }> {
  return db
    .prepare(
      `SELECT v.*, (SELECT COUNT(*) FROM external_form_field f WHERE f.external_form_version_id = v.id) AS field_count
       FROM external_form_version v WHERE v.external_form_id = ? ORDER BY v.captured_at DESC`,
    )
    .all(externalFormId) as Array<ExternalFormVersionRow & { field_count: number }>;
}

export function getExternalFormVersion(db: Db, id: string): ExternalFormVersionRow | undefined {
  return db.prepare("SELECT * FROM external_form_version WHERE id = ?").get(id) as ExternalFormVersionRow | undefined;
}

/**
 * Captures a form structure version. The structure hash is computed from the
 * field list so a later capture can prove that the live form changed.
 */
export function captureFormVersion(
  db: Db,
  input: {
    externalFormId: string;
    versionLabel: string;
    revisionId?: string | null;
    fields: ExternalFormFieldInput[];
    capturedBy?: string | null;
    sourceDocumentId?: string | null;
    capturedAt?: string;
  },
): { version: ExternalFormVersionRow; fields: ExternalFormFieldRow[] } {
  const canonical = input.fields
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((field) => ({
      fieldId: field.fieldId,
      title: field.title,
      fieldType: field.fieldType,
      isRequired: field.isRequired,
      options: field.options,
      section: field.section,
    }));
  const structureSha = sha256Hex(JSON.stringify(canonical));
  const previous = db
    .prepare("SELECT id FROM external_form_version WHERE external_form_id = ? ORDER BY captured_at DESC LIMIT 1")
    .get(input.externalFormId) as { id: string } | undefined;

  const version: ExternalFormVersionRow = {
    id: newId("fvr"),
    external_form_id: input.externalFormId,
    version_label: input.versionLabel.trim(),
    revision_id: input.revisionId ?? null,
    captured_at: input.capturedAt ?? nowIso(),
    structure_sha256: structureSha,
    captured_by: input.capturedBy ?? null,
    supersedes_id: previous?.id ?? null,
    source_document_id: input.sourceDocumentId ?? null,
  };

  const insertVersion = db.prepare(
    `INSERT INTO external_form_version (id, external_form_id, version_label, revision_id, captured_at,
       structure_sha256, captured_by, supersedes_id, source_document_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertField = db.prepare(
    `INSERT INTO external_form_field (id, external_form_version_id, field_id, order_index, title, field_type,
       is_required, options_json, section, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rows: ExternalFormFieldRow[] = [];
  const tx = db.transaction(() => {
    insertVersion.run(
      version.id,
      version.external_form_id,
      version.version_label,
      version.revision_id,
      version.captured_at,
      version.structure_sha256,
      version.captured_by,
      version.supersedes_id,
      version.source_document_id,
    );
    for (const field of input.fields) {
      const row: ExternalFormFieldRow = {
        id: newId("ffd"),
        external_form_version_id: version.id,
        field_id: field.fieldId,
        order_index: field.orderIndex,
        title: field.title,
        field_type: field.fieldType,
        is_required: field.isRequired ? 1 : 0,
        options_json: JSON.stringify(field.options),
        section: field.section,
        raw_json: null,
      };
      insertField.run(
        row.id,
        row.external_form_version_id,
        row.field_id,
        row.order_index,
        row.title,
        row.field_type,
        row.is_required,
        row.options_json,
        row.section,
        row.raw_json,
      );
      rows.push(row);
    }
  });
  tx();
  return { version, fields: rows };
}

export function listFormFields(db: Db, externalFormVersionId: string): ExternalFormFieldRow[] {
  return db
    .prepare("SELECT * FROM external_form_field WHERE external_form_version_id = ? ORDER BY order_index")
    .all(externalFormVersionId) as ExternalFormFieldRow[];
}

export function toFieldInput(row: ExternalFormFieldRow): ExternalFormFieldInput {
  return {
    fieldId: row.field_id,
    orderIndex: row.order_index,
    title: row.title,
    fieldType: row.field_type as ExternalFormFieldInput["fieldType"],
    isRequired: row.is_required === 1,
    options: safeJsonParse<string[]>(row.options_json, []),
    section: row.section,
  };
}

// ------------------------------------------------------------- field maps --

export function upsertFieldMapping(
  db: Db,
  input: {
    studyId: string;
    externalFormVersionId: string;
    externalFormFieldId: string;
    mappingKind: "observed_answer" | "derived_score" | "participant_attribute" | "fixed_constant" | "unmapped";
    sourceRef: Record<string, unknown>;
    valueTransform: "verbatim" | "option_label" | "option_index" | "numeric_round" | "date_iso";
    status: "draft" | "validated" | "rejected" | "stale";
    rationale?: string | null;
    createdBy?: string | null;
  },
): FieldMappingRow {
  const existing = db
    .prepare(
      "SELECT * FROM field_mapping WHERE study_id = ? AND external_form_version_id = ? AND external_form_field_id = ?",
    )
    .get(input.studyId, input.externalFormVersionId, input.externalFormFieldId) as FieldMappingRow | undefined;
  const timestamp = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE field_mapping SET mapping_kind = ?, source_ref_json = ?, value_transform = ?, status = ?,
         rationale = ?, updated_at = ? WHERE id = ?`,
    ).run(
      input.mappingKind,
      JSON.stringify(input.sourceRef),
      input.valueTransform,
      input.status,
      input.rationale ?? null,
      timestamp,
      existing.id,
    );
    return {
      ...existing,
      mapping_kind: input.mappingKind,
      source_ref_json: JSON.stringify(input.sourceRef),
      value_transform: input.valueTransform,
      status: input.status,
      rationale: input.rationale ?? null,
      updated_at: timestamp,
    };
  }
  const row: FieldMappingRow = {
    id: newId("map"),
    study_id: input.studyId,
    external_form_version_id: input.externalFormVersionId,
    external_form_field_id: input.externalFormFieldId,
    mapping_kind: input.mappingKind,
    source_ref_json: JSON.stringify(input.sourceRef),
    value_transform: input.valueTransform,
    status: input.status,
    validation_json: "{}",
    rationale: input.rationale ?? null,
    created_by: input.createdBy ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  db.prepare(
    `INSERT INTO field_mapping (id, study_id, external_form_version_id, external_form_field_id, mapping_kind,
       source_ref_json, value_transform, status, validation_json, rationale, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.study_id,
    row.external_form_version_id,
    row.external_form_field_id,
    row.mapping_kind,
    row.source_ref_json,
    row.value_transform,
    row.status,
    row.validation_json,
    row.rationale,
    row.created_by,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function deleteFieldMapping(db: Db, mappingId: string): boolean {
  return db.prepare("DELETE FROM field_mapping WHERE id = ?").run(mappingId).changes > 0;
}

export function listFieldMappings(
  db: Db,
  studyId: string,
  externalFormVersionId: string,
): Array<FieldMappingRow & { field_id: string; field_title: string; field_type: string; is_required: number; options_json: string; order_index: number }> {
  return db
    .prepare(
      `SELECT m.*, f.field_id, f.title AS field_title, f.field_type, f.is_required, f.options_json, f.order_index
       FROM field_mapping m JOIN external_form_field f ON f.id = m.external_form_field_id
       WHERE m.study_id = ? AND m.external_form_version_id = ?
       ORDER BY f.order_index`,
    )
    .all(studyId, externalFormVersionId) as Array<
    FieldMappingRow & {
      field_id: string;
      field_title: string;
      field_type: string;
      is_required: number;
      options_json: string;
      order_index: number;
    }
  >;
}

export function toMappingCandidate(row: FieldMappingRow): MappingCandidate {
  return {
    mappingId: row.id,
    mappingKind: row.mapping_kind as MappingCandidate["mappingKind"],
    valueTransform: row.value_transform as MappingCandidate["valueTransform"],
    sourceRef: safeJsonParse<Record<string, unknown>>(row.source_ref_json, {}),
    status: row.status as MappingCandidate["status"],
    rationale: row.rationale,
  };
}

export function recordMappingValidation(
  db: Db,
  input: {
    fieldMappingId: string;
    outcome: "pass" | "warn" | "fail";
    issues: unknown[];
    checkedCount: number;
    runBy?: string | null;
  },
): string {
  const id = newId("mvl");
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO mapping_validation (id, field_mapping_id, run_at, outcome, issues_json, checked_count, run_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.fieldMappingId, timestamp, input.outcome, JSON.stringify(input.issues), input.checkedCount, input.runBy ?? null);
  db.prepare("UPDATE field_mapping SET validation_json = ?, status = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify({ outcome: input.outcome, runAt: timestamp, issues: input.issues }),
    input.outcome === "fail" ? "rejected" : input.outcome === "pass" ? "validated" : "draft",
    timestamp,
    input.fieldMappingId,
  );
  return id;
}

export function markMappingsStale(db: Db, externalFormVersionId: string, reason: string): number {
  const result = db
    .prepare("UPDATE field_mapping SET status = 'stale', validation_json = ?, updated_at = ? WHERE external_form_version_id = ?")
    .run(JSON.stringify({ staleReason: reason }), nowIso(), externalFormVersionId);
  return result.changes;
}

export function mappingCoverage(db: Db, studyId: string) {
  const rows = db
    .prepare(
      `SELECT m.status, COUNT(*) AS total FROM field_mapping m WHERE m.study_id = ? GROUP BY m.status`,
    )
    .all(studyId) as Array<{ status: string; total: number }>;
  const required = db
    .prepare(
      `SELECT COUNT(*) AS total FROM field_mapping m
       JOIN external_form_field f ON f.id = m.external_form_field_id
       WHERE m.study_id = ? AND f.is_required = 1 AND m.mapping_kind = 'unmapped'`,
    )
    .get(studyId) as { total: number };
  return {
    byStatus: Object.fromEntries(rows.map((row) => [row.status, row.total])),
    unmappedRequired: required.total,
  };
}

export function requireExternalFormVersion(db: Db, id: string): ExternalFormVersionRow {
  const version = getExternalFormVersion(db, id);
  if (!version) {
    throw new DomainError("form.version_not_found", `External form version ${id} not found.`);
  }
  return version;
}
