/**
 * Import draft repository: holds an uploaded documented export and its reviewed
 * plan between the planning step and the commit step.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, safeJsonParse, sha256Hex } from "../util/ids.ts";
import { DomainError } from "../domain/types.ts";
import type { ImportOptions, ImportPlan } from "../domain/types.ts";

export interface ImportDraftRow {
  id: string;
  organization_id: string;
  study_id: string | null;
  instrument_version_id: string;
  file_name: string;
  file_sha256: string;
  file_bytes: Buffer;
  sheet_name: string | null;
  plan_json: string;
  options_json: string;
  status: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
  documented_source_id: string | null;
  commit_summary_json: string | null;
}

export function createImportDraft(
  db: Db,
  input: {
    organizationId: string;
    studyId: string | null;
    instrumentVersionId: string;
    fileName: string;
    sheetName?: string | null;
    fileBytes: Buffer;
    plan: ImportPlan;
    options: ImportOptions;
    createdBy?: string | null;
    ttlHours?: number;
  },
): ImportDraftRow {
  const timestamp = nowIso();
  const row: ImportDraftRow = {
    id: newId("drf"),
    organization_id: input.organizationId,
    study_id: input.studyId,
    instrument_version_id: input.instrumentVersionId,
    file_name: input.fileName,
    file_sha256: sha256Hex(input.fileBytes),
    file_bytes: input.fileBytes,
    sheet_name: input.sheetName ?? null,
    plan_json: JSON.stringify(input.plan),
    options_json: JSON.stringify(input.options),
    status: "planned",
    created_by: input.createdBy ?? null,
    created_at: timestamp,
    expires_at: new Date(Date.now() + (input.ttlHours ?? 8) * 3600_000).toISOString(),
    committed_at: null,
    documented_source_id: null,
    commit_summary_json: null,
  };
  db.prepare(
    `INSERT INTO import_draft (id, organization_id, study_id, instrument_version_id, file_name, file_sha256,
       file_bytes, sheet_name, plan_json, options_json, status, created_by, created_at, expires_at, committed_at,
       documented_source_id, commit_summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(
    row.id,
    row.organization_id,
    row.study_id,
    row.instrument_version_id,
    row.file_name,
    row.file_sha256,
    row.file_bytes,
    row.sheet_name,
    row.plan_json,
    row.options_json,
    row.status,
    row.created_by,
    row.created_at,
    row.expires_at,
  );
  return row;
}

export function getImportDraft(db: Db, draftId: string): ImportDraftRow | undefined {
  return db.prepare("SELECT * FROM import_draft WHERE id = ?").get(draftId) as ImportDraftRow | undefined;
}

export function listImportDrafts(db: Db, organizationId: string, limit = 50): ImportDraftRow[] {
  return db
    .prepare(
      `SELECT * FROM import_draft WHERE organization_id = ? AND status = 'planned'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(organizationId, Math.min(limit, 200)) as ImportDraftRow[];
}

export function parseDraftPlan(row: ImportDraftRow): ImportPlan {
  const plan = safeJsonParse<ImportPlan | null>(row.plan_json, null);
  if (!plan) {
    throw new DomainError("import.draft_corrupt", `Import draft ${row.id} has an unreadable plan.`);
  }
  return plan;
}

export function parseDraftOptions(row: ImportDraftRow): ImportOptions {
  const options = safeJsonParse<ImportOptions | null>(row.options_json, null);
  if (!options) {
    throw new DomainError("import.draft_corrupt", `Import draft ${row.id} has unreadable options.`);
  }
  return options;
}

export function markDraftCommitted(
  db: Db,
  draftId: string,
  input: { documentedSourceId: string; summary: Record<string, unknown> },
): void {
  db.prepare(
    "UPDATE import_draft SET status = 'committed', committed_at = ?, documented_source_id = ?, commit_summary_json = ? WHERE id = ?",
  ).run(nowIso(), input.documentedSourceId, JSON.stringify(input.summary), draftId);
}

export function discardDraft(db: Db, draftId: string): boolean {
  return db.prepare("UPDATE import_draft SET status = 'discarded' WHERE id = ? AND status = 'planned'").run(draftId)
    .changes > 0;
}

/** Drafts are short-lived by design; expired ones are removed, not silently kept. */
export function purgeExpiredDrafts(db: Db): number {
  const result = db.prepare("DELETE FROM import_draft WHERE status <> 'planned' OR expires_at < ?").run(nowIso());
  return result.changes;
}
