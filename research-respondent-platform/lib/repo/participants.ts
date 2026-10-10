/**
 * Participant repository: pseudonymous analytic registry, restricted identity
 * store and consent records.
 *
 * Invariants enforced here:
 *   - a participant is created only together with a documented evidence source
 *     and an explicit consent record;
 *   - identity data (name, e-mail, phone) is written only to
 *     `participant_private_identity`, which requires a stated lawful basis;
 *   - unknown attributes stay NULL and are listed in `attribute_missingness_json`
 *     rather than being guessed.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, safeJsonParse } from "../util/ids.ts";
import { DomainError } from "../domain/types.ts";

export interface ParticipantRow {
  id: string;
  organization_id: string;
  pseudonym: string;
  birth_year: number | null;
  age_at_enrolment: number | null;
  self_described_gender: string | null;
  preferred_language: string | null;
  education_level: string | null;
  region: string | null;
  recruitment_channel: string | null;
  attribute_missingness_json: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrivateIdentityRow {
  participant_id: string;
  full_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_handle: string | null;
  lawful_basis: string;
  retention_until: string | null;
  recorded_by: string | null;
  recorded_at: string;
  updated_at: string;
}

export interface ConsentRow {
  id: string;
  participant_id: string;
  study_id: string | null;
  consent_version: string;
  status: "granted" | "declined" | "withdrawn" | "expired";
  basis: string;
  granted_at: string | null;
  withdrawn_at: string | null;
  expires_at: string | null;
  scope_json: string;
  evidence_source_id: string | null;
  recorded_by: string | null;
  recorded_at: string;
  notes: string | null;
}

export const ATTRIBUTE_FIELDS = [
  "birth_year",
  "age_at_enrolment",
  "self_described_gender",
  "preferred_language",
  "education_level",
  "region",
  "recruitment_channel",
] as const;

export type AttributeField = (typeof ATTRIBUTE_FIELDS)[number];

export function nextPseudonym(db: Db, organizationId: string, prefix: string): string {
  const cleaned = prefix.trim().replace(/[^A-Za-z0-9_-]/g, "").toUpperCase() || "P";
  const rows = db
    .prepare("SELECT pseudonym FROM participant WHERE organization_id = ? AND pseudonym LIKE ?")
    .all(organizationId, `${cleaned}-%`) as Array<{ pseudonym: string }>;
  let max = 0;
  for (const row of rows) {
    const match = /-(\d+)$/.exec(row.pseudonym);
    if (match?.[1]) {
      max = Math.max(max, Number.parseInt(match[1], 10));
    }
  }
  return `${cleaned}-${String(max + 1).padStart(3, "0")}`;
}

export function findParticipantByPseudonym(db: Db, organizationId: string, pseudonym: string): ParticipantRow | undefined {
  return db
    .prepare("SELECT * FROM participant WHERE organization_id = ? AND pseudonym = ?")
    .get(organizationId, pseudonym.trim().toUpperCase()) as ParticipantRow | undefined;
}

export function getParticipant(db: Db, participantId: string): ParticipantRow | undefined {
  return db.prepare("SELECT * FROM participant WHERE id = ?").get(participantId) as ParticipantRow | undefined;
}

export function listParticipants(
  db: Db,
  organizationId: string,
  options: { search?: string; studyId?: string; limit?: number; offset?: number } = {},
): Array<ParticipantRow & { session_count: number; consent_status: string | null; study_count: number }> {
  const clauses = ["p.organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (options.search) {
    clauses.push("p.pseudonym LIKE ?");
    params.push(`%${options.search.trim().toUpperCase()}%`);
  }
  if (options.studyId) {
    clauses.push("EXISTS (SELECT 1 FROM study_participant sp WHERE sp.participant_id = p.id AND sp.study_id = ?)");
    params.push(options.studyId);
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  return db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM assessment_session s WHERE s.participant_id = p.id) AS session_count,
        (SELECT COUNT(*) FROM study_participant sp WHERE sp.participant_id = p.id) AS study_count,
        (SELECT cr.status FROM consent_record cr WHERE cr.participant_id = p.id
          ORDER BY CASE cr.status WHEN 'granted' THEN 0 WHEN 'declined' THEN 1 WHEN 'expired' THEN 2 ELSE 3 END,
                   cr.recorded_at DESC LIMIT 1) AS consent_status
       FROM participant p WHERE ${clauses.join(" AND ")}
       ORDER BY p.pseudonym LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<
    ParticipantRow & { session_count: number; consent_status: string | null; study_count: number }
  >;
}

export function countParticipants(db: Db, organizationId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM participant WHERE organization_id = ?").get(organizationId) as {
    total: number;
  };
  return row.total;
}

export interface CreateParticipantInput {
  organizationId: string;
  pseudonymPrefix?: string;
  pseudonym?: string;
  attributes: Partial<Record<AttributeField, string | number | null>>;
  /** Attribute names the source document does not contain. Recorded, not guessed. */
  unknownAttributes?: string[];
  notes?: string | null;
  createdBy?: string | null;
  evidenceDocumentedSourceId: string;
  evidenceLocator: string;
  consent: {
    studyId: string | null;
    version: string;
    basis: "written_signed" | "digital_form" | "verbal_witnessed" | "guardian_proxy" | "institutional_blanket";
    status: "granted" | "declined" | "withdrawn" | "expired";
    grantedAt?: string | null;
    withdrawnAt?: string | null;
    expiresAt?: string | null;
    scope?: string[];
    notes?: string | null;
  };
  identity?: {
    fullName?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    contactHandle?: string | null;
    lawfulBasis: string;
    retentionUntil?: string | null;
  } | null;
}

