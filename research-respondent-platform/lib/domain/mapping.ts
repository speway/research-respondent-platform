/**
 * External form field mapping validation and preflight.
 *
 * The platform maps ALREADY DOCUMENTED participant data (observed answers,
 * validated scale scores, recorded participant attributes) plus
 * researcher-declared constants onto researcher-controlled external form
 * fields. It never invents, estimates or defaults an answer.
 *
 * Integrity rules enforced here:
 * - a source documented as missing is a blocking reason for a required field, a
 *   warning with the key omitted for an optional field, and never a value, dash,
 *   empty string or placeholder in the payload;
 * - only `pass`/`warn` entries with a resolved documented value reach the
 *   dry-run payload, and every such key carries its provenance in an `info`
 *   `mapping_provenance` issue on the field entry;
 * - `PLATFORM_SUBMISSION_PATH_VERIFIED` is false: there is no verified Google
 *   Forms response-submission API path, so `submissionAllowedByPlatform` is
 *   false and the payload is a dry run for researcher review;
 * - the module is pure: `generatedAt` is injected by the caller and the clock is
 *   never read.
 *
 * Mapping binding convention (the frozen `MappingCandidate` has no field
 * column): `mapping.sourceRef.fieldId` binds a mapping to an
 * `ExternalFormFieldInput.fieldId`; the remaining `sourceRef` keys locate the
 * documented source (`itemCode`/`itemDefinitionId`/`sessionId`, `scaleCode` +
 * `scoreField`, `attribute`, or `value` for a `fixed_constant`).
 */
import { DomainError } from "./types.ts";
import type {
  ExternalFieldType,
  ExternalFormFieldInput,
  FieldMappingValidation,
  MappingCandidate,
  MappingSourceContext,
  PreflightReport,
  RuleIssue,
} from "./types.ts";

/**
 * The platform has no verified Google Forms response-submission API path:
 * Google Forms documents no endpoint that creates a form response. Flip this
 * only together with recorded provider evidence (see
 * `external_form.api_can_submit_responses`).
 */
export const PLATFORM_SUBMISSION_PATH_VERIFIED = false;

const SUBMISSION_PATH_NOTES =
  "No verified Google Forms response-submission API exists: the platform cannot submit a response, so this report is a dry run for researcher review (submissionAllowedByPlatform=false).";

const OUTCOME_NOTE =
  'the outcome reflects mapping and consent findings; it is never "pass" while external submission is blocked by platform policy, so this report is a review artifact, not an authorization to submit.';

/** Exact phrase required wherever a documented source carries no recorded answer. */
export const MISSING_SOURCE_MESSAGE = "source answer is documented as missing";

/** Appended to every suggestion: suggestions are never auto-committed. */
export const SUGGESTION_ACCEPTANCE_NOTE = "suggestion only: a researcher must accept it before it is used";

const MISSING_SOURCE_ISSUE_CODES: ReadonlySet<string> = new Set([
  "source_answer_missing",
  "source_answer_empty_text",
  "source_attribute_missing",
  "source_score_not_computable",
  "source_score_value_missing",
]);

const CHOICE_FIELD_TYPES: ReadonlySet<ExternalFieldType> = new Set<ExternalFieldType>([
  "multiple_choice",
  "checkbox",
  "dropdown",
]);

const UNMAPPABLE_FIELD_TYPES: ReadonlySet<ExternalFieldType> = new Set<ExternalFieldType>([
  "section_header",
  "grid",
  "file_upload",
  "unknown",
]);

const UNMAPPABLE_REASONS: Record<string, string> = {
  section_header: "a section header carries no answer; mapping it would fabricate a value",
  grid: "a grid field needs one documented answer per cell; a single mapping cannot fill it",
  file_upload: "a file upload cannot be filled from a documented answer",
  unknown: "the field type is not documented, so the payload format cannot be verified",
};

const DATE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "date",
  "datetime",
  "date_time",
  "timestamp",
  "iso_date",
]);

const TIME_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "time",
  "clock_time",
  "datetime",
  "date_time",
  "timestamp",
]);

/** Identity data lives in the restricted identity table and never in an external form. */
const IDENTITY_ATTRIBUTE =
  /(^|_)(e?mail|email_address|phone|mobile|telephone|contact|contact_email|contact_phone|full_name|first_name|last_name|middle_name|family_name|surname|home_address|postal_address|passport|national_id|tax_id|ssn|dob|date_of_birth|birth_date)(_|$)/i;
const IDENTITY_ATTRIBUTE_EXACT: ReadonlySet<string> = new Set(["name", "fullname", "fio", "фио", "имя", "фамилия"]);

const LEADING_NUMBERING = /^(?:(?:q(?:uestion)?|item|вопрос|пункт|no|№)\s*\.?\s*)?\d{1,3}\s*[.)\]\-–—:]?\s+(?=\S)/i;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/;
const SLASH_DATE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const CLOCK_TIME = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
const DECIMAL_COMMA = /^\d+,\d+$/;
const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const CHECKBOX_SPLITS: readonly RegExp[] = [/\r?\n+/, /\s*;\s*/, /\s*\|\s*/, /\s*,\s*/];

type DocumentedAnswer = MappingSourceContext["answers"][number];
type DocumentedScore = MappingSourceContext["scores"][number];

export interface PreflightInput {
  studyId: string;
  participantId: string;
  externalFormVersionId: string;
  fields: ExternalFormFieldInput[];
  mappings: MappingCandidate[];
  context: MappingSourceContext;
  consent: { status: string; version: string | null; withdrawnAt: string | null };
  platformSubmissionAuthorized: boolean;
  /** Injected by the caller; the module never reads the clock. */
  generatedAt?: string;
}

export interface MappingSuggestion {
  fieldId: string;
  suggestionKind: MappingCandidate["mappingKind"];
  confidence: "high" | "medium" | "low";
  reason: string;
  sourceRef: Record<string, unknown>;
}

export interface VersionDriftReport {
  added: string[];
  removed: string[];
  retitled: Array<{ fieldId: string; previousTitle: string; currentTitle: string }>;
  retyped: Array<{ fieldId: string; previousType: ExternalFieldType; currentType: ExternalFieldType }>;
  optionsAdded: Array<{ fieldId: string; options: string[] }>;
  optionsRemoved: Array<{ fieldId: string; options: string[] }>;
  /** Ranks are positions in the version's (orderIndex, fieldId) order. */
  reordered: Array<{ fieldId: string; previousIndex: number; currentIndex: number }>;
}

// ------------------------------------------------------------------ utilities --

function issue(
  code: string,
  severity: RuleIssue["severity"],
  message: string,
  detail?: Record<string, unknown>,
): RuleIssue {
  return detail === undefined ? { code, severity, message } : { code, severity, message, detail };
}

function outcomeOf(issues: RuleIssue[]): FieldMappingValidation["outcome"] {
  if (issues.some((entry) => entry.severity === "fail")) return "fail";
  if (issues.some((entry) => entry.severity === "warn")) return "warn";
  return "pass";
}

