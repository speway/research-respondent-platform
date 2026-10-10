/**
 * Builds the mapping source context for preflight: the documented answers,
 * scores and attributes a participant actually has, scoped to a study when one
 * is supplied.
 *
 * Only stored records are read. Nothing is estimated, and a documented missing
 * answer is passed through as missing so the preflight can refuse to fill it.
 */
import type { Db } from "../../db/index.ts";
import type { MappingSourceContext } from "../domain/types.ts";
import { safeJsonParse } from "../util/ids.ts";

export interface PreflightContextInput {
  participantId: string;
  studyId: string;
  /** Restrict answers to a single timepoint label when set. */
  timepointLabel?: string;
  /** Include only the most recent session per instrument version (default true). */
  latestSessionPerInstrument?: boolean;
}

export function loadMappingSourceContext(db: Db, input: PreflightContextInput): MappingSourceContext {
  const participant = db
    .prepare(
      `SELECT id, pseudonym, birth_year, age_at_enrolment, self_described_gender, preferred_language,
              education_level, region, recruitment_channel
       FROM participant WHERE id = ?`,
    )
    .get(input.participantId) as
    | {
        id: string;
        pseudonym: string;
        birth_year: number | null;
        age_at_enrolment: number | null;
        self_described_gender: string | null;
        preferred_language: string | null;
        education_level: string | null;
        region: string | null;
        recruitment_channel: string | null;
      }
    | undefined;

  if (!participant) {
    return emptyContext(input.participantId, "unknown");
  }

  const answerRows = db
    .prepare(
      `SELECT oa.item_definition_id, oa.item_code, it.text_verbatim AS question_text, it.response_type,
              it.options_json, it.min_value, it.max_value, oa.value_numeric, oa.value_coded, oa.raw_value_text,
              oa.is_missing, oa.missing_reason, oa.collected_at, oa.assessment_session_id,
              oa.source_documented_source_id, oa.source_locator, s.timepoint_label, s.instrument_version_id, s.created_at
       FROM observed_answer oa
       JOIN item_definition it ON it.id = oa.item_definition_id
       JOIN assessment_session s ON s.id = oa.assessment_session_id
       WHERE oa.participant_id = ?
       ORDER BY s.created_at DESC, it.order_index`,
    )
    .all(input.participantId) as Array<{
    item_definition_id: string;
    item_code: string;
    question_text: string;
    response_type: string;
    options_json: string;
    min_value: number | null;
    max_value: number | null;
    value_numeric: number | null;
    value_coded: string | null;
    raw_value_text: string;
    is_missing: number;
    missing_reason: string | null;
    collected_at: string | null;
    assessment_session_id: string;
    source_documented_source_id: string;
    source_locator: string;
    timepoint_label: string;
    instrument_version_id: string;
    created_at: string;
  }>;

  const keepLatest = input.latestSessionPerInstrument !== false;
  const seenInstruments = new Set<string>();
  const answers: MappingSourceContext["answers"] = [];
  for (const row of answerRows) {
    if (input.timepointLabel && row.timepoint_label !== input.timepointLabel) {
      continue;
    }
    if (keepLatest) {
      if (seenInstruments.has(row.instrument_version_id)) {
        continue;
      }
      seenInstruments.add(row.instrument_version_id);
    }
    answers.push({
      itemDefinitionId: row.item_definition_id,
      itemCode: row.item_code,
      questionText: row.question_text,
      responseType: row.response_type,
      options: safeJsonArray(row.options_json),
      minValue: row.min_value,
      maxValue: row.max_value,
      valueNumeric: row.value_numeric,
      valueCoded: row.value_coded,
      rawValueText: row.raw_value_text,
      isMissing: row.is_missing === 1,
      missingReason: row.missing_reason,
      collectedAt: row.collected_at,
      sessionId: row.assessment_session_id,
      documentedSourceId: row.source_documented_source_id,
      sourceLocator: row.source_locator,
    });
  }

  const scoreRows = db
    .prepare(
      `SELECT sd.scale_code, sd.title AS scale_title, ds.raw_score, ds.transformed_score, ds.computability,
              ds.algorithm_version, ds.assessment_session_id, s.timepoint_label, s.instrument_version_id, ds.computed_at
       FROM derived_score ds
       JOIN scale_definition sd ON sd.id = ds.scale_definition_id
       JOIN assessment_session s ON s.id = ds.assessment_session_id
       WHERE ds.participant_id = ? AND ds.superseded_by_id IS NULL
       ORDER BY ds.computed_at DESC`,
    )
    .all(input.participantId) as Array<{
    scale_code: string;
    scale_title: string;
    raw_score: number | null;
    transformed_score: number | null;
    computability: string;
    algorithm_version: string;
    assessment_session_id: string;
    timepoint_label: string;
    instrument_version_id: string;
    computed_at: string;
  }>;

  const seenScores = new Set<string>();
  const scores: MappingSourceContext["scores"] = [];
  for (const row of scoreRows) {
    if (input.timepointLabel && row.timepoint_label !== input.timepointLabel) {
      continue;
    }
    const key = `${row.instrument_version_id}:${row.scale_code}`;
    if (keepLatest) {
      if (seenScores.has(key)) {
        continue;
      }
      seenScores.add(key);
    }
    scores.push({
      scaleCode: row.scale_code,
      scaleTitle: row.scale_title,
      rawScore: row.raw_score,
      transformedScore: row.transformed_score,
      computability: row.computability as "computed" | "not_computable",
      algorithmVersion: row.algorithm_version,
      sessionId: row.assessment_session_id,
    });
  }

  return {
    participantId: participant.id,
    pseudonym: participant.pseudonym,
    answers,
    scores,
    attributes: {
      pseudonym: participant.pseudonym,
      birth_year: participant.birth_year,
      age_at_enrolment: participant.age_at_enrolment,
      self_described_gender: participant.self_described_gender,
      preferred_language: participant.preferred_language,
      education_level: participant.education_level,
      region: participant.region,
      recruitment_channel: participant.recruitment_channel,
    },
  };
}

function emptyContext(participantId: string, pseudonym: string): MappingSourceContext {
  return {
    participantId,
    pseudonym,
    answers: [],
    scores: [],
    attributes: {},
  };
}

function safeJsonArray(raw: string): string[] {
  const parsed = safeJsonParse<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
}
