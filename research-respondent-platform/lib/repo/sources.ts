/**
 * Documented-source repository: provenance for every imported record.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, sha256Hex, canonicalJson } from "../util/ids.ts";
import { DomainError } from "../domain/types.ts";
import type { ImportSourceDescriptor } from "../domain/types.ts";

export interface DocumentedSourceRow {
  id: string;
  organization_id: string;
  origin_type: string;
  title: string;
  reference: string;
  location: string | null;
  collected_from: string | null;
  collected_at: string | null;
  received_at: string;
  content_sha256: string | null;
  row_count: number | null;
  integrity_notes: string | null;
  recorded_by: string | null;
  created_at: string;
}

export const ORIGIN_TYPES = [
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

export function registerDocumentedSource(
  db: Db,
  input: ImportSourceDescriptor & { recordedBy?: string | null; rowCount?: number | null },
): DocumentedSourceRow {
  if (!input.title.trim() || !input.reference.trim()) {
    throw new DomainError(
      "source.incomplete",
      "A documented source requires both a title and a reference (file name, URL or archive location).",
    );
  }
  if (!ORIGIN_TYPES.includes(input.originType)) {
    throw new DomainError("source.unknown_origin", `Unknown origin type "${input.originType}".`, {
      allowed: ORIGIN_TYPES,
    });
  }
  const timestamp = nowIso();
  const row: DocumentedSourceRow = {
    id: newId("src"),
    organization_id: input.organizationId,
    origin_type: input.originType,
    title: input.title.trim(),
    reference: input.reference.trim(),
    location: input.location ?? null,
    collected_from: input.collectedFrom ?? null,
    collected_at: input.collectedAt ?? null,
    received_at: timestamp,
    content_sha256: input.contentSha256 ?? null,
    row_count: input.rowCount ?? null,
    integrity_notes: input.integrityNotes ?? null,
    recorded_by: input.recordedBy ?? null,
    created_at: timestamp,
  };
  db.prepare(
    `INSERT INTO documented_source (id, organization_id, origin_type, title, reference, location, collected_from,
       collected_at, received_at, content_sha256, row_count, integrity_notes, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.organization_id,
    row.origin_type,
    row.title,
    row.reference,
    row.location,
    row.collected_from,
    row.collected_at,
    row.received_at,
    row.content_sha256,
    row.row_count,
    row.integrity_notes,
    row.recorded_by,
    row.created_at,
  );
  return row;
}

export function getDocumentedSource(db: Db, id: string): DocumentedSourceRow | undefined {
  return db.prepare("SELECT * FROM documented_source WHERE id = ?").get(id) as DocumentedSourceRow | undefined;
}

export function listDocumentedSources(db: Db, organizationId: string, limit = 200): Array<DocumentedSourceRow & {
  answer_count: number;
  session_count: number;
}> {
  return db
    .prepare(
      `SELECT ds.*,
        (SELECT COUNT(*) FROM observed_answer oa WHERE oa.source_documented_source_id = ds.id) AS answer_count,
        (SELECT COUNT(*) FROM assessment_session s WHERE s.documented_source_id = ds.id) AS session_count
       FROM documented_source ds WHERE ds.organization_id = ?
       ORDER BY ds.received_at DESC LIMIT ?`,
    )
    .all(organizationId, Math.min(limit, 1000)) as Array<DocumentedSourceRow & { answer_count: number; session_count: number }>;
}

export function findSourceByChecksum(db: Db, organizationId: string, checksum: string): DocumentedSourceRow | undefined {
  return db
    .prepare("SELECT * FROM documented_source WHERE organization_id = ? AND content_sha256 = ?")
    .get(organizationId, checksum) as DocumentedSourceRow | undefined;
}

export function addEvidenceLink(
  db: Db,
  input: {
    documentedSourceId: string;
    entityType:
      | "participant"
      | "assessment_session"
      | "observed_answer"
      | "derived_score"
      | "consent_record"
      | "eligibility_decision"
      | "manual_entry";
    entityId: string;
    locator?: string | null;
    note?: string | null;
  },
): string {
  const id = newId("evl");
  db.prepare(
    `INSERT INTO evidence_link (id, documented_source_id, entity_type, entity_id, locator, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.documentedSourceId,
    input.entityType,
    input.entityId,
    input.locator ?? null,
    input.note ?? null,
    nowIso(),
  );
  return id;
}

export function listEvidenceForEntity(
  db: Db,
  entityType: string,
  entityId: string,
): Array<{ source: DocumentedSourceRow; locator: string | null; note: string | null }> {
  const rows = db
    .prepare(
      `SELECT ds.*, el.locator, el.note FROM evidence_link el
       JOIN documented_source ds ON ds.id = el.documented_source_id
       WHERE el.entity_type = ? AND el.entity_id = ?`,
    )
    .all(entityType, entityId) as Array<DocumentedSourceRow & { locator: string | null; note: string | null }>;
  return rows.map((row) => ({
    source: {
      id: row.id,
      organization_id: row.organization_id,
      origin_type: row.origin_type,
      title: row.title,
      reference: row.reference,
      location: row.location,
      collected_from: row.collected_from,
      collected_at: row.collected_at,
      received_at: row.received_at,
      content_sha256: row.content_sha256,
      row_count: row.row_count,
      integrity_notes: row.integrity_notes,
      recorded_by: row.recorded_by,
      created_at: row.created_at,
    },
    locator: row.locator,
    note: row.note,
  }));
}

export function checksumBuffer(buffer: Buffer | string): string {
  return sha256Hex(buffer);
}

/**
 * Reproducible checksum for a structured import payload. Used when the raw
 * bytes are not retained but the captured rows must still be verifiable.
 */