function asText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstNonEmpty(candidates: Array<string | null>): string | null {
  for (const candidate of candidates) {
    if (candidate !== null && candidate.trim() !== "") return candidate;
  }
  return null;
}

function describeSourceRef(itemCode: string | null, itemDefinitionId: string | null): string {
  const parts: string[] = [];
  if (itemCode !== null) parts.push(`itemCode "${itemCode}"`);
  if (itemDefinitionId !== null) parts.push(`itemDefinitionId "${itemDefinitionId}"`);
  return parts.length === 0 ? "an unspecified item" : parts.join(" / ");
}

export function normaliseTitle(input: string): string {
  const folded = input.replace(/\u00a0/g, " ").toLowerCase().trim();
  return folded
    .replace(LEADING_NUMBERING, "")
    .replace(NON_WORD, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseOptionLabel(input: string): string {
  return input.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseDocumentedNumber(text: string): number | null {
  const trimmed = text.trim();
  const normalised = DECIMAL_COMMA.test(trimmed) ? trimmed.replace(",", ".") : trimmed;
  if (!NUMERIC_TEXT.test(normalised)) return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

function documentDateToIso(text: string): string | null {
  const trimmed = text.trim();
  const match = ISO_DATE.exec(trimmed) ?? SLASH_DATE.exec(trimmed);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function documentTimeToHhMm(text: string): string | null {
  const match = CLOCK_TIME.exec(text.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Scale points of a `linear_scale` field, when every option is numeric. */
function fieldScaleRange(field: ExternalFormFieldInput): { min: number; max: number } | null {
  if (field.fieldType !== "linear_scale" || field.options.length === 0) return null;
  const points: number[] = [];
  for (const option of field.options) {
    const value = parseDocumentedNumber(option);
    if (value === null) return null;
    points.push(value);
  }
  return { min: Math.min(...points), max: Math.max(...points) };
}

function isIdentityAttribute(attribute: string): boolean {
  return IDENTITY_ATTRIBUTE_EXACT.has(attribute.toLowerCase()) || IDENTITY_ATTRIBUTE.test(attribute);
}

function mergeSortKey(...parts: string[]): string {
  return parts.join("\u0000");
}

function compareByKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ------------------------------------------------------------- source resolver --

interface SourceSite {
  provenance: string;
  detail: Record<string, unknown>;
}

interface ResolvedSource extends SourceSite {
  state: "resolved";
  text: string;
  numeric: number | null;
  sourceResponseType: string | null;
  sourceMin: number | null;
  sourceMax: number | null;
}

type SourceResolution =
  | ResolvedSource
  | ({ state: "missing"; issue: RuleIssue } & SourceSite)
  | ({ state: "invalid"; issue: RuleIssue } & SourceSite);

function compareAnswers(left: DocumentedAnswer, right: DocumentedAnswer): number {
  return compareByKey(
    mergeSortKey(left.documentedSourceId, left.sessionId, left.sourceLocator),
    mergeSortKey(right.documentedSourceId, right.sessionId, right.sourceLocator),
  );
}

function resolveObservedAnswer(mapping: MappingCandidate, context: MappingSourceContext): SourceResolution {
  const itemCode = asText(mapping.sourceRef.itemCode);
  const itemDefinitionId = asText(mapping.sourceRef.itemDefinitionId);
  const reference = describeSourceRef(itemCode, itemDefinitionId);
  const detail: Record<string, unknown> = {
    mappingKind: "observed_answer",
    mappingId: mapping.mappingId,
    valueTransform: mapping.valueTransform,
    itemCode,
    itemDefinitionId,
    sourceRef: mapping.sourceRef,
  };
  if (itemCode === null && itemDefinitionId === null) {
    return {
      state: "invalid",
      issue: issue(
        "mapping_source_ref_missing",
        "fail",
        `observed_answer mapping "${mapping.mappingId}" declares neither sourceRef.itemCode nor sourceRef.itemDefinitionId, so no documented answer can be identified`,
        detail,
      ),
      provenance: `observed_answer mapping "${mapping.mappingId}" has no documented source reference`,
      detail,
    };
  }
  const sessionId = asText(mapping.sourceRef.sessionId);
  const matches = context.answers
    .filter(
      (candidate) =>
        (itemCode !== null && candidate.itemCode === itemCode) ||
        (itemDefinitionId !== null && candidate.itemDefinitionId === itemDefinitionId),
    )
    .filter((candidate) => sessionId === null || candidate.sessionId === sessionId);
  if (matches.length === 0) {
    return {
      state: "invalid",
      issue: issue(
        "source_answer_not_found",
        "fail",
        `no documented answer found for ${reference}${sessionId === null ? "" : ` in session "${sessionId}"`}; the mapping reference is broken`,
        { ...detail, sessionId, availableItemCodes: [...new Set(context.answers.map((entry) => entry.itemCode))].sort() },
      ),
      provenance: `documented answer for ${reference} not found`,
      detail,
    };
  }
  const distinct = new Set(
    matches.map((entry) =>
      mergeSortKey(
        entry.documentedSourceId,
        entry.sessionId,
        String(entry.isMissing),
        entry.rawValueText,
        entry.valueCoded ?? "",
      ),
    ),
  );
  if (distinct.size > 1) {
    return {
      state: "invalid",
      issue: issue(
        "source_answer_ambiguous",
        "fail",
        `${matches.length} different documented answers match ${reference}; set sourceRef.sessionId to pin the intended source`,
        { ...detail, sessionId, documentedSourceIds: [...new Set(matches.map((entry) => entry.documentedSourceId))].sort() },
      ),
      provenance: `ambiguous documented answer for ${reference}`,
      detail,
    };
  }
  const documented = matches.reduce((best, candidate) =>
    compareAnswers(candidate, best) < 0 ? candidate : best,
  );
  const site: SourceSite = {
    provenance: `item "${documented.itemCode}" from documented source "${documented.documentedSourceId}" at ${documented.sourceLocator} (session ${documented.sessionId}${documented.collectedAt === null ? "" : `, collected ${documented.collectedAt}`}), transform ${mapping.valueTransform}`,
    detail: {
      mappingKind: "observed_answer",
      mappingId: mapping.mappingId,
      valueTransform: mapping.valueTransform,
      itemCode: documented.itemCode,
      itemDefinitionId: documented.itemDefinitionId,
      sessionId: documented.sessionId,
      documentedSourceId: documented.documentedSourceId,
      sourceLocator: documented.sourceLocator,
      responseType: documented.responseType,
      collectedAt: documented.collectedAt,
      isMissing: documented.isMissing,
      missingReason: documented.missingReason,
    },
  };
  if (documented.isMissing) {
    return {
      state: "missing",
      // Severity is finalised by validateMapping from field.isRequired.
      issue: issue(
        "source_answer_missing",
        "fail",
        `${MISSING_SOURCE_MESSAGE}: item "${documented.itemCode}" from documented source "${documented.documentedSourceId}"${documented.missingReason === null ? "" : ` (${documented.missingReason})`}; no value is substituted`,
        {
          itemCode: documented.itemCode,
          documentedSourceId: documented.documentedSourceId,
          sourceLocator: documented.sourceLocator,
          missingReason: documented.missingReason,
        },
      ),
      ...site,
    };
  }
  const numeric =
    documented.valueNumeric ??
    parseDocumentedNumber(documented.valueCoded ?? "") ??
    parseDocumentedNumber(documented.rawValueText);
  const preferCoded = mapping.valueTransform === "option_label" || mapping.valueTransform === "option_index";
  const text =
    firstNonEmpty(preferCoded ? [documented.valueCoded, documented.rawValueText] : [documented.rawValueText, documented.valueCoded]) ??
    (documented.valueNumeric === null ? null : String(documented.valueNumeric));
  if (text === null) {
    return {
      state: "missing",
      issue: issue(
        "source_answer_empty_text",
        "fail",
        `item "${documented.itemCode}" is documented without any recorded text; an empty value is never inserted into the payload`,
        { itemCode: documented.itemCode, documentedSourceId: documented.documentedSourceId, sourceLocator: documented.sourceLocator },
      ),
      ...site,
    };
  }
  return {
    state: "resolved",
    text,
    numeric,
    sourceResponseType: documented.responseType,
    sourceMin: documented.minValue,
    sourceMax: documented.maxValue,
    ...site,
  };
}

function resolveDerivedScore(mapping: MappingCandidate, context: MappingSourceContext): SourceResolution {
  const scaleCode = asText(mapping.sourceRef.scaleCode);
  if (scaleCode === null) {
    const detail = { mappingKind: "derived_score", mappingId: mapping.mappingId, sourceRef: mapping.sourceRef };
    return {
      state: "invalid",
      issue: issue(
        "mapping_source_ref_missing",
        "fail",
        `derived_score mapping "${mapping.mappingId}" declares no sourceRef.scaleCode, so no documented score can be identified`,
        detail,
      ),
      provenance: `derived_score mapping "${mapping.mappingId}" has no documented scale reference`,
      detail,
    };
  }
  const scoreField = asText(mapping.sourceRef.scoreField) ?? "raw";
  if (scoreField !== "raw" && scoreField !== "transformed") {
    const detail = { mappingKind: "derived_score", mappingId: mapping.mappingId, scaleCode, scoreField };
    return {
      state: "invalid",
      issue: issue(
        "mapping_source_ref_invalid",
        "fail",
        `sourceRef.scoreField "${scoreField}" is not a documented score field; use "raw" or "transformed"`,
        detail,
      ),
      provenance: `derived_score mapping "${mapping.mappingId}" names an unknown score field`,
      detail,
    };
  }
  const sessionId = asText(mapping.sourceRef.sessionId);
  const matches = context.scores
    .filter((entry) => entry.scaleCode === scaleCode)
    .filter((entry) => sessionId === null || entry.sessionId === sessionId);
  if (matches.length === 0) {
    const detail = { mappingKind: "derived_score", mappingId: mapping.mappingId, scaleCode, sessionId };
    return {
      state: "invalid",
      issue: issue(
        "source_score_not_found",
        "fail",
        `no documented score for scale "${scaleCode}"${sessionId === null ? "" : ` in session "${sessionId}"`}; the mapping reference is broken`,
        { ...detail, availableScaleCodes: [...new Set(context.scores.map((entry) => entry.scaleCode))].sort() },
      ),
      provenance: `documented score for scale "${scaleCode}" not found`,
      detail,
    };
  }
  const distinct = new Set(matches.map((entry) => mergeSortKey(entry.sessionId, entry.algorithmVersion)));
  if (distinct.size > 1) {
    const detail = { mappingKind: "derived_score", mappingId: mapping.mappingId, scaleCode, sessionId };
    return {
      state: "invalid",
      issue: issue(
        "source_score_ambiguous",
        "fail",
        `${matches.length} documented scores match scale "${scaleCode}" with different algorithm versions; set sourceRef.sessionId to pin the intended source`,
        { ...detail, algorithmVersions: [...new Set(matches.map((entry) => entry.algorithmVersion))].sort() },
      ),
      provenance: `ambiguous documented score for scale "${scaleCode}"`,
      detail,
    };
  }
  const score: DocumentedScore = matches.reduce((best, candidate) =>
    compareByKey(mergeSortKey(candidate.sessionId, candidate.algorithmVersion), mergeSortKey(best.sessionId, best.algorithmVersion)) < 0
      ? candidate
      : best,
  );
  const site: SourceSite = {
    provenance: `derived score "${score.scaleCode}" (${score.scaleTitle}), documented ${scoreField} score from algorithm ${score.algorithmVersion} in session ${score.sessionId}, computability ${score.computability}, transform ${mapping.valueTransform}`,
    detail: {
      mappingKind: "derived_score",
      mappingId: mapping.mappingId,
      valueTransform: mapping.valueTransform,
      scaleCode: score.scaleCode,
      scaleTitle: score.scaleTitle,
      sessionId: score.sessionId,
      scoreField,
      computability: score.computability,
      algorithmVersion: score.algorithmVersion,
    },
  };
  if (score.computability === "not_computable") {
    return {
      state: "missing",
      issue: issue(
        "source_score_not_computable",
        "fail",
        `scale "${score.scaleCode}" is documented as not computable (algorithm ${score.algorithmVersion}); no score value is invented`,
        { scaleCode: score.scaleCode, algorithmVersion: score.algorithmVersion, sessionId: score.sessionId },
      ),
      ...site,
    };
  }
  const value = scoreField === "raw" ? score.rawScore : score.transformedScore;
  if (value === null) {
    return {
      state: "missing",
      issue: issue(
        "source_score_value_missing",
        "fail",
        `scale "${score.scaleCode}" has no documented ${scoreField} score (documented as missing); no value is substituted`,
        { scaleCode: score.scaleCode, scoreField, sessionId: score.sessionId },
      ),
      ...site,
    };
  }
  return {
    state: "resolved",
    text: String(value),
    numeric: value,
    sourceResponseType: "numeric",
    sourceMin: null,
    sourceMax: null,
    ...site,
  };
}

function resolveParticipantAttribute(mapping: MappingCandidate, context: MappingSourceContext): SourceResolution {
  const attribute = asText(mapping.sourceRef.attribute);
  const detail: Record<string, unknown> = {
    mappingKind: "participant_attribute",
    mappingId: mapping.mappingId,
    attribute,
    participantId: context.participantId,
    pseudonym: context.pseudonym,
  };
  if (attribute === null) {
    return {
      state: "invalid",
      issue: issue(
        "mapping_source_ref_missing",
        "fail",
        `participant_attribute mapping "${mapping.mappingId}" declares no sourceRef.attribute, so no documented attribute can be identified`,
        detail,
      ),
      provenance: `participant_attribute mapping "${mapping.mappingId}" has no documented attribute reference`,
      detail,
    };
  }
  if (isIdentityAttribute(attribute)) {
    return {
      state: "invalid",
      issue: issue(
        "identity_attribute_not_permitted",
        "fail",
        `participant attribute "${attribute}" is an identity field; identity data belongs to the restricted identity table and must never be written into an external form`,
        detail,
      ),
      provenance: `participant attribute "${attribute}" refused as identity data`,
      detail,
    };
  }
  const present = Object.prototype.hasOwnProperty.call(context.attributes, attribute);
  const value = present ? (context.attributes[attribute] ?? null) : null;
  const site: SourceSite = {
    provenance: `participant attribute "${attribute}" from the participant record of pseudonym "${context.pseudonym}"`,
    detail: { ...detail, documentedAttribute: present },
  };
  if (!present || value === null || (typeof value === "string" && value.trim() === "")) {
    return {
      state: "missing",
      issue: issue(
        "source_attribute_missing",
        "fail",
        `participant attribute "${attribute}" is documented as missing for this participant; no value is substituted`,
        { attribute, participantId: context.participantId, attributePresent: present },
      ),
      ...site,
    };
  }
  const text = String(value);
  return {
    state: "resolved",
    text,
    numeric: typeof value === "number" ? value : parseDocumentedNumber(text),
    sourceResponseType: null,
    sourceMin: null,
    sourceMax: null,
    ...site,
  };
}

function resolveFixedConstant(mapping: MappingCandidate): SourceResolution {
  const raw = mapping.sourceRef.value;
  const detail: Record<string, unknown> = {
    mappingKind: "fixed_constant",
    mappingId: mapping.mappingId,
    declaredValue: raw === undefined ? null : raw,
    rationale: mapping.rationale,
  };
  const usable = typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean";
  const text = usable ? String(raw).trim() : "";
  if (!usable || text === "") {
    return {
      state: "invalid",
      issue: issue(
        "fixed_constant_value_missing",
        "fail",
        `fixed_constant mapping "${mapping.mappingId}" declares no usable sourceRef.value; a constant must be declared explicitly by the researcher`,
        detail,
      ),
      provenance: `fixed_constant mapping "${mapping.mappingId}" declares no value`,
      detail,
    };
  }
  return {
    state: "resolved",
    text,
    numeric: typeof raw === "number" ? raw : parseDocumentedNumber(text),
    sourceResponseType: "fixed_constant",
    sourceMin: null,
    sourceMax: null,
    provenance: `researcher-declared fixed constant ${JSON.stringify(raw)} (a declaration, not a participant answer)`,
    detail,
  };
}

// --------------------------------------------------------------- serialisation --

interface MatchedOption {
  canonical: string;
  index: number;
}

interface SerialisedValue {
  value: string;
  display: string;
  valueKind: FieldMappingValidation["valueKind"];
}

type SerialisedResult = { ok: true; serialised: SerialisedValue } | { ok: false; issue: RuleIssue };

function matchOneOption(field: ExternalFormFieldInput, label: string): MatchedOption | null {
  const target = normaliseOptionLabel(label);
  if (target === "") return null;
  for (let index = 0; index < field.options.length; index += 1) {
    const option = field.options[index];
    if (option !== undefined && normaliseOptionLabel(option) === target) return { canonical: option, index };
  }
  return null;
}

/**
 * Matches the documented value against the form's own option labels and returns
 * the stored labels (matching is whitespace/case-normalised; the payload always
 * carries the field's own wording). Checkbox values are tried as a whole first,
 * then split on newline, `;`, `|` and `,` so that option labels containing a
 * comma are not split incorrectly.
 */
function matchOptionLabels(field: ExternalFormFieldInput, text: string): MatchedOption[] | null {
  const attempts: string[][] = [[text]];
  for (const separator of CHECKBOX_SPLITS) attempts.push(text.split(separator));
  for (const parts of attempts) {
    const trimmed = parts.map((part) => part.trim()).filter((part) => part !== "");
    if (trimmed.length === 0) continue;
    const resolved: MatchedOption[] = [];
    let complete = true;
    for (const part of trimmed) {
      const matched = matchOneOption(field, part);
      if (matched === null) {
        complete = false;
        break;
      }
      resolved.push(matched);
    }
    if (!complete) continue;
    if (field.fieldType !== "checkbox" && resolved.length > 1) continue;
    return resolved;
  }
  return null;
}

function serialiseValue(field: ExternalFormFieldInput, mapping: MappingCandidate, source: ResolvedSource): SerialisedResult {
  const { text, numeric } = source;
  if (field.fieldType === "date") {
    const responseType = source.sourceResponseType === null ? null : source.sourceResponseType.toLowerCase();
    if (responseType !== null && !DATE_SOURCE_TYPES.has(responseType)) {
      return {
        ok: false,
        issue: issue(
          "field_type_source_type_mismatch",
          "fail",
          `field "${field.fieldId}" is a date field but the mapped source is documented as responseType "${source.sourceResponseType}"; only a documented date source may fill a date field`,
          { observed: text, responseType: source.sourceResponseType, acceptedResponseTypes: [...DATE_SOURCE_TYPES].sort() },
        ),
      };
    }
    const iso = documentDateToIso(text);
    if (iso === null) {
      return {
        ok: false,
        issue: issue(
          "value_not_iso_date",
          "fail",
          `documented value cannot be read as a calendar date; accepted forms are YYYY-MM-DD, YYYY/MM/DD or an ISO timestamp`,
          { observed: text },
        ),
      };
    }
    return { ok: true, serialised: { value: iso, display: iso, valueKind: "date" } };
  }
  if (field.fieldType === "time") {
    const responseType = source.sourceResponseType === null ? null : source.sourceResponseType.toLowerCase();
    if (responseType !== null && !TIME_SOURCE_TYPES.has(responseType)) {
      return {
        ok: false,
        issue: issue(
          "field_type_source_type_mismatch",
          "fail",
          `field "${field.fieldId}" is a time field but the mapped source is documented as responseType "${source.sourceResponseType}"; only a documented time source may fill a time field`,
          { observed: text, responseType: source.sourceResponseType, acceptedResponseTypes: [...TIME_SOURCE_TYPES].sort() },
        ),
      };
    }
    const clock = documentTimeToHhMm(text);
    if (clock === null) {
      return {
        ok: false,
        issue: issue("value_not_clock_time", "fail", "documented value cannot be read as HH:MM", { observed: text }),
      };
    }
    return { ok: true, serialised: { value: clock, display: clock, valueKind: "text" } };
  }
  if (field.fieldType === "linear_scale") {
    if (numeric === null) {
      return {
        ok: false,
        issue: issue(
          "linear_scale_requires_numeric_source",
          "fail",
          `field "${field.fieldId}" is a linear scale but the documented value is not numeric; a scale point is never guessed`,
          { observed: text },
        ),
      };
    }
    const value = mapping.valueTransform === "numeric_round" ? Math.round(numeric) : numeric;
    const range = fieldScaleRange(field);
    if (range !== null && (value < range.min || value > range.max)) {
      return {
        ok: false,
        issue: issue(
          "value_out_of_scale_range",
          "fail",
          `documented value ${value} is outside the field's linear scale range ${range.min}–${range.max}; the platform never clamps or re-codes a documented answer`,
          { observed: value, allowedRange: [range.min, range.max] },
        ),
      };
    }
    if (source.sourceMin !== null && source.sourceMax !== null && (value < source.sourceMin || value > source.sourceMax)) {
      return {
        ok: false,
        issue: issue(
          "value_out_of_source_range",
          "fail",
          `documented value ${value} is outside the documented source range ${source.sourceMin}–${source.sourceMax}`,
          { observed: value, allowedRange: [source.sourceMin, source.sourceMax] },
        ),
      };
    }
    return { ok: true, serialised: { value: String(value), display: String(value), valueKind: "numeric" } };
  }
  if (CHOICE_FIELD_TYPES.has(field.fieldType)) {
    const labels = matchOptionLabels(field, text);
    if (labels === null) {
      return {
        ok: false,
        issue: issue(
          "value_not_an_option",
          "fail",
          `documented value is not one of the field's options; allowed options: ${JSON.stringify(field.options)}`,
          { observed: text, allowedOptions: field.options, fieldType: field.fieldType },
        ),
      };
    }
    if (field.fieldType === "checkbox") {
      const canonical = labels.map((entry) => entry.canonical);
      return {
        ok: true,
        serialised: {
          value: JSON.stringify(canonical),
          display: canonical.join("; "),
          valueKind: "option",
        },
      };
    }
    const only = labels[0];
    if (only === undefined) {
      return {
        ok: false,
        issue: issue("value_not_an_option", "fail", "documented value did not resolve to an option", {
          observed: text,
          allowedOptions: field.options,
        }),
      };
    }
    if (mapping.valueTransform === "option_index") {
      return {
        ok: true,
        serialised: { value: String(only.index), display: `${only.canonical} (option index ${only.index})`, valueKind: "option" },
      };
    }
    return { ok: true, serialised: { value: only.canonical, display: only.canonical, valueKind: "option" } };
  }
  if (mapping.valueTransform === "numeric_round") {
    if (numeric === null) {
      return {
        ok: false,
        issue: issue(
          "numeric_transform_requires_numeric_source",
          "fail",
          "valueTransform numeric_round was requested but the documented value is not numeric",
          { observed: text },
        ),
      };
    }
    const rounded = Math.round(numeric);
    return { ok: true, serialised: { value: String(rounded), display: String(rounded), valueKind: "numeric" } };
  }
  if (
    numeric !== null &&
    source.sourceMin !== null &&
    source.sourceMax !== null &&
    (numeric < source.sourceMin || numeric > source.sourceMax)
  ) {
    return {
      ok: false,
      issue: issue(
        "value_out_of_source_range",
        "fail",
        `documented value ${numeric} is outside the documented source range ${source.sourceMin}–${source.sourceMax}`,
        { observed: numeric, allowedRange: [source.sourceMin, source.sourceMax] },
      ),
    };
  }
  return { ok: true, serialised: { value: text, display: text, valueKind: "text" } };
}

// ------------------------------------------------------------------ validation --

function provenanceIssue(site: SourceSite): RuleIssue {
  return issue("mapping_provenance", "info", `payload value provenance: ${site.provenance}`, site.detail);
}

function finish(
  base: { mappingId: string; fieldId: string; fieldTitle: string },
  issues: RuleIssue[],
  serialised: SerialisedValue | null,
): FieldMappingValidation {
  if (serialised === null) {
    return { ...base, outcome: outcomeOf(issues), issues, resolvedValue: null, resolvedDisplay: null, valueKind: "none" };
  }
  return {
    ...base,
    outcome: outcomeOf(issues),
    issues,
    resolvedValue: serialised.value,
    resolvedDisplay: serialised.display,
    valueKind: serialised.valueKind,
  };
}

export function validateMapping(
  field: ExternalFormFieldInput,
  mapping: MappingCandidate,
  context: MappingSourceContext,
): FieldMappingValidation {
  const issues: RuleIssue[] = [];
  const base = { mappingId: mapping.mappingId, fieldId: field.fieldId, fieldTitle: field.title };

  const boundFieldId = asText(mapping.sourceRef.fieldId);
  if (boundFieldId !== null && boundFieldId !== field.fieldId) {
    issues.push(
      issue(
        "mapping_field_binding_mismatch",
        "fail",
        `mapping "${mapping.mappingId}" is bound to field "${boundFieldId}" but was validated against field "${field.fieldId}"`,
        { mappingId: mapping.mappingId, boundFieldId, fieldId: field.fieldId },
      ),
    );
    return finish(base, issues, null);
  }

  if (mapping.mappingKind === "unmapped") {
    if (field.fieldType === "section_header") {
      issues.push(
        issue(
          "section_header_not_mapped",
          "info",
          `field "${field.fieldId}" is a section header: it carries no answer, is never mapped and never blocks`,
          { fieldId: field.fieldId },
        ),
      );
    } else if (field.isRequired) {
      issues.push(
        issue(
          "required_field_unmapped",
          "fail",
          `required field "${field.fieldId}" ("${field.title}") has no mapping; the platform never invents a value for a required field`,
          { fieldId: field.fieldId, fieldTitle: field.title },
        ),
      );
    } else {
      issues.push(
        issue(
          "optional_field_unmapped",
          "warn",
          `optional field "${field.fieldId}" ("${field.title}") is unmapped; its key is omitted from the payload`,
          { fieldId: field.fieldId, fieldTitle: field.title },
        ),
      );
    }
    return finish(base, issues, null);
  }

  if (mapping.status === "rejected") {
    issues.push(
      issue(
        "mapping_rejected",
        "fail",
        `mapping "${mapping.mappingId}" was rejected by a researcher; a rejected mapping never produces a value`,
        { mappingId: mapping.mappingId },
      ),
    );
    return finish(base, issues, null);
  }
  if (mapping.status === "stale") {
    issues.push(
      issue(
        "mapping_stale",
        "fail",
        `mapping "${mapping.mappingId}" is marked stale: the external form version changed since it was validated, so it must be re-validated`,
        { mappingId: mapping.mappingId },
      ),
    );
    return finish(base, issues, null);
  }
  if (UNMAPPABLE_FIELD_TYPES.has(field.fieldType)) {
    issues.push(
      issue(
        "field_type_not_mappable",
        "fail",
        `field "${field.fieldId}" cannot be filled by a single documented value: ${UNMAPPABLE_REASONS[field.fieldType] ?? "unsupported field type"}`,
        { fieldId: field.fieldId, fieldType: field.fieldType },
      ),
    );
    return finish(base, issues, null);
  }
  if (mapping.status === "draft") {
    issues.push(
      issue(
        "mapping_not_validated",
        "warn",
        `mapping "${mapping.mappingId}" is still a draft; a researcher must validate it before the value may be submitted`,
        { mappingId: mapping.mappingId },
      ),
    );
  }

  const resolution =
    mapping.mappingKind === "observed_answer"
      ? resolveObservedAnswer(mapping, context)
      : mapping.mappingKind === "derived_score"
        ? resolveDerivedScore(mapping, context)
        : mapping.mappingKind === "participant_attribute"
          ? resolveParticipantAttribute(mapping, context)
          : resolveFixedConstant(mapping);

  if (resolution.state === "invalid") {
    issues.push(resolution.issue);
    return finish(base, issues, null);
  }
  if (resolution.state === "missing") {
    issues.push({
      ...resolution.issue,
      severity: field.isRequired ? "fail" : "warn",
      message: field.isRequired
        ? `${resolution.issue.message}; field "${field.fieldId}" is required so this blocks the preflight`
        : `${resolution.issue.message}; optional field "${field.fieldId}" omits the key`,
    });
    issues.push(provenanceIssue(resolution));
    return finish(base, issues, null);
  }

  const serialised = serialiseValue(field, mapping, resolution);
  if (!serialised.ok) {
    issues.push(serialised.issue);
    return finish(base, issues, null);
  }
  issues.push(provenanceIssue(resolution));
  return finish(base, issues, serialised.serialised);
}

// ------------------------------------------------------------------- preflight --

function compareFieldOrder(left: ExternalFormFieldInput, right: ExternalFormFieldInput): number {
  if (left.orderIndex !== right.orderIndex) return left.orderIndex - right.orderIndex;
  return compareByKey(left.fieldId, right.fieldId);
}

function implicitUnmappedMapping(field: ExternalFormFieldInput): MappingCandidate {
  return {
    mappingId: `implicit:${field.fieldId}`,
    mappingKind: "unmapped",
    valueTransform: "verbatim",
    sourceRef: { fieldId: field.fieldId },
    status: "validated",
    rationale: null,
  };
}

function duplicateMappingValidation(
  field: ExternalFormFieldInput,
  bound: MappingCandidate[],
): FieldMappingValidation {
  const mappingIds = bound.map((entry) => entry.mappingId).sort();
  return {
    mappingId: mappingIds.join(","),
    fieldId: field.fieldId,
    fieldTitle: field.title,
    outcome: "fail",
    issues: [
      issue(
        "duplicate_mapping_for_field",
        "fail",
        `field "${field.fieldId}" has ${bound.length} mappings (${mappingIds.join(", ")}); exactly one mapping per field is allowed`,
        { fieldId: field.fieldId, mappingIds },
      ),
    ],
    resolvedValue: null,
    resolvedDisplay: null,
    valueKind: "none",
  };
}

function orphanMappingValidation(
  mapping: MappingCandidate,
  knownFieldIds: string[],
): FieldMappingValidation {
  const boundFieldId = asText(mapping.sourceRef.fieldId);
  const unbound = boundFieldId === null;
  return {
    mappingId: mapping.mappingId,
    fieldId: unbound ? `unbound:${mapping.mappingId}` : boundFieldId,
    fieldTitle: unbound ? "(mapping without field binding)" : `(unknown field "${boundFieldId}")`,
    outcome: "fail",
    issues: [
      issue(
        unbound ? "mapping_field_binding_missing" : "mapping_targets_unknown_field",
        "fail",
        unbound
          ? `mapping "${mapping.mappingId}" declares no sourceRef.fieldId, so it is not bound to any external form field`
          : `mapping "${mapping.mappingId}" targets field "${boundFieldId}", which is not part of this external form version`,
        { mappingId: mapping.mappingId, boundFieldId, knownFieldIds },
      ),
    ],
    resolvedValue: null,
    resolvedDisplay: null,
    valueKind: "none",
  };
}

export function buildPreflight(input: PreflightInput): PreflightReport {
  const generatedAt = input.generatedAt;
  if (generatedAt === undefined || generatedAt.trim() === "") {
    throw new DomainError(
      "generated_at_required",
      "buildPreflight requires an injected generatedAt: the preflight is pure and never reads the clock",
      { studyId: input.studyId, participantId: input.participantId },
    );
  }

  const fields = [...input.fields].sort(compareFieldOrder);
  const knownFieldIds = fields.map((field) => field.fieldId);
  const mappingsByField = new Map<string, MappingCandidate[]>();
  const orphans: MappingCandidate[] = [];
  for (const mapping of input.mappings) {
    const boundFieldId = asText(mapping.sourceRef.fieldId);
    if (boundFieldId === null || !knownFieldIds.includes(boundFieldId)) {
      orphans.push(mapping);
      continue;
    }
    const bucket = mappingsByField.get(boundFieldId);
    if (bucket === undefined) mappingsByField.set(boundFieldId, [mapping]);
    else bucket.push(mapping);
  }

  const validations: FieldMappingValidation[] = [];
  const unmappedRequiredFieldIds: string[] = [];
  for (const field of fields) {
    const bound = mappingsByField.get(field.fieldId) ?? [];
    const [first, ...rest] = bound;
    if (first === undefined) {
      validations.push(validateMapping(field, implicitUnmappedMapping(field), input.context));
      if (field.isRequired && field.fieldType !== "section_header") unmappedRequiredFieldIds.push(field.fieldId);
      continue;
    }
    if (rest.length > 0) {
      validations.push(duplicateMappingValidation(field, bound));
      continue;
    }
    validations.push(validateMapping(field, first, input.context));
    if (first.mappingKind === "unmapped" && field.isRequired && field.fieldType !== "section_header") {
      unmappedRequiredFieldIds.push(field.fieldId);
    }
  }
  for (const mapping of [...orphans].sort((left, right) => compareByKey(left.mappingId, right.mappingId))) {
    validations.push(orphanMappingValidation(mapping, knownFieldIds));
  }

  const consentStatus = input.consent.status.trim().toLowerCase();
  const withdrawn = consentStatus === "withdrawn" || input.consent.withdrawnAt !== null;
  const participantConsentOnFile = consentStatus === "granted" && !withdrawn;

  const blockingReasons: string[] = [];
  if (withdrawn) {
    blockingReasons.push(
      `participant consent is withdrawn${input.consent.withdrawnAt === null ? "" : ` on ${input.consent.withdrawnAt}`}: no external payload may be assembled or submitted`,
    );
  } else if (!participantConsentOnFile) {
    blockingReasons.push(
      `participant consent status is "${input.consent.status}": documented consent must be on file before any external payload is assembled or submitted`,
    );
  }
  for (const validation of validations) {
    if (validation.outcome !== "fail") continue;
    const firstFail = validation.issues.find((entry) => entry.severity === "fail");
    blockingReasons.push(
      `field "${validation.fieldId}" (${validation.fieldTitle}): ${firstFail === undefined ? "validation failed" : firstFail.message}`,
    );
  }

  const submissionBlockers: string[] = [];
  if (!PLATFORM_SUBMISSION_PATH_VERIFIED) {
    submissionBlockers.push("the platform has no verified Google Forms response-submission API path");
  }
  if (!input.platformSubmissionAuthorized) {
    submissionBlockers.push(`external submission is not authorized for study "${input.studyId}"`);
  }
  if (!participantConsentOnFile) {
    submissionBlockers.push(`participant consent is not on file (status "${input.consent.status}")`);
  }
  const failedFieldCount = validations.filter((validation) => validation.outcome === "fail").length;
  if (failedFieldCount > 0) submissionBlockers.push(`${failedFieldCount} field validation(s) failed`);
  const submissionAllowedByPlatform = submissionBlockers.length === 0;
  const submissionBlockedReason =
    submissionBlockers.length === 0 ? null : `external submission blocked: ${submissionBlockers.join("; ")}`;
  if (submissionBlockedReason !== null) blockingReasons.push(submissionBlockedReason);

  const payload: Record<string, string> = {};
  if (participantConsentOnFile) {
    for (const validation of validations) {
      if (validation.outcome === "fail") continue;
      if (validation.resolvedValue === null || validation.valueKind === "none") continue;
      payload[validation.fieldId] = validation.resolvedValue;
    }
  }

  const counts = {
    pass: validations.filter((validation) => validation.outcome === "pass").length,
    warn: validations.filter((validation) => validation.outcome === "warn").length,
    fail: failedFieldCount,
    unmappedRequired: unmappedRequiredFieldIds.length,
    missingSource: validations.filter((validation) =>
      validation.issues.some((entry) => MISSING_SOURCE_ISSUE_CODES.has(entry.code)),
    ).length,
  };

  const contentFailure = failedFieldCount > 0;
  const contentWarning = validations.some((validation) => validation.outcome === "warn");
  let outcome: PreflightReport["outcome"];
  if (contentFailure || !participantConsentOnFile) outcome = "fail";
  else if (contentWarning || !submissionAllowedByPlatform) outcome = "warn";
  else outcome = "pass";

  const fixedConstantKeys = validations
    .filter((validation) => validation.issues.some((entry) => entry.code === "mapping_provenance" && entry.detail?.mappingKind === "fixed_constant"))
    .map((validation) => validation.fieldId);

  const auditNotes: string[] = [
    SUBMISSION_PATH_NOTES,
    `mapping preflight for study "${input.studyId}", participant "${input.participantId}", external form version "${input.externalFormVersionId}"; generatedAt "${generatedAt}" was injected by the caller.`,
  ];
  if (input.platformSubmissionAuthorized) {
    auditNotes.push(
      "platformSubmissionAuthorized=true was asserted, but no verified provider submission path exists, so the assertion is recorded and cannot authorize submission.",
    );
  }
  auditNotes.push(
    `consent: status "${input.consent.status}"${input.consent.version === null ? " without a version reference" : `, version "${input.consent.version}"`}; participantConsentOnFile=${participantConsentOnFile}.`,
  );
  if (!participantConsentOnFile) {
    auditNotes.push(
      "consent is not on file: the dry-run payload was left empty, and the field findings below are reported for review only.",
    );
  } else {
    const carried = Object.keys(payload).length;
    auditNotes.push(
      `dry-run payload: ${carried} of ${fields.length} field(s) carry a documented value; ${fields.length - carried} omitted (unmapped, missing source or failing).`,
    );
  }
  if (fixedConstantKeys.length > 0) {
    auditNotes.push(
      `researcher-declared fixed constants are used for: ${fixedConstantKeys.join(", ")}; constants are declarations, not participant answers.`,
    );
  }
  if (counts.missingSource > 0) {
    auditNotes.push(
      `${counts.missingSource} field(s) reference a source documented as missing; no value, dash, empty string or placeholder was inserted for them.`,
    );
  }
  if (orphans.length > 0) {
    auditNotes.push(
      `${orphans.length} mapping(s) target no field of this form version and are reported as failures so nothing is silently dropped.`,
    );
  }
  if (validations.some((validation) => validation.issues.some((entry) => entry.code === "identity_attribute_not_permitted"))) {
    auditNotes.push("identity attributes were refused: identity data must not be written into an external form.");
  }
  auditNotes.push(OUTCOME_NOTE);

  return {
    studyId: input.studyId,
    participantId: input.participantId,
    externalFormVersionId: input.externalFormVersionId,
    generatedAt,
    outcome,
    fields: validations,
    payload,
    counts,
    blockingReasons,
    dryRun: true,
    authorization: {
      consentStatus: input.consent.status,
      consentVersion: input.consent.version,
      participantConsentOnFile,
      submissionAllowedByPlatform,
      submissionBlockedReason,
    },
    auditNotes,
  };
}

// --------------------------------------------------------------- version drift --

function indexFields(fields: ExternalFormFieldInput[]): Map<string, ExternalFormFieldInput> {
  const indexed = new Map<string, ExternalFormFieldInput>();
  for (const field of fields) {
    if (!indexed.has(field.fieldId)) indexed.set(field.fieldId, field);
  }
  return indexed;
}

function rankFields(fields: ExternalFormFieldInput[]): Map<string, number> {
  const ordered = [...fields].sort(compareFieldOrder);
  const ranks = new Map<string, number>();
  ordered.forEach((field, index) => {
    if (!ranks.has(field.fieldId)) ranks.set(field.fieldId, index);
  });
  return ranks;
}

export function detectVersionDrift(
  previous: ExternalFormFieldInput[],
  current: ExternalFormFieldInput[],
): VersionDriftReport {
  const previousIndex = indexFields(previous);
  const currentIndex = indexFields(current);
  const previousRanks = rankFields(previous);
  const currentRanks = rankFields(current);

  const added = [...currentIndex.keys()].filter((fieldId) => !previousIndex.has(fieldId)).sort();
  const removed = [...previousIndex.keys()].filter((fieldId) => !currentIndex.has(fieldId)).sort();
  const common = [...currentIndex.keys()]
    .filter((fieldId) => previousIndex.has(fieldId))
    .sort((left, right) => (currentRanks.get(left) ?? 0) - (currentRanks.get(right) ?? 0));

  const report: VersionDriftReport = {
    added,
    removed,
    retitled: [],
    retyped: [],
    optionsAdded: [],
    optionsRemoved: [],
    reordered: [],
  };

  for (const fieldId of common) {
    const before = previousIndex.get(fieldId);
    const after = currentIndex.get(fieldId);
    if (before === undefined || after === undefined) continue;
    if (before.title !== after.title) {
      report.retitled.push({ fieldId, previousTitle: before.title, currentTitle: after.title });
    }
    if (before.fieldType !== after.fieldType) {
      report.retyped.push({ fieldId, previousType: before.fieldType, currentType: after.fieldType });
    }
    const optionsAdded = after.options.filter((option) => !before.options.includes(option));
    const optionsRemoved = before.options.filter((option) => !after.options.includes(option));
    if (optionsAdded.length > 0) report.optionsAdded.push({ fieldId, options: optionsAdded });
    if (optionsRemoved.length > 0) report.optionsRemoved.push({ fieldId, options: optionsRemoved });
    const beforeRank = previousRanks.get(fieldId);
    const afterRank = currentRanks.get(fieldId);
    if (beforeRank !== undefined && afterRank !== undefined && beforeRank !== afterRank) {
      report.reordered.push({ fieldId, previousIndex: beforeRank, currentIndex: afterRank });
    }
  }

  return report;
}

// ------------------------------------------------------------------ suggestions --

interface SuggestionCandidate {
  kind: MappingCandidate["mappingKind"];
  rank: number;
  match: string;
  reason: string;
  sourceRef: Record<string, unknown>;
  sortKey: string;
}

const KIND_PRIORITY: Record<string, number> = {
  observed_answer: 0,
  derived_score: 1,
  participant_attribute: 2,
  fixed_constant: 3,
  unmapped: 4,
};

const CONFIDENCE_BY_RANK = ["low", "low", "medium", "high"] as const;

function setEquals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const target = new Set(right);
  return left.every((entry) => target.has(entry));
}

function trimRange(min: number | null, max: number | null): string {
  return `${min ?? "?"}–${max ?? "?"}`;
}

/**
 * Deterministic mapping suggestions: exact normalised title matches against
 * documented question texts, scale titles and attribute keys (`high`),
 * option-label equality with a documented answer (`medium`), and linear-scale
 * numeric range compatibility (`low`). One best suggestion per field, ordered by
 * the field's order. `fixed_constant` is never suggested: a constant is a
 * researcher declaration, not something the platform may infer.
 */
export function suggestMappings(
  fields: ExternalFormFieldInput[],
  context: MappingSourceContext,
): MappingSuggestion[] {
  const suggestions: MappingSuggestion[] = [];

  for (const field of [...fields].sort(compareFieldOrder)) {
    if (UNMAPPABLE_FIELD_TYPES.has(field.fieldType)) continue;
    const normalised = normaliseTitle(field.title);
    const candidates: SuggestionCandidate[] = [];

    if (normalised !== "") {
      for (const answer of context.answers) {
        if (normaliseTitle(answer.questionText) !== normalised) continue;
        candidates.push({
          kind: "observed_answer",
          rank: 3,
          match: "normalised_title",
          reason: `field title normalises to "${normalised}", the documented question text of item "${answer.itemCode}" from source "${answer.documentedSourceId}"`,
          sourceRef: {
            fieldId: field.fieldId,
            itemCode: answer.itemCode,
            itemDefinitionId: answer.itemDefinitionId,
            sessionId: answer.sessionId,
            documentedSourceId: answer.documentedSourceId,
            sourceLocator: answer.sourceLocator,
            match: "normalised_title",
          },
          sortKey: mergeSortKey(answer.itemCode, answer.documentedSourceId),
        });
      }
      for (const score of context.scores) {
        if (normaliseTitle(score.scaleTitle) !== normalised) continue;
        candidates.push({
          kind: "derived_score",
          rank: 3,
          match: "normalised_title",
          reason: `field title normalises to "${normalised}", the title of documented scale "${score.scaleCode}" (raw score, algorithm ${score.algorithmVersion})`,
          sourceRef: {
            fieldId: field.fieldId,
            scaleCode: score.scaleCode,
            sessionId: score.sessionId,
            scoreField: "raw",
            match: "normalised_title",
          },
          sortKey: mergeSortKey(score.scaleCode, score.sessionId),
        });
      }
      for (const attribute of Object.keys(context.attributes).sort()) {
        if (normaliseTitle(attribute) !== normalised) continue;
        candidates.push({
          kind: "participant_attribute",
          rank: 3,
          match: "normalised_title",
          reason: `field title normalises to "${normalised}", the documented participant attribute key "${attribute}"`,
          sourceRef: { fieldId: field.fieldId, attribute, match: "normalised_title" },
          sortKey: attribute,
        });
      }
    }

    if (CHOICE_FIELD_TYPES.has(field.fieldType) && field.options.length > 0) {
      for (const answer of context.answers) {
        if (answer.options.length === 0 || !setEquals(answer.options, field.options)) continue;
        candidates.push({
          kind: "observed_answer",
          rank: 2,
          match: "option_labels",
          reason: `field options ${JSON.stringify(field.options)} equal the documented option set of item "${answer.itemCode}"`,
          sourceRef: {
            fieldId: field.fieldId,
            itemCode: answer.itemCode,
            itemDefinitionId: answer.itemDefinitionId,
            sessionId: answer.sessionId,
            documentedSourceId: answer.documentedSourceId,
            sourceLocator: answer.sourceLocator,
            match: "option_labels",
          },
          sortKey: mergeSortKey(answer.itemCode, answer.documentedSourceId),
        });
      }
    }

    const scaleRange = fieldScaleRange(field);
    if (scaleRange !== null) {
      for (const answer of context.answers) {
        if (answer.minValue === null || answer.maxValue === null) continue;
        if (answer.minValue !== scaleRange.min || answer.maxValue !== scaleRange.max) continue;
        candidates.push({
          kind: "observed_answer",
          rank: 1,
          match: "numeric_range",
          reason: `field linear scale range ${trimRange(scaleRange.min, scaleRange.max)} matches the declared bounds of item "${answer.itemCode}"; range equality alone does not identify the item`,
          sourceRef: {
            fieldId: field.fieldId,
            itemCode: answer.itemCode,
            itemDefinitionId: answer.itemDefinitionId,
            sessionId: answer.sessionId,
            documentedSourceId: answer.documentedSourceId,
            sourceLocator: answer.sourceLocator,
            match: "numeric_range",
          },
          sortKey: mergeSortKey(answer.itemCode, answer.documentedSourceId),
        });
      }
    }

    if (candidates.length === 0) continue;
    const ordered = [...candidates].sort((left, right) => {
      if (left.rank !== right.rank) return right.rank - left.rank;
      const leftKind = KIND_PRIORITY[left.kind] ?? 9;
      const rightKind = KIND_PRIORITY[right.kind] ?? 9;
      if (leftKind !== rightKind) return leftKind - rightKind;
      return compareByKey(left.sortKey, right.sortKey);
    });
    const best = ordered[0];
    if (best === undefined) continue;
    const tied = ordered.filter((candidate) => candidate.rank === best.rank).length;
    const confidence =
      tied > 1 && best.rank >= 3
        ? CONFIDENCE_BY_RANK[2]
        : CONFIDENCE_BY_RANK[best.rank] ?? "low";
    const ambiguity =
      tied > 1 ? `; ${tied} sources match equally (match: ${best.match}) so the researcher must choose` : "";
    suggestions.push({
      fieldId: field.fieldId,
      suggestionKind: best.kind,
      confidence,
      reason: `${best.reason}${ambiguity}; ${SUGGESTION_ACCEPTANCE_NOTE}`,
      sourceRef: best.sourceRef,
    });
  }

  return suggestions;
}
