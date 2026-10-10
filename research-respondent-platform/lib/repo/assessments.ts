/**
 * Assessment repository: instrument catalogue, versioned instruments, scales,
 * scoring algorithms, taken sessions, observed answers and derived scores.
 *
 * The repository never mutates recorded answers: correction means recording a
 * new assessment session. Derived scores are written once and superseded, never
 * overwritten (enforced by triggers in migration 0002).
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, safeJsonParse } from "../util/ids.ts";
import { DomainError } from "../domain/types.ts";
import type {
  MissingPolicy,
  ScoreAlgorithmDefinition,
  ScorableAnswer,
  ScorableItem,
  ScaleScoringSpec,
  SessionScoringResult,
} from "../domain/types.ts";
import { scoreSession } from "../domain/scoring.ts";

export interface InstrumentRow {
  id: string;
  organization_id: string | null;
  slug: string;
  title: string;
  abbreviation: string | null;
  authors: string | null;
  tradition: string | null;
  construct_domains_json: string;
  rights_status: string;
  rights_note: string | null;
  license_holder: string | null;
  is_clinical: number;
  requires_supervision: number;
  created_at: string;
}

export interface InstrumentVersionRow {
  id: string;
  instrument_id: string;
  version_label: string;
  language: string;
  adaptation: string | null;
  publication_year: string | null;
  norm_reference: string | null;
  response_format: string | null;
  scoring_notes: string | null;
  is_provisional: number;
  clinical_use_permitted: number;
  limitations: string | null;
  source_document_id: string | null;
  supersedes_id: string | null;
  frozen_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ItemRow {
  id: string;
  instrument_version_id: string;
  item_code: string;
  order_index: number;
  text_verbatim: string;
  text_language: string;
  response_type: string;
  options_json: string;
  min_value: number | null;
  max_value: number | null;
  required: number;
  reverse_scored: number;
  section: string | null;
  rights_note: string | null;
}

export interface ScaleRow {
  id: string;
  instrument_version_id: string;
  scale_code: string;
  title: string;
  kind: string;
  direction: string;
  min_possible: number | null;
  max_possible: number | null;
  interpretation_bands_json: string;
  norm_notes: string | null;
}

export interface AlgorithmRow {
  id: string;
  instrument_version_id: string;
  scale_definition_id: string | null;
  algorithm_version: string;
  algorithm_json: string;
  min_items_required: number;
  missing_policy: MissingPolicy;
  documentation: string | null;
  is_active: number;
  created_by: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  study_id: string | null;
  participant_id: string;
  instrument_version_id: string;
  timepoint_label: string;
  session_index: number;
  administration_mode: string;
  language: string;
  started_at: string | null;
  completed_at: string | null;
  documented_source_id: string;
  protocol_version_id: string | null;
  quality_flags_json: string;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
}

export interface AnswerRow {
  id: string;
  assessment_session_id: string;
  participant_id: string;
  item_definition_id: string;
  item_code: string;
  raw_value_text: string;
  value_numeric: number | null;
  value_coded: string | null;
  is_missing: number;
  missing_reason: string | null;
  response_latency_ms: number | null;
  source_documented_source_id: string;
  source_locator: string;
  collected_at: string | null;
  imported_at: string;
  recorded_by: string | null;
}

export interface DerivedScoreRow {
  id: string;
  assessment_session_id: string;
  participant_id: string;
  scale_definition_id: string;
  score_algorithm_id: string;
  algorithm_version: string;
  raw_score: number | null;
  transformed_score: number | null;
  standardized_score: number | null;
  standard_error: number | null;
  percentile: number | null;
  items_used: number;
  items_missing: number;
  is_provisional: number;
  computability: string;
  not_computable_reason: string | null;
  source_item_ids_json: string;
  computed_at: string;
  computed_by: string | null;
  superseded_by_id: string | null;
}

// ------------------------------------------------------------- instruments --

export function createInstrument(
  db: Db,
  input: {
    organizationId?: string | null;
    slug: string;
    title: string;
    abbreviation?: string | null;
    authors?: string | null;
    tradition?: string | null;
    constructDomains?: string[];
    rightsStatus: "public_domain" | "open_access" | "licensed_local" | "permission_pending" | "restricted_no_redistribution";
    rightsNote?: string | null;
    licenseHolder?: string | null;
    isClinical?: boolean;
    requiresSupervision?: boolean;
  },
): InstrumentRow {
  const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const existing = db.prepare("SELECT * FROM instrument WHERE slug = ?").get(slug) as InstrumentRow | undefined;
  if (existing) {
    return existing;
  }
  if (input.rightsStatus !== "public_domain" && input.rightsStatus !== "open_access" && !input.licenseHolder) {
    throw new DomainError(
      "instrument.missing_license_holder",
      "An instrument that is not public domain or open access must name its license holder or rights contact.",
    );
  }
  const row: InstrumentRow = {
    id: newId("ins"),
    organization_id: input.organizationId ?? null,
    slug,
    title: input.title.trim(),
    abbreviation: input.abbreviation ?? null,
    authors: input.authors ?? null,
    tradition: input.tradition ?? null,
    construct_domains_json: JSON.stringify(input.constructDomains ?? []),
    rights_status: input.rightsStatus,
    rights_note: input.rightsNote ?? null,
    license_holder: input.licenseHolder ?? null,
    is_clinical: input.isClinical ? 1 : 0,
    requires_supervision: input.requiresSupervision ? 1 : 0,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO instrument (id, organization_id, slug, title, abbreviation, authors, tradition, construct_domains_json,
       rights_status, rights_note, license_holder, is_clinical, requires_supervision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.organization_id,
    row.slug,
    row.title,
    row.abbreviation,
    row.authors,
    row.tradition,
    row.construct_domains_json,
    row.rights_status,
    row.rights_note,
    row.license_holder,
    row.is_clinical,
    row.requires_supervision,
    row.created_at,
  );
  return row;
}

export function getInstrumentBySlug(db: Db, slug: string): InstrumentRow | undefined {
  return db.prepare("SELECT * FROM instrument WHERE slug = ?").get(slug) as InstrumentRow | undefined;
}

export function getInstrument(db: Db, id: string): InstrumentRow | undefined {
  return db.prepare("SELECT * FROM instrument WHERE id = ?").get(id) as InstrumentRow | undefined;
}

export function listInstruments(db: Db): Array<InstrumentRow & { version_count: number; item_count: number; answer_count: number }> {
  return db
    .prepare(
      `SELECT i.*,
        (SELECT COUNT(*) FROM instrument_version v WHERE v.instrument_id = i.id) AS version_count,
        (SELECT COUNT(*) FROM item_definition it
           JOIN instrument_version v ON v.id = it.instrument_version_id WHERE v.instrument_id = i.id) AS item_count,
        (SELECT COUNT(*) FROM observed_answer oa
           JOIN assessment_session s ON s.id = oa.assessment_session_id
           JOIN instrument_version v ON v.id = s.instrument_version_id
           WHERE v.instrument_id = i.id) AS answer_count
       FROM instrument i ORDER BY i.title`,
    )
    .all() as Array<InstrumentRow & { version_count: number; item_count: number; answer_count: number }>;
}

export function createInstrumentVersion(
  db: Db,
  input: {
    instrumentId: string;
    versionLabel: string;
    language: string;
    adaptation?: string | null;
    publicationYear?: string | null;
    normReference?: string | null;
    responseFormat?: string | null;
    scoringNotes?: string | null;
    isProvisional?: boolean;
    clinicalUsePermitted?: boolean;
    limitations?: string | null;
    sourceDocumentId?: string | null;
    createdBy?: string | null;
  },
): InstrumentVersionRow {
  const existing = db
    .prepare("SELECT * FROM instrument_version WHERE instrument_id = ? AND version_label = ? AND language = ?")
    .get(input.instrumentId, input.versionLabel, input.language) as InstrumentVersionRow | undefined;
  if (existing) {
    return existing;
  }
  const previous = db
    .prepare("SELECT id FROM instrument_version WHERE instrument_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(input.instrumentId) as { id: string } | undefined;
  const row: InstrumentVersionRow = {
    id: newId("ivr"),
    instrument_id: input.instrumentId,
    version_label: input.versionLabel.trim(),
    language: input.language.trim(),
    adaptation: input.adaptation ?? null,
    publication_year: input.publicationYear ?? null,
    norm_reference: input.normReference ?? null,
    response_format: input.responseFormat ?? null,
    scoring_notes: input.scoringNotes ?? null,
    is_provisional: input.isProvisional ? 1 : 0,
    clinical_use_permitted: input.clinicalUsePermitted ? 1 : 0,
    limitations: input.limitations ?? null,
    source_document_id: input.sourceDocumentId ?? null,
    supersedes_id: previous?.id ?? null,
    frozen_at: null,
    created_by: input.createdBy ?? null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO instrument_version (id, instrument_id, version_label, language, adaptation, publication_year,
       norm_reference, response_format, scoring_notes, is_provisional, clinical_use_permitted, limitations,
       source_document_id, supersedes_id, frozen_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.instrument_id,
    row.version_label,
    row.language,
    row.adaptation,
    row.publication_year,
    row.norm_reference,
    row.response_format,
    row.scoring_notes,
    row.is_provisional,
    row.clinical_use_permitted,
    row.limitations,
    row.source_document_id,
    row.supersedes_id,
    row.frozen_at,
    row.created_by,
    row.created_at,
  );
  return row;
}

export function getInstrumentVersion(db: Db, id: string): InstrumentVersionRow | undefined {
  return db.prepare("SELECT * FROM instrument_version WHERE id = ?").get(id) as InstrumentVersionRow | undefined;
}

export function listInstrumentVersions(db: Db, instrumentId: string): Array<InstrumentVersionRow & { item_count: number; answer_count: number }> {
  return db
    .prepare(
      `SELECT v.*,
        (SELECT COUNT(*) FROM item_definition it WHERE it.instrument_version_id = v.id) AS item_count,
        (SELECT COUNT(*) FROM observed_answer oa JOIN assessment_session s ON s.id = oa.assessment_session_id
          WHERE s.instrument_version_id = v.id) AS answer_count
       FROM instrument_version v WHERE v.instrument_id = ? ORDER BY v.created_at DESC`,
    )
    .all(instrumentId) as Array<InstrumentVersionRow & { item_count: number; answer_count: number }>;
}

export interface ItemInput {
  itemCode: string;
  orderIndex: number;
  textVerbatim: string;
  textLanguage: string;
  responseType: "likert" | "yes_no" | "multiple_choice" | "numeric" | "open_text" | "date" | "categorical";
  options?: string[];
  minValue?: number | null;
  maxValue?: number | null;
  required?: boolean;
  reverseScored?: boolean;
  section?: string | null;
  rightsNote?: string | null;
}

export function addItems(db: Db, instrumentVersionId: string, items: ItemInput[]): ItemRow[] {
  const version = getInstrumentVersion(db, instrumentVersionId);
  if (!version) {
    throw new DomainError("instrument.version_not_found", `Instrument version ${instrumentVersionId} not found.`);
  }
  const answerCount = db
    .prepare(
      `SELECT COUNT(*) AS total FROM observed_answer oa
       JOIN assessment_session s ON s.id = oa.assessment_session_id
       WHERE s.instrument_version_id = ?`,
    )
    .get(instrumentVersionId) as { total: number };
  if (answerCount.total > 0) {
    throw new DomainError(
      "instrument.version_frozen",
      "This instrument version already has recorded answers; its item set is frozen. Create a new version instead.",
    );
  }
  const insert = db.prepare(
    `INSERT INTO item_definition (id, instrument_version_id, item_code, order_index, text_verbatim, text_language,
       response_type, options_json, min_value, max_value, required, reverse_scored, section, rights_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rows: ItemRow[] = [];
  const tx = db.transaction(() => {
    for (const item of items) {
      const row: ItemRow = {
        id: newId("itm"),
        instrument_version_id: instrumentVersionId,
        item_code: item.itemCode.trim(),
        order_index: item.orderIndex,
        text_verbatim: item.textVerbatim,
        text_language: item.textLanguage,
        response_type: item.responseType,
        options_json: JSON.stringify(item.options ?? []),
        min_value: item.minValue ?? null,
        max_value: item.maxValue ?? null,
        required: item.required === false ? 0 : 1,
        reverse_scored: item.reverseScored ? 1 : 0,
        section: item.section ?? null,
        rights_note: item.rightsNote ?? null,
      };
      insert.run(
        row.id,
        row.instrument_version_id,
        row.item_code,
        row.order_index,
        row.text_verbatim,
        row.text_language,
        row.response_type,
        row.options_json,
        row.min_value,
        row.max_value,
        row.required,
        row.reverse_scored,
        row.section,
        row.rights_note,
      );
      rows.push(row);
    }
  });
  tx();
  return rows;
}

export function listItems(db: Db, instrumentVersionId: string): ItemRow[] {
  return db
    .prepare("SELECT * FROM item_definition WHERE instrument_version_id = ? ORDER BY order_index")
    .all(instrumentVersionId) as ItemRow[];
}

export function createScale(
  db: Db,
  input: {
    instrumentVersionId: string;
    scaleCode: string;
    title: string;
    kind: "raw_sum" | "mean" | "weighted_sum" | "factor_score" | "clinical_elevation" | "index";
    direction?: "higher_is_more" | "higher_is_less" | "bipolar";
    minPossible?: number | null;
    maxPossible?: number | null;
    interpretationBands?: Array<{ max: number | null; label: string; note?: string }>;
    normNotes?: string | null;
  },
): ScaleRow {
  const row: ScaleRow = {
    id: newId("scl"),
    instrument_version_id: input.instrumentVersionId,
    scale_code: input.scaleCode.trim().toUpperCase(),
    title: input.title.trim(),
    kind: input.kind,
    direction: input.direction ?? "higher_is_more",
    min_possible: input.minPossible ?? null,
    max_possible: input.maxPossible ?? null,
    interpretation_bands_json: JSON.stringify(input.interpretationBands ?? []),
    norm_notes: input.normNotes ?? null,
  };
  db.prepare(
    `INSERT INTO scale_definition (id, instrument_version_id, scale_code, title, kind, direction, min_possible,
       max_possible, interpretation_bands_json, norm_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.instrument_version_id,
    row.scale_code,
    row.title,
    row.kind,
    row.direction,
    row.min_possible,
    row.max_possible,
    row.interpretation_bands_json,
    row.norm_notes,
  );
  return row;
}

export function listScales(db: Db, instrumentVersionId: string): ScaleRow[] {
  return db
    .prepare("SELECT * FROM scale_definition WHERE instrument_version_id = ? ORDER BY scale_code")
    .all(instrumentVersionId) as ScaleRow[];
}

export function getScaleByCode(db: Db, instrumentVersionId: string, scaleCode: string): ScaleRow | undefined {
  return db
    .prepare("SELECT * FROM scale_definition WHERE instrument_version_id = ? AND scale_code = ?")
    .get(instrumentVersionId, scaleCode.toUpperCase()) as ScaleRow | undefined;
}

export function createScoreAlgorithm(
  db: Db,
  input: {
    instrumentVersionId: string;
    scaleDefinitionId: string | null;
    algorithm: ScoreAlgorithmDefinition;
    createdBy?: string | null;
  },
): AlgorithmRow {
  const existing = db
    .prepare(
      `SELECT * FROM score_algorithm WHERE instrument_version_id = ? AND scale_definition_id IS ?
         AND algorithm_version = ?`,
    )
    .get(input.instrumentVersionId, input.scaleDefinitionId, input.algorithm.algorithmVersion) as AlgorithmRow | undefined;
  if (existing) {
    return existing;
  }
  const row: AlgorithmRow = {
    id: newId("alg"),
    instrument_version_id: input.instrumentVersionId,
    scale_definition_id: input.scaleDefinitionId,
    algorithm_version: input.algorithm.algorithmVersion,
    algorithm_json: JSON.stringify(input.algorithm),
    min_items_required: input.algorithm.minItemsRequired,
    missing_policy: input.algorithm.missingPolicy,
    documentation: input.algorithm.documentation ?? null,
    is_active: 1,
    created_by: input.createdBy ?? null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO score_algorithm (id, instrument_version_id, scale_definition_id, algorithm_version, algorithm_json,
       min_items_required, missing_policy, documentation, is_active, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.instrument_version_id,
    row.scale_definition_id,
    row.algorithm_version,
    row.algorithm_json,
    row.min_items_required,
    row.missing_policy,
    row.documentation,
    row.is_active,
    row.created_by,
    row.created_at,
  );
  return row;
}

export function listAlgorithms(db: Db, instrumentVersionId: string): AlgorithmRow[] {
  return db
    .prepare("SELECT * FROM score_algorithm WHERE instrument_version_id = ? ORDER BY created_at")
    .all(instrumentVersionId) as AlgorithmRow[];
}

export function parseAlgorithmRow(row: AlgorithmRow): ScoreAlgorithmDefinition {
  return safeJsonParse<ScoreAlgorithmDefinition>(row.algorithm_json, {
    algorithmVersion: row.algorithm_version,
    steps: [],
    missingPolicy: row.missing_policy,
    minItemsRequired: row.min_items_required,
  });
}

// ---------------------------------------------------------------- sessions --

export function createAssessmentSession(
  db: Db,
  input: {
    studyId?: string | null;
    participantId: string;
    instrumentVersionId: string;
    timepointLabel: string;
    sessionIndex?: number;
    administrationMode: "self_online" | "self_paper" | "interviewer_assisted" | "group_paper" | "imported_dataset" | "external_form";
    language: string;
    startedAt?: string | null;
    completedAt?: string | null;
    documentedSourceId: string;
    protocolVersionId?: string | null;
    qualityFlags?: string[];
    notes?: string | null;
    recordedBy?: string | null;
  },
): SessionRow {
  const existing = db
    .prepare(
      "SELECT * FROM assessment_session WHERE participant_id = ? AND instrument_version_id = ? AND timepoint_label = ?",
    )
    .get(input.participantId, input.instrumentVersionId, input.timepointLabel) as SessionRow | undefined;
  if (existing) {
    return existing;
  }
  const row: SessionRow = {
    id: newId("ses"),
    study_id: input.studyId ?? null,
    participant_id: input.participantId,
    instrument_version_id: input.instrumentVersionId,
    timepoint_label: input.timepointLabel,
    session_index: input.sessionIndex ?? 1,
    administration_mode: input.administrationMode,
    language: input.language,
    started_at: input.startedAt ?? null,
    completed_at: input.completedAt ?? null,
    documented_source_id: input.documentedSourceId,
    protocol_version_id: input.protocolVersionId ?? null,
    quality_flags_json: JSON.stringify(input.qualityFlags ?? []),
    notes: input.notes ?? null,
    recorded_by: input.recordedBy ?? null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO assessment_session (id, study_id, participant_id, instrument_version_id, timepoint_label, session_index,
       administration_mode, language, started_at, completed_at, documented_source_id, protocol_version_id,
       quality_flags_json, notes, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.study_id,
    row.participant_id,
    row.instrument_version_id,
    row.timepoint_label,
    row.session_index,
    row.administration_mode,
    row.language,
    row.started_at,
    row.completed_at,
    row.documented_source_id,
    row.protocol_version_id,
    row.quality_flags_json,
    row.notes,
    row.recorded_by,
    row.created_at,
  );
  db.prepare("UPDATE instrument_version SET frozen_at = COALESCE(frozen_at, ?) WHERE id = ?").run(
    row.created_at,
    row.instrument_version_id,
  );
  return row;
}

export function getAssessmentSession(db: Db, id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM assessment_session WHERE id = ?").get(id) as SessionRow | undefined;
}

export function listAssessmentSessions(
  db: Db,
  filter: { participantId?: string; studyId?: string; instrumentVersionId?: string; limit?: number },
): Array<SessionRow & { pseudonym: string; instrument_title: string; answer_count: number; missing_count: number }> {
  const clauses: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (filter.participantId) {
    clauses.push("s.participant_id = ?");
    params.push(filter.participantId);
  }
  if (filter.studyId) {
    clauses.push("s.study_id = ?");
    params.push(filter.studyId);
  }
  if (filter.instrumentVersionId) {
    clauses.push("s.instrument_version_id = ?");
    params.push(filter.instrumentVersionId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  return db
    .prepare(
      `SELECT s.*, p.pseudonym, i.title AS instrument_title,
        (SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.is_missing = 0) AS answer_count,
        (SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.is_missing = 1) AS missing_count
       FROM assessment_session s
       JOIN participant p ON p.id = s.participant_id
       JOIN instrument_version iv ON iv.id = s.instrument_version_id
       JOIN instrument i ON i.id = iv.instrument_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY s.created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as Array<
    SessionRow & { pseudonym: string; instrument_title: string; answer_count: number; missing_count: number }
  >;
}

export interface AnswerInput {
  itemDefinitionId: string;
  itemCode: string;
  rawValueText: string;
  valueNumeric: number | null;
  valueCoded: string | null;
  isMissing: boolean;
  missingReason: string | null;
  sourceLocator: string;
  collectedAt?: string | null;
  responseLatencyMs?: number | null;
}

export function persistAnswers(
  db: Db,
  session: SessionRow,
  answers: AnswerInput[],
  recordedBy?: string | null,
): number {
  const insert = db.prepare(
    `INSERT INTO observed_answer (id, assessment_session_id, participant_id, item_definition_id, item_code,
       raw_value_text, value_numeric, value_coded, is_missing, missing_reason, response_latency_ms,
       source_documented_source_id, source_locator, collected_at, imported_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const timestamp = nowIso();
  let written = 0;
  const tx = db.transaction(() => {
    for (const answer of answers) {
      const existing = db
        .prepare("SELECT id FROM observed_answer WHERE assessment_session_id = ? AND item_definition_id = ?")
        .get(session.id, answer.itemDefinitionId) as { id: string } | undefined;
      if (existing) {
        continue;
      }
      insert.run(
        newId("ans"),
        session.id,
        session.participant_id,
        answer.itemDefinitionId,
        answer.itemCode,
        answer.rawValueText,
        answer.valueNumeric,
        answer.valueCoded,
        answer.isMissing ? 1 : 0,
        answer.missingReason,
        answer.responseLatencyMs ?? null,
        session.documented_source_id,
        answer.sourceLocator,
        answer.collectedAt ?? null,
        timestamp,
        recordedBy ?? null,
      );
      written += 1;
    }
  });
  tx();
  return written;
}

export function listAnswers(db: Db, sessionId: string): AnswerRow[] {
  return db
    .prepare(
      `SELECT * FROM observed_answer WHERE assessment_session_id = ? ORDER BY item_code`,
    )
    .all(sessionId) as AnswerRow[];
}

export function listAnswersWithItems(
  db: Db,
  sessionId: string,
): Array<AnswerRow & { question_text: string; order_index: number; reverse_scored: number; options_json: string; response_type: string }> {
  return db
    .prepare(
      `SELECT oa.*, it.text_verbatim AS question_text, it.order_index, it.reverse_scored, it.options_json, it.response_type
       FROM observed_answer oa JOIN item_definition it ON it.id = oa.item_definition_id
       WHERE oa.assessment_session_id = ? ORDER BY it.order_index`,
    )
    .all(sessionId) as Array<
    AnswerRow & { question_text: string; order_index: number; reverse_scored: number; options_json: string; response_type: string }
  >;
}

// ----------------------------------------------------------------- scoring --

export function buildScoringInput(db: Db, sessionId: string): {
  scorableItems: ScorableItem[];
  scorableAnswers: ScorableAnswer[];
  specs: ScaleScoringSpec[];
  session: SessionRow;
  instrumentTitle: string;
  clinicalUsePermitted: boolean;
  provisionalInstrument: boolean;
} {
  const session = getAssessmentSession(db, sessionId);
  if (!session) {
    throw new DomainError("assessment.session_not_found", `Assessment session ${sessionId} not found.`);
  }
  const version = getInstrumentVersion(db, session.instrument_version_id);
  if (!version) {
    throw new DomainError("instrument.version_not_found", `Instrument version ${session.instrument_version_id} not found.`);
  }
  const instrument = getInstrument(db, version.instrument_id);
  const items = listItems(db, session.instrument_version_id);
  const answers = listAnswers(db, sessionId);
  const scales = listScales(db, session.instrument_version_id);
  const algorithms = listAlgorithms(db, session.instrument_version_id);

  const scorableItems: ScorableItem[] = items.map((item) => ({
    itemDefinitionId: item.id,
    itemCode: item.item_code,
    orderIndex: item.order_index,
    responseType: item.response_type as ScorableItem["responseType"],
    minValue: item.min_value,
    maxValue: item.max_value,
    reverseScored: item.reverse_scored === 1,
    isRequired: item.required === 1,
  }));

  const scorableAnswers: ScorableAnswer[] = answers.map((answer) => ({
    itemDefinitionId: answer.item_definition_id,
    itemCode: answer.item_code,
    valueNumeric: answer.value_numeric,
    valueCoded: answer.value_coded,
    rawValueText: answer.raw_value_text,
    isMissing: answer.is_missing === 1,
    missingReason: answer.missing_reason,
  }));

  const specs: ScaleScoringSpec[] = [];
  for (const scale of scales) {
    const algorithmRow = algorithms.find(
      (row) => row.scale_definition_id === scale.id && row.is_active === 1,
    );
    if (!algorithmRow) {
      continue;
    }
    const algorithm = parseAlgorithmRow(algorithmRow);
    specs.push({
      scaleDefinitionId: scale.id,
      scaleCode: scale.scale_code,
      scaleTitle: scale.title,
      kind: scale.kind as ScaleScoringSpec["kind"],
      instrumentVersionId: session.instrument_version_id,
      itemCodes: collectAlgorithmItemCodes(algorithm),
      algorithmId: algorithmRow.id,
      algorithm,
    });
  }

  return {
    scorableItems,
    scorableAnswers,
    specs,
    session,
    instrumentTitle: instrument?.title ?? "Unknown instrument",
    clinicalUsePermitted: version.clinical_use_permitted === 1,
    provisionalInstrument: version.is_provisional === 1,
  };
}

export function collectAlgorithmItemCodes(algorithm: ScoreAlgorithmDefinition): string[] {
  const codes = new Set<string>();
  for (const step of algorithm.steps) {
    switch (step.kind) {
      case "recoded_sum":
      case "mean_of_items":
        step.itemCodes.forEach((code) => codes.add(code));
        break;
      case "weighted_sum":
        step.weights.forEach((weight) => codes.add(weight.itemCode));
        break;
      default:
        break;
    }
  }
  return [...codes].sort();
}

/**
 * Scores a session with the stored algorithm versions and persists the result.
 * Never overwrites an existing score: re-scoring writes a new row and marks the
 * previous row as superseded.
 */