export function createParticipant(db: Db, input: CreateParticipantInput): {
  participant: ParticipantRow;
  consentId: string;
  identityWritten: boolean;
} {
  if (!input.evidenceDocumentedSourceId) {
    throw new DomainError("participant.missing_provenance", "A participant record requires a documented evidence source.");
  }
  if (!input.consent.version || !input.consent.basis) {
    throw new DomainError("participant.missing_consent", "A participant record requires an explicit consent version and basis.");
  }
  if (input.identity && (!input.identity.lawfulBasis || input.identity.lawfulBasis.trim().length < 4)) {
    throw new DomainError(
      "participant.missing_lawful_basis",
      "Storing identity data requires a documented lawful basis.",
    );
  }
  const source = db
    .prepare("SELECT id FROM documented_source WHERE id = ?")
    .get(input.evidenceDocumentedSourceId) as { id: string } | undefined;
  if (!source) {
    throw new DomainError("participant.unknown_source", `Documented source ${input.evidenceDocumentedSourceId} does not exist.`);
  }

  const pseudonym =
    input.pseudonym?.trim().toUpperCase() ??
    nextPseudonym(db, input.organizationId, input.pseudonymPrefix ?? "P");

  const duplicate = findParticipantByPseudonym(db, input.organizationId, pseudonym);
  if (duplicate) {
    throw new DomainError("participant.duplicate", `Pseudonym ${pseudonym} already exists in this organization.`, {
      participantId: duplicate.id,
    });
  }

  const timestamp = nowIso();
  const attributes = input.attributes;
  const missingness: Record<string, string> = {};
  for (const field of ATTRIBUTE_FIELDS) {
    const value = attributes[field];
    if (value === null || value === undefined || value === "") {
      missingness[field] = "not_documented_in_source";
    }
  }
  for (const unknown of input.unknownAttributes ?? []) {
    missingness[unknown] = "not_documented_in_source";
  }

  const participant: ParticipantRow = {
    id: newId("par"),
    organization_id: input.organizationId,
    pseudonym,
    birth_year: toIntegerOrNull(attributes.birth_year),
    age_at_enrolment: toIntegerOrNull(attributes.age_at_enrolment),
    self_described_gender: toStringOrNull(attributes.self_described_gender),
    preferred_language: toStringOrNull(attributes.preferred_language),
    education_level: toStringOrNull(attributes.education_level),
    region: toStringOrNull(attributes.region),
    recruitment_channel: toStringOrNull(attributes.recruitment_channel),
    attribute_missingness_json: JSON.stringify(missingness),
    notes: input.notes ?? null,
    created_by: input.createdBy ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  const consentId = newId("cns");
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO participant (id, organization_id, pseudonym, birth_year, age_at_enrolment, self_described_gender,
         preferred_language, education_level, region, recruitment_channel, attribute_missingness_json, notes,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      participant.id,
      participant.organization_id,
      participant.pseudonym,
      participant.birth_year,
      participant.age_at_enrolment,
      participant.self_described_gender,
      participant.preferred_language,
      participant.education_level,
      participant.region,
      participant.recruitment_channel,
      participant.attribute_missingness_json,
      participant.notes,
      participant.created_by,
      participant.created_at,
      participant.updated_at,
    );

    db.prepare(
      `INSERT INTO consent_record (id, participant_id, study_id, consent_version, status, basis, granted_at,
         withdrawn_at, expires_at, scope_json, evidence_source_id, recorded_by, recorded_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      consentId,
      participant.id,
      input.consent.studyId,
      input.consent.version,
      input.consent.status,
      input.consent.basis,
      input.consent.grantedAt ?? (input.consent.status === "granted" ? timestamp : null),
      input.consent.withdrawnAt ?? null,
      input.consent.expiresAt ?? null,
      JSON.stringify(input.consent.scope ?? ["assessment", "analysis", "reported_aggregate"]),
      input.evidenceDocumentedSourceId,
      input.createdBy ?? null,
      timestamp,
      input.consent.notes ?? null,
    );

    db.prepare(
      `INSERT INTO evidence_link (id, documented_source_id, entity_type, entity_id, locator, note, created_at)
       VALUES (?, ?, 'participant', ?, ?, ?, ?)`,
    ).run(
      newId("evl"),
      input.evidenceDocumentedSourceId,
      participant.id,
      input.evidenceLocator,
      `Participant ${participant.pseudonym} created from documented source`,
      timestamp,
    );
  });
  tx();

  let identityWritten = false;
  if (input.identity) {
    upsertPrivateIdentity(db, {
      participantId: participant.id,
      fullName: input.identity.fullName ?? null,
      contactEmail: input.identity.contactEmail ?? null,
      contactPhone: input.identity.contactPhone ?? null,
      contactHandle: input.identity.contactHandle ?? null,
      lawfulBasis: input.identity.lawfulBasis,
      retentionUntil: input.identity.retentionUntil ?? null,
      recordedBy: input.createdBy ?? null,
    });
    identityWritten = true;
  }

  return { participant, consentId, identityWritten };
}

export function upsertPrivateIdentity(
  db: Db,
  input: {
    participantId: string;
    fullName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    contactHandle: string | null;
    lawfulBasis: string;
    retentionUntil?: string | null;
    recordedBy?: string | null;
  },
): void {
  const basis = input.lawfulBasis.trim();
  if (!basis) {
    throw new DomainError("participant.missing_lawful_basis", "Private identity requires a documented lawful basis.");
  }
  const timestamp = nowIso();
  const email = input.contactEmail?.trim().toLowerCase() ?? null;
  if (email) {
    const clash = db
      .prepare("SELECT participant_id FROM participant_private_identity WHERE contact_email = ? AND participant_id <> ?")
      .get(email, input.participantId) as { participant_id: string } | undefined;
    if (clash) {
      throw new DomainError("identity.duplicate_email", `E-mail already linked to another participant record.`, {
        participantId: clash.participant_id,
      });
    }
  }
  db.prepare(
    `INSERT INTO participant_private_identity (participant_id, full_name, contact_email, contact_phone, contact_handle,
       lawful_basis, retention_until, recorded_by, recorded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(participant_id) DO UPDATE SET
       full_name = COALESCE(excluded.full_name, participant_private_identity.full_name),
       contact_email = COALESCE(excluded.contact_email, participant_private_identity.contact_email),
       contact_phone = COALESCE(excluded.contact_phone, participant_private_identity.contact_phone),
       contact_handle = COALESCE(excluded.contact_handle, participant_private_identity.contact_handle),
       lawful_basis = excluded.lawful_basis,
       retention_until = excluded.retention_until,
       updated_at = excluded.updated_at`,
  ).run(
    input.participantId,
    input.fullName,
    email,
    input.contactPhone,
    input.contactHandle,
    basis,
    input.retentionUntil ?? null,
    input.recordedBy ?? null,
    timestamp,
    timestamp,
  );
}

export function getPrivateIdentity(db: Db, participantId: string): PrivateIdentityRow | undefined {
  return db
    .prepare("SELECT * FROM participant_private_identity WHERE participant_id = ?")
    .get(participantId) as PrivateIdentityRow | undefined;
}

export function findParticipantByIdentityEmail(db: Db, email: string): ParticipantRow | undefined {
  return db
    .prepare(
      `SELECT p.* FROM participant p
       JOIN participant_private_identity i ON i.participant_id = p.id
       WHERE i.contact_email = ?`,
    )
    .get(email.trim().toLowerCase()) as ParticipantRow | undefined;
}

export function recordConsent(
  db: Db,
  input: {
    participantId: string;
    studyId: string | null;
    version: string;
    status: "granted" | "declined" | "withdrawn" | "expired";
    basis: "written_signed" | "digital_form" | "verbal_witnessed" | "guardian_proxy" | "institutional_blanket";
    grantedAt?: string | null;
    withdrawnAt?: string | null;
    expiresAt?: string | null;
    scope?: string[];
    evidenceSourceId?: string | null;
    recordedBy?: string | null;
    notes?: string | null;
  },
): { id: string; supersededConsentId: string | null } {
  const timestamp = nowIso();
  const id = newId("cns");
  let supersededConsentId: string | null = null;

  const tx = db.transaction(() => {
    const active = db
      .prepare(
        `SELECT id FROM consent_record
         WHERE participant_id = ? AND ((study_id IS NULL AND ? IS NULL) OR study_id = ?)
           AND status = 'granted' AND withdrawn_at IS NULL
         ORDER BY recorded_at DESC, rowid DESC LIMIT 1`,
      )
      .get(input.participantId, input.studyId, input.studyId) as { id: string } | undefined;

    if (input.status === "withdrawn" && active) {
      db.prepare("UPDATE consent_record SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?").run(
        input.withdrawnAt ?? timestamp,
        active.id,
      );
      supersededConsentId = active.id;
      return;
    }

    db.prepare(
      `INSERT INTO consent_record (id, participant_id, study_id, consent_version, status, basis, granted_at,
         withdrawn_at, expires_at, scope_json, evidence_source_id, recorded_by, recorded_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.participantId,
      input.studyId,
      input.version,
      input.status,
      input.basis,
      input.grantedAt ?? (input.status === "granted" ? timestamp : null),
      input.withdrawnAt ?? null,
      input.expiresAt ?? null,
      JSON.stringify(input.scope ?? ["assessment", "analysis", "reported_aggregate"]),
      input.evidenceSourceId ?? null,
      input.recordedBy ?? null,
      timestamp,
      input.notes ?? null,
    );
  });
  tx();
  return { id: supersededConsentId ?? id, supersededConsentId };
}

export function listConsentRecords(db: Db, participantId: string): ConsentRow[] {
  return db
    .prepare("SELECT * FROM consent_record WHERE participant_id = ? ORDER BY recorded_at DESC, rowid DESC")
    .all(participantId) as ConsentRow[];
}

export function listAllConsentRecords(db: Db, organizationId: string, limit = 200): Array<ConsentRow & { pseudonym: string }> {
  return db
    .prepare(
      `SELECT cr.*, p.pseudonym FROM consent_record cr
       JOIN participant p ON p.id = cr.participant_id
       WHERE p.organization_id = ? ORDER BY cr.recorded_at DESC LIMIT ?`,
    )
    .all(organizationId, Math.min(limit, 500)) as Array<ConsentRow & { pseudonym: string }>;
}

export function parseMissingness(row: ParticipantRow): Record<string, string> {
  return safeJsonParse<Record<string, string>>(row.attribute_missingness_json, {});
}

export function parseConsentScope(row: ConsentRow): string[] {
  return safeJsonParse<string[]>(row.scope_json, []);
}

export interface ParticipantProfile {
  participant: ParticipantRow;
  missingness: Record<string, string>;
  consents: ConsentRow[];
  enrolments: Array<{ studyId: string; studyCode: string; status: string; enrolledAt: string; source: string }>;
  sessions: Array<{
    sessionId: string;
    studyId: string | null;
    instrumentVersionId: string;
    instrumentTitle: string;
    instrumentAbbreviation: string | null;
    timepointLabel: string;
    completedAt: string | null;
    answered: number;
    missing: number;
    documentedSourceId: string;
    documentedSourceTitle: string;
  }>;
  scores: Array<{
    scoreId: string;
    sessionId: string;
    scaleCode: string;
    scaleTitle: string;
    rawScore: number | null;
    transformedScore: number | null;
    computability: string;
    itemsUsed: number;
    itemsMissing: number;
    algorithmVersion: string;
    computedAt: string;
    supersededById: string | null;
  }>;
  annotations: Array<{ id: string; type: string; body: string; confidence: string | null; createdAt: string }>;
  evidence: Array<{ sourceId: string; title: string; originType: string; reference: string; locator: string | null }>;
}

export function getParticipantProfile(db: Db, participantId: string): ParticipantProfile | null {
  const participant = getParticipant(db, participantId);
  if (!participant) {
    return null;
  }
  const consents = listConsentRecords(db, participantId);
  const enrolments = db
    .prepare(
      `SELECT sp.study_id AS studyId, s.code AS studyCode, sp.status, sp.enrolled_at AS enrolledAt,
              sp.enrolment_source AS source
       FROM study_participant sp JOIN study s ON s.id = sp.study_id
       WHERE sp.participant_id = ? ORDER BY sp.enrolled_at`,
    )
    .all(participantId) as ParticipantProfile["enrolments"];
  const sessions = db
    .prepare(
      `SELECT s.id AS sessionId, s.study_id AS studyId, s.instrument_version_id AS instrumentVersionId,
              i.title AS instrumentTitle, i.abbreviation AS instrumentAbbreviation,
              s.timepoint_label AS timepointLabel, s.completed_at AS completedAt,
              (SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.is_missing = 0) AS answered,
              (SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.is_missing = 1) AS missing,
              s.documented_source_id AS documentedSourceId, ds.title AS documentedSourceTitle
       FROM assessment_session s
       JOIN instrument_version iv ON iv.id = s.instrument_version_id
       JOIN instrument i ON i.id = iv.instrument_id
       JOIN documented_source ds ON ds.id = s.documented_source_id
       WHERE s.participant_id = ? ORDER BY s.created_at DESC`,
    )
    .all(participantId) as ParticipantProfile["sessions"];
  const scores = db
    .prepare(
      `SELECT ds.id AS scoreId, ds.assessment_session_id AS sessionId, sd.scale_code AS scaleCode,
              sd.title AS scaleTitle, ds.raw_score AS rawScore, ds.transformed_score AS transformedScore,
              ds.computability, ds.items_used AS itemsUsed, ds.items_missing AS itemsMissing,
              ds.algorithm_version AS algorithmVersion, ds.computed_at AS computedAt,
              ds.superseded_by_id AS supersededById
       FROM derived_score ds
       JOIN scale_definition sd ON sd.id = ds.scale_definition_id
       WHERE ds.participant_id = ? ORDER BY ds.computed_at DESC, sd.scale_code`,
    )
    .all(participantId) as ParticipantProfile["scores"];
  const annotations = db
    .prepare(
      `SELECT id, annotation_type AS type, body, confidence, created_at AS createdAt
       FROM interpretation_annotation WHERE participant_id = ? ORDER BY created_at DESC`,
    )
    .all(participantId) as ParticipantProfile["annotations"];
  const evidence = db
    .prepare(
      `SELECT el.documented_source_id AS sourceId, ds.title, ds.origin_type AS originType, ds.reference, el.locator
       FROM evidence_link el JOIN documented_source ds ON ds.id = el.documented_source_id
       WHERE el.entity_type = 'participant' AND el.entity_id = ?
       UNION
       SELECT s.documented_source_id AS sourceId, ds.title, ds.origin_type AS originType, ds.reference, NULL AS locator
       FROM assessment_session s JOIN documented_source ds ON ds.id = s.documented_source_id
       WHERE s.participant_id = ?`,
    )
    .all(participantId, participantId) as ParticipantProfile["evidence"];

  return {
    participant,
    missingness: parseMissingness(participant),
    consents,
    enrolments,
    sessions,
    scores,
    annotations,
    evidence,
  };
}

export function updateParticipantAttributes(
  db: Db,
  participantId: string,
  attributes: Partial<Record<AttributeField, string | number | null>>,
): ParticipantRow {
  const current = getParticipant(db, participantId);
  if (!current) {
    throw new DomainError("participant.not_found", `Participant ${participantId} not found.`);
  }
  const merged: ParticipantRow = {
    ...current,
    birth_year: attributes.birth_year === undefined ? current.birth_year : toIntegerOrNull(attributes.birth_year),
    age_at_enrolment:
      attributes.age_at_enrolment === undefined ? current.age_at_enrolment : toIntegerOrNull(attributes.age_at_enrolment),
    self_described_gender:
      attributes.self_described_gender === undefined ? current.self_described_gender : toStringOrNull(attributes.self_described_gender),
    preferred_language:
      attributes.preferred_language === undefined ? current.preferred_language : toStringOrNull(attributes.preferred_language),
    education_level: attributes.education_level === undefined ? current.education_level : toStringOrNull(attributes.education_level),
    region: attributes.region === undefined ? current.region : toStringOrNull(attributes.region),
    recruitment_channel:
      attributes.recruitment_channel === undefined ? current.recruitment_channel : toStringOrNull(attributes.recruitment_channel),
    updated_at: nowIso(),
  };
  const missingness = parseMissingness(merged);
  for (const field of ATTRIBUTE_FIELDS) {
    const value = merged[field];
    if (value === null || value === undefined || value === "") {
      missingness[field] = missingness[field] ?? "not_documented_in_source";
    } else {
      delete missingness[field];
    }
  }
  db.prepare(
    `UPDATE participant SET birth_year = ?, age_at_enrolment = ?, self_described_gender = ?, preferred_language = ?,
       education_level = ?, region = ?, recruitment_channel = ?, attribute_missingness_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    merged.birth_year,
    merged.age_at_enrolment,
    merged.self_described_gender,
    merged.preferred_language,
    merged.education_level,
    merged.region,
    merged.recruitment_channel,
    JSON.stringify(missingness),
    merged.updated_at,
    participantId,
  );
  return { ...merged, attribute_missingness_json: JSON.stringify(missingness) };
}

export function addAnnotation(
  db: Db,
  input: {
    participantId: string;
    assessmentSessionId?: string | null;
    derivedScoreId?: string | null;
    annotationType: "assessor_note" | "hypothesis" | "limitation" | "norm_caution" | "clinical_flag" | "follow_up_required";
    body: string;
    confidence?: "low" | "moderate" | "high" | null;
    authorUserId?: string | null;
  },
): string {
  const id = newId("ann");
  db.prepare(
    `INSERT INTO interpretation_annotation (id, participant_id, assessment_session_id, derived_score_id, annotation_type,
       body, confidence, author_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.participantId,
    input.assessmentSessionId ?? null,
    input.derivedScoreId ?? null,
    input.annotationType,
    input.body,
    input.confidence ?? null,
    input.authorUserId ?? null,
    nowIso(),
  );
  return id;
}

function toIntegerOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringOrNull(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}