export function checksumRows(rows: Array<Array<string | number | boolean | null>>): string {
  return sha256Hex(canonicalJson(rows));
}

export interface ProvenanceCoverage {
  answersTotal: number;
  answersWithSource: number;
  sessionsTotal: number;
  sessionsWithSource: number;
  scoresTotal: number;
  scoresWithAlgorithm: number;
  sourceCount: number;
  checksummedSources: number;
}

export function provenanceCoverage(db: Db, organizationId: string): ProvenanceCoverage {
  const answers = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN oa.source_documented_source_id IS NOT NULL THEN 1 ELSE 0 END) AS withSource
       FROM observed_answer oa
       JOIN participant p ON p.id = oa.participant_id
       WHERE p.organization_id = ?`,
    )
    .get(organizationId) as { total: number; withSource: number | null };
  const sessions = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.documented_source_id IS NOT NULL THEN 1 ELSE 0 END) AS withSource
       FROM assessment_session s JOIN participant p ON p.id = s.participant_id
       WHERE p.organization_id = ?`,
    )
    .get(organizationId) as { total: number; withSource: number | null };
  const scores = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ds.score_algorithm_id IS NOT NULL AND ds.algorithm_version IS NOT NULL THEN 1 ELSE 0 END) AS withAlgorithm
       FROM derived_score ds JOIN participant p ON p.id = ds.participant_id
       WHERE p.organization_id = ?`,
    )
    .get(organizationId) as { total: number; withAlgorithm: number | null };
  const sources = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN content_sha256 IS NOT NULL THEN 1 ELSE 0 END) AS checksummed
       FROM documented_source WHERE organization_id = ?`,
    )
    .get(organizationId) as { total: number; checksummed: number | null };
  return {
    answersTotal: answers.total,
    answersWithSource: answers.withSource ?? 0,
    sessionsTotal: sessions.total,
    sessionsWithSource: sessions.withSource ?? 0,
    scoresTotal: scores.total,
    scoresWithAlgorithm: scores.withAlgorithm ?? 0,
    sourceCount: sources.total,
    checksummedSources: sources.checksummed ?? 0,
  };
}