export function scoreAndPersistSession(
  db: Db,
  sessionId: string,
  options: { computedBy?: string | null; scaleCodes?: string[] } = {},
): { result: SessionScoringResult; persistedScoreIds: string[]; supersededScoreIds: string[] } {
  const input = buildScoringInput(db, sessionId);
  const filteredSpecs = options.scaleCodes
    ? input.specs.filter((spec) => options.scaleCodes?.includes(spec.scaleCode))
    : input.specs;
  const result = scoreSession({
    assessmentSessionId: sessionId,
    instrumentVersionId: input.session.instrument_version_id,
    instrumentTitle: input.instrumentTitle,
    clinicalUsePermitted: input.clinicalUsePermitted,
    provisionalInstrument: input.provisionalInstrument,
    items: input.scorableItems,
    answers: input.scorableAnswers,
    scales: filteredSpecs,
  });

  const timestamp = nowIso();
  const persistedScoreIds: string[] = [];
  const supersededScoreIds: string[] = [];
  const insert = db.prepare(
    `INSERT INTO derived_score (id, assessment_session_id, participant_id, scale_definition_id, score_algorithm_id,
       algorithm_version, raw_score, transformed_score, standardized_score, standard_error, percentile, items_used,
       items_missing, is_provisional, computability, not_computable_reason, source_item_ids_json, computed_at,
       computed_by, superseded_by_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const tx = db.transaction(() => {
    for (const score of result.scores) {
      const spec = filteredSpecs.find((item) => item.scaleCode === score.scaleCode);
      if (!spec) {
        continue;
      }
      const existing = db
        .prepare(
          `SELECT id FROM derived_score WHERE assessment_session_id = ? AND scale_definition_id = ?
             AND superseded_by_id IS NULL`,
        )
        .get(sessionId, spec.scaleDefinitionId) as { id: string } | undefined;
      const id = newId("dsc");
      insert.run(
        id,
        sessionId,
        input.session.participant_id,
        spec.scaleDefinitionId,
        spec.algorithmId,
        score.algorithmVersion,
        score.rawScore,
        score.transformedScore,
        score.standardizedScore,
        null,
        score.percentile,
        score.itemsUsed,
        score.itemsMissing,
        score.methodologicallyProvisional ? 1 : 0,
        score.computability,
        score.notComputableReason,
        JSON.stringify(score.sourceItemIds),
        timestamp,
        options.computedBy ?? null,
      );
      persistedScoreIds.push(id);
      if (existing) {
        db.prepare("UPDATE derived_score SET superseded_by_id = ? WHERE id = ?").run(id, existing.id);
        supersededScoreIds.push(existing.id);
      }
    }
  });
  tx();
  return { result, persistedScoreIds, supersededScoreIds };
}

export function listDerivedScores(
  db: Db,
  filter: { participantId?: string; sessionId?: string; studyId?: string; includeSuperseded?: boolean; limit?: number },
): Array<DerivedScoreRow & { scale_code: string; scale_title: string; pseudonym: string }> {
  const clauses: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (filter.participantId) {
    clauses.push("ds.participant_id = ?");
    params.push(filter.participantId);
  }
  if (filter.sessionId) {
    clauses.push("ds.assessment_session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.studyId) {
    clauses.push("s.study_id = ?");
    params.push(filter.studyId);
  }
  if (!filter.includeSuperseded) {
    clauses.push("ds.superseded_by_id IS NULL");
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  return db
    .prepare(
      `SELECT ds.*, sd.scale_code, sd.title AS scale_title, p.pseudonym
       FROM derived_score ds
       JOIN scale_definition sd ON sd.id = ds.scale_definition_id
       JOIN participant p ON p.id = ds.participant_id
       LEFT JOIN assessment_session s ON s.id = ds.assessment_session_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY ds.computed_at DESC LIMIT ?`,
    )
    .all(...params, limit) as Array<DerivedScoreRow & { scale_code: string; scale_title: string; pseudonym: string }>;
}

export function getSessionDetail(db: Db, sessionId: string) {
  const session = getAssessmentSession(db, sessionId);
  if (!session) {
    return null;
  }
  const participant = db.prepare("SELECT pseudonym FROM participant WHERE id = ?").get(session.participant_id) as
    | { pseudonym: string }
    | undefined;
  const instrument = db
    .prepare(
      `SELECT i.title, i.abbreviation, iv.version_label, iv.language, iv.clinical_use_permitted, iv.is_provisional
       FROM instrument_version iv JOIN instrument i ON i.id = iv.instrument_id WHERE iv.id = ?`,
    )
    .get(session.instrument_version_id) as
    | {
        title: string;
        abbreviation: string | null;
        version_label: string;
        language: string;
        clinical_use_permitted: number;
        is_provisional: number;
      }
    | undefined;
  const answers = listAnswersWithItems(db, sessionId);
  const scores = listDerivedScores(db, { sessionId, includeSuperseded: true });
  const source = db.prepare("SELECT * FROM documented_source WHERE id = ?").get(session.documented_source_id) as
    | { id: string; title: string; reference: string; origin_type: string; collected_at: string | null }
    | undefined;
  return {
    session,
    pseudonym: participant?.pseudonym ?? "unknown",
    instrument,
    answers,
    scores,
    source,
  };
}

export function sessionCoverage(db: Db, studyId?: string) {
  const condition = studyId ? "WHERE s.study_id = ?" : "";
  const params = studyId ? [studyId] : [];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              SUM((SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id)) AS answers,
              SUM((SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.is_missing = 1)) AS missing,
              SUM((SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.response_latency_ms IS NOT NULL)) AS withLatency
       FROM assessment_session s ${condition}`,
    )
    .get(...params) as { sessions: number; answers: number | null; missing: number | null; withLatency: number | null };
  return {
    sessions: row.sessions,
    answers: row.answers ?? 0,
    missing: row.missing ?? 0,
    withLatency: row.withLatency ?? 0,
    completeness: row.answers ? 1 - (row.missing ?? 0) / row.answers : null,
  };
}
