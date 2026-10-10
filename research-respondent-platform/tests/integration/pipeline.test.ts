/**
 * End-to-end integration test: the complete permitted research workflow on an
 * in-memory database.
 *
 * FIXTURE NOTICE
 * --------------
 * The instrument used below ("Synthetic Pipeline Fixture", slug
 * `synthetic-pipeline-fixture`) is invented for this test. It is NOT a real
 * psychometric instrument: the item wording, scale and scoring algorithm are
 * placeholders, the algorithm is documented as unvalidated, and
 * `clinicalUsePermitted` is false. It must never be imported into a research
 * database or presented to a participant.
 *
 * DATABASE: every test opens `openDatabase({ file: ":memory:" })`. The real
 * database at data/respondent-platform.db is never opened, read or written.
 * No network access, no wall-clock assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Db } from "../../db/index.ts";
import { bootstrap } from "../../lib/services/bootstrap.ts";
import {
  agentActor,
  buildActor,
  createUser,
  getFirstOrganization,
  getUserByEmail,
  type UserRow,
} from "../../lib/repo/org.ts";
import {
  createCriterion,
  createProtocolVersion,
  createStudy,
  enrolParticipant,
  listCriteria,
  parseCriterionRule,
} from "../../lib/repo/studies.ts";
import {
  createParticipant,
  getParticipant,
  getPrivateIdentity,
  recordConsent,
  upsertPrivateIdentity,
} from "../../lib/repo/participants.ts";
import { registerDocumentedSource } from "../../lib/repo/sources.ts";
import {
  addItems,
  createAssessmentSession,
  createInstrument,
  createInstrumentVersion,
  createScale,
  createScoreAlgorithm,
  listAnswers,
  listAnswersWithItems,
  listDerivedScores,
  persistAnswers,
  scoreAndPersistSession,
  type ItemRow,
  type SessionRow,
} from "../../lib/repo/assessments.ts";
import { getStudyCohortPreview } from "../../lib/services/cohorts.ts";
import { parseRule } from "../../lib/domain/cohort.ts";
import {
  captureFormVersion,
  createExternalForm,
  listFieldMappings,
  listFormFields,
  toFieldInput,
  toMappingCandidate,
  upsertFieldMapping,
} from "../../lib/repo/forms.ts";
import { buildPreflight, MISSING_SOURCE_MESSAGE } from "../../lib/domain/mapping.ts";
import { listAuditEvents } from "../../lib/services/audit.ts";
import { getAgentTask, listAttempts, listEvidence } from "../../lib/repo/tasks.ts";
import {
  approveTask,
  createTaskFromPreflight,
  queueTask,
  retryTask,
  runTask,
  validateTask,
} from "../../lib/services/orchestration.ts";
import { assertAuthorized, authorize, PERMISSIONS } from "../../lib/services/authz.ts";
import { DomainError, type Actor, type AgentTaskContract, type CohortRule, type MappingSourceContext, type PreflightReport } from "../../lib/domain/types.ts";

// ------------------------------------------------------------------ helpers --

const ADMIN_EMAIL = "fixture.admin@example.test";
const IDENTITY_EMAIL = "fixture.respondent@example.test";
const GENERATED_AT = "2026-03-01T09:00:00.000Z";
const ALGORITHM_VERSION = "fixture-1.0.0";

function isDomainError(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { total: number };
  return row.total;
}

/** True when any column of any row in `table` contains `needle`. */
function tableContains(db: Db, table: string, needle: string): boolean {
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  return rows.some((row) => JSON.stringify(row).includes(needle));
}

function snapshotSession(db: Db, sessionId: string): SessionRow {
  const row = db.prepare("SELECT * FROM assessment_session WHERE id = ?").get(sessionId) as SessionRow | undefined;
  assert.ok(row, `session ${sessionId} must exist`);
  return row;
}

/** Fixture cohort rules. Storage happens in `world()`; evaluation in the cohort test. */
const CONSENT_RULE_ID = "crit_fixture_consent";
const AGE_RULE_ID = "crit_fixture_age";

function fixtureConsentRule(studyId: string): CohortRule {
  return {
    id: CONSENT_RULE_ID,
    subject: "consent",
    operator: "consent_status",
    field: studyId,
    value: "granted",
    label: "Study consent granted",
  };
}

const FIXTURE_AGE_RULE: CohortRule = {
  id: AGE_RULE_ID,
  subject: "participant_attribute",
  operator: "gte",
  field: "age_at_enrolment",
  value: 18,
  label: "Age at enrolment 18+",
};

interface World {
  db: Db;
  orgId: string;
  admin: Actor;
  pi: Actor;
  researcher: Actor;
  viewer: Actor;
  agent: Actor;
  studyId: string;
  protocolId: string;
  sourceId: string;
  participantId: string;
  pseudonym: string;
  consentId: string;
  instrumentVersionId: string;
  items: ItemRow[];
  itemByCode: Map<string, ItemRow>;
  sessionT1: SessionRow;
  sessionT2: SessionRow;
  formVersionId: string;
  requiredFieldId: string;
  optionalFieldId: string;
  preflightFailing: PreflightReport;
  preflightClean: PreflightReport;
  permittedAnswers: AgentTaskContract["permittedAnswers"];
}

function userWithRole(db: Db, orgId: string, email: string, role: string, studyId: string): Actor {
  const user = createUser(db, {
    organizationId: orgId,
    email,
    displayName: email.split("@")[0] ?? role,
    password: "fixture-password-123",
    // Non-admin role assignments must be study-scoped (role_assignment CHECK).
    roles: [{ role, studyId }],
    createdBy: null,
  });
  return buildActor(db, user);
}

/**
 * Builds the whole permitted workflow once: organization, study, provenance,
 * participant, synthetic instrument, two assessed sessions, an external form
 * with one required and one optional field, and two preflights.
 */
function world(): World {
  const db = openDatabase({ file: ":memory:" });

  bootstrap(db, {
    organizationName: "Fixture Research Organization",
    slug: "fixture-research-org",
    adminEmail: ADMIN_EMAIL,
    adminPassword: "fixture-password-123",
    adminDisplayName: "Fixture Administrator",
  });
  const organization = getFirstOrganization(db);
  assert.ok(organization, "bootstrap must create an organization");
  const adminUser = getUserByEmail(db, ADMIN_EMAIL) as UserRow | undefined;
  assert.ok(adminUser, "bootstrap must create the admin user");
  const admin = buildActor(db, adminUser);

  const study = createStudy(db, {
    organizationId: organization.id,
    code: "FIX-PIPE",
    title: "Fixture pipeline study (test-only)",
    researchQuestion: "Does the permitted workflow preserve provenance end to end?",
    principalEmail: "fixture.pi@example.test",
    createdBy: admin.id,
    status: "active",
  });
  const pi = userWithRole(db, organization.id, "fixture.pi@example.test", "principal_investigator", study.id);
  const researcher = userWithRole(db, organization.id, "fixture.researcher@example.test", "researcher", study.id);
  const viewer = userWithRole(db, organization.id, "fixture.viewer@example.test", "viewer", study.id);
  const agent = agentActor({
    organizationId: organization.id,
    agentId: "agt_fixture",
    agentName: "Fixture Agent",
    capabilities: ["preflight_mapping"],
  });

  const protocol = createProtocolVersion(db, {
    studyId: study.id,
    versionLabel: "fixture-protocol-1",
    designSummary: "Synthetic fixture; no human participants were involved.",
    inclusionCriteria: "Study-scoped consent granted; age at enrolment 18+.",
    ethicalApproval: "Not applicable: synthetic test fixture.",
    approvedBy: admin.id,
  });
  createCriterion(db, {
    studyId: study.id,
    protocolVersionId: protocol.id,
    kind: "inclusion",
    label: "Study consent granted",
    rule: fixtureConsentRule(study.id),
    rationale: "Fixture criterion: unknown consent must stay indeterminate.",
  });
  createCriterion(db, {
    studyId: study.id,
    protocolVersionId: protocol.id,
    kind: "inclusion",
    label: "Age at enrolment 18+",
    rule: FIXTURE_AGE_RULE,
    rationale: "Fixture criterion over a documented participant attribute.",
  });

  const source = registerDocumentedSource(db, {
    organizationId: organization.id,
    studyId: study.id,
    originType: "spreadsheet",
    title: "Synthetic fixture source (test-only)",
    reference: "fixture-source.csv",
    collectedAt: "2026-02-01T10:00:00.000Z",
    integrityNotes: "Invented fixture rows; contains no real participant data.",
    recordedBy: admin.id,
  });

  const created = createParticipant(db, {
    organizationId: organization.id,
    pseudonym: "FIX-001",
    attributes: { birth_year: 1991, age_at_enrolment: 34 },
    notes: "Synthetic fixture participant.",
    createdBy: admin.id,
    evidenceDocumentedSourceId: source.id,
    evidenceLocator: "sheet1!A2",
    consent: {
      // Participant-level consent only: consent for THIS study stays unknown
      // until recordConsent() is called, which is what the cohort test needs.
      studyId: null,
      version: "fixture-consent-v1",
      basis: "written_signed",
      status: "granted",
      grantedAt: "2026-01-15T08:00:00.000Z",
      scope: ["assessment", "analysis"],
      notes: "Synthetic fixture consent.",
    },
    identity: {
      fullName: "Fixture Respondent",
      contactEmail: IDENTITY_EMAIL,
      lawfulBasis: "Signed informed consent 2026-01-15 (fixture)",
    },
  });

  const instrument = createInstrument(db, {
    organizationId: organization.id,
    slug: "synthetic-pipeline-fixture",
    title: "Synthetic Pipeline Fixture (test-only, not a real instrument)",
    abbreviation: "FIXPIPE",
    authors: "Test fixture",
    tradition: "other",
    rightsStatus: "public_domain",
    rightsNote: "Invented for tests; no rights holder and no validated properties.",
    isClinical: false,
    requiresSupervision: false,
  });
  const version = createInstrumentVersion(db, {
    instrumentId: instrument.id,
    versionLabel: "fixture-1",
    language: "en",
    scoringNotes: "Fixture algorithm; not validated.",
    isProvisional: false,
    clinicalUsePermitted: false,
    limitations: "Synthetic fixture items with no psychometric evidence.",
    sourceDocumentId: source.id,
    createdBy: admin.id,
  });
  const items = addItems(db, version.id, [
    { itemCode: "01", orderIndex: 1, textVerbatim: "Fixture item 01 (synthetic)", textLanguage: "en", responseType: "likert", minValue: 1, maxValue: 7, required: true },
    { itemCode: "02", orderIndex: 2, textVerbatim: "Fixture item 02 (synthetic)", textLanguage: "en", responseType: "likert", minValue: 1, maxValue: 7, required: true },
    { itemCode: "03", orderIndex: 3, textVerbatim: "Fixture reverse item 03 (synthetic)", textLanguage: "en", responseType: "likert", minValue: 1, maxValue: 7, required: true, reverseScored: true },
    { itemCode: "04", orderIndex: 4, textVerbatim: "Fixture item 04 (synthetic)", textLanguage: "en", responseType: "likert", minValue: 1, maxValue: 7, required: true },
    { itemCode: "Q9", orderIndex: 5, textVerbatim: "Fixture open comment (synthetic)", textLanguage: "en", responseType: "open_text", required: false },
  ]);
  const itemByCode = new Map(items.map((item) => [item.item_code, item]));
  const scaleRow = createScale(db, {
    instrumentVersionId: version.id,
    scaleCode: "FIX_TOTAL",
    title: "Fixture total (synthetic)",
    kind: "raw_sum",
    direction: "higher_is_more",
    minPossible: 4,
    maxPossible: 28,
    normNotes: "No norms exist for this fixture.",
  });
  createScoreAlgorithm(db, {
    instrumentVersionId: version.id,
    scaleDefinitionId: scaleRow.id,
    algorithm: {
      algorithmVersion: ALGORITHM_VERSION,
      steps: [{ kind: "recoded_sum", itemCodes: ["01", "02", "03", "04"], reverseItemCodes: ["03"] }],
      missingPolicy: "prorate_if_min_met",
      minItemsRequired: 2,
      documentation: "Synthetic fixture algorithm; not a validated scoring rule.",
    },
    createdBy: admin.id,
  });

  const requiredItemId = (code: string): string => {
    const item = itemByCode.get(code);
    assert.ok(item, `fixture item ${code} must exist`);
    return item.id;
  };

  const sessionT1 = createAssessmentSession(db, {
    studyId: study.id,
    participantId: created.participant.id,
    instrumentVersionId: version.id,
    timepointLabel: "T1",
    administrationMode: "self_paper",
    language: "en",
    completedAt: "2026-02-01T10:30:00.000Z",
    documentedSourceId: source.id,
    protocolVersionId: protocol.id,
    recordedBy: admin.id,
  });
  persistAnswers(
    db,
    sessionT1,
    [
      { itemDefinitionId: requiredItemId("01"), itemCode: "01", rawValueText: "5", valueNumeric: 5, valueCoded: null, isMissing: false, missingReason: null, sourceLocator: "sheet1!B2" },
      { itemDefinitionId: requiredItemId("02"), itemCode: "02", rawValueText: "6", valueNumeric: 6, valueCoded: null, isMissing: false, missingReason: null, sourceLocator: "sheet1!C2" },
      { itemDefinitionId: requiredItemId("03"), itemCode: "03", rawValueText: "2", valueNumeric: 2, valueCoded: null, isMissing: false, missingReason: null, sourceLocator: "sheet1!D2" },
      { itemDefinitionId: requiredItemId("04"), itemCode: "04", rawValueText: "", valueNumeric: null, valueCoded: null, isMissing: true, missingReason: "not_answered", sourceLocator: "sheet1!E2" },
      // The schema requires every collected answer to carry value_numeric or value_coded,
      // so the free-text answer is stored coded/verbatim; the scorer still excludes it
      // because its responseType is open_text.
      { itemDefinitionId: requiredItemId("Q9"), itemCode: "Q9", rawValueText: "Synthetic free text.", valueNumeric: null, valueCoded: "Synthetic free text.", isMissing: false, missingReason: null, sourceLocator: "sheet1!F2" },
    ],
    admin.id,
  );

  const sessionT2 = createAssessmentSession(db, {
    studyId: study.id,
    participantId: created.participant.id,
    instrumentVersionId: version.id,
    timepointLabel: "T2",
    administrationMode: "imported_dataset",
    language: "en",
    documentedSourceId: source.id,
    protocolVersionId: protocol.id,
    recordedBy: admin.id,
  });
  persistAnswers(
    db,
    sessionT2,
    [
      { itemDefinitionId: requiredItemId("01"), itemCode: "01", rawValueText: "5", valueNumeric: 5, valueCoded: null, isMissing: false, missingReason: null, sourceLocator: "sheet1!B3" },
      // Out of the documented 1..7 range: kept verbatim, treated as missing by the scorer.
      { itemDefinitionId: requiredItemId("02"), itemCode: "02", rawValueText: "42", valueNumeric: 42, valueCoded: null, isMissing: false, missingReason: null, sourceLocator: "sheet1!C3" },
      { itemDefinitionId: requiredItemId("03"), itemCode: "03", rawValueText: "2", valueNumeric: 2, valueCoded: null, isMissing: false, missingReason: null, sourceLocator: "sheet1!D3" },
      { itemDefinitionId: requiredItemId("04"), itemCode: "04", rawValueText: "4", valueNumeric: 4, valueCoded: null, isMissing: false, missingReason: null, sourceLocator: "sheet1!E3" },
    ],
    admin.id,
  );

  const externalForm = createExternalForm(db, {
    organizationId: organization.id,
    provider: "google_forms",
    externalId: "fixture-external-form-1",
    title: "Synthetic external form (test-only)",
    apiCanReadStructure: false,
    apiCanReadResponses: false,
    apiCanSubmitResponses: false,
    capabilityEvidence: "Fixture: no API access was ever granted.",
  });
  const captured = captureFormVersion(db, {
    externalFormId: externalForm.id,
    versionLabel: "fixture-form-v1",
    fields: [
      { fieldId: "f_required", orderIndex: 0, title: "Fixture required question", fieldType: "short_text", isRequired: true, options: [], section: null },
      { fieldId: "f_optional", orderIndex: 1, title: "Fixture optional question", fieldType: "short_text", isRequired: false, options: [], section: null },
    ],
    capturedBy: admin.id,
    capturedAt: "2026-02-20T12:00:00.000Z",
  });
  const fieldRows = listFormFields(db, captured.version.id);
  const requiredField = fieldRows.find((row) => row.field_id === "f_required");
  const optionalField = fieldRows.find((row) => row.field_id === "f_optional");
  assert.ok(requiredField && optionalField, "both fixture fields must be captured");

  upsertFieldMapping(db, {
    studyId: study.id,
    externalFormVersionId: captured.version.id,
    externalFormFieldId: requiredField.id,
    mappingKind: "observed_answer",
    sourceRef: { fieldId: "f_required", itemCode: "04" },
    valueTransform: "verbatim",
    status: "validated",
    rationale: "Fixture mapping to an item the participant documented as missing.",
    createdBy: admin.id,
  });
  upsertFieldMapping(db, {
    studyId: study.id,
    externalFormVersionId: captured.version.id,
    externalFormFieldId: optionalField.id,
    mappingKind: "observed_answer",
    sourceRef: { fieldId: "f_optional", itemCode: "01" },
    valueTransform: "verbatim",
    status: "validated",
    rationale: "Fixture mapping to a documented answer.",
    createdBy: admin.id,
  });

  const context = mappingContext(db, sessionT1, created.participant.id, itemByCode);
  const fields = listFormFields(db, captured.version.id).map(toFieldInput);
  const mappings = listFieldMappings(db, study.id, captured.version.id).map(toMappingCandidate);
  const consent = { status: "granted", version: "fixture-consent-v1", withdrawnAt: null };

  const preflightFailing = buildPreflight({
    studyId: study.id,
    participantId: created.participant.id,
    externalFormVersionId: captured.version.id,
    fields,
    mappings,
    context,
    consent,
    platformSubmissionAuthorized: false,
    generatedAt: GENERATED_AT,
  });
  const preflightClean = buildPreflight({
    studyId: study.id,
    participantId: created.participant.id,
    externalFormVersionId: captured.version.id,
    fields: [toFieldInput(optionalField)],
    mappings: mappings.filter((mapping) => (mapping.sourceRef as { fieldId?: string }).fieldId === "f_optional"),
    context,
    consent,
    platformSubmissionAuthorized: false,
    generatedAt: GENERATED_AT,
  });

  const permittedAnswers: AgentTaskContract["permittedAnswers"] = [
    {
      itemCode: "01",
      questionText: "Fixture item 01 (synthetic)",
      value: "5",
      collectedAt: "2026-02-01T10:30:00.000Z",
      documentedSourceId: source.id,
      sourceLocator: "sheet1!B2",
    },
  ];

  return {
    db,
    orgId: organization.id,
    admin,
    pi,
    researcher,
    viewer,
    agent,
    studyId: study.id,
    protocolId: protocol.id,
    sourceId: source.id,
    participantId: created.participant.id,
    pseudonym: created.participant.pseudonym,
    consentId: created.consentId,
    instrumentVersionId: version.id,
    items,
    itemByCode,
    sessionT1,
    sessionT2,
    formVersionId: captured.version.id,
    requiredFieldId: "f_required",
    optionalFieldId: "f_optional",
    preflightFailing,
    preflightClean,
    permittedAnswers,
  };
}

/** Builds the mapping source context from rows that are actually in the database. */
function mappingContext(db: Db, session: SessionRow, participantId: string, itemByCode: Map<string, ItemRow>): MappingSourceContext {
  const participant = getParticipant(db, participantId);
  assert.ok(participant, "participant must exist");
  const scores = listDerivedScores(db, { sessionId: session.id, includeSuperseded: false });
  return {
    participantId,
    pseudonym: participant.pseudonym,
    answers: listAnswersWithItems(db, session.id).map((answer) => {
      const definition = itemByCode.get(answer.item_code);
      return {
        itemDefinitionId: answer.item_definition_id,
        itemCode: answer.item_code,
        questionText: answer.question_text,
        responseType: answer.response_type,
        options: JSON.parse(answer.options_json) as string[],
        minValue: definition?.min_value ?? null,
        maxValue: definition?.max_value ?? null,
        valueNumeric: answer.value_numeric,
        valueCoded: answer.value_coded,
        rawValueText: answer.raw_value_text,
        isMissing: answer.is_missing === 1,
        missingReason: answer.missing_reason,
        collectedAt: answer.collected_at,
        sessionId: answer.assessment_session_id,
        documentedSourceId: answer.source_documented_source_id,
        sourceLocator: answer.source_locator,
      };
    }),
    scores: scores.map((score) => ({
      scaleCode: score.scale_code,
      scaleTitle: score.scale_title,
      rawScore: score.raw_score,
      transformedScore: score.transformed_score,
      computability: score.computability as MappingSourceContext["scores"][number]["computability"],
      algorithmVersion: score.algorithm_version,
      sessionId: session.id,
    })),
    attributes: {
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

// 1 ---------------------------------------------------------------- bootstrap --

test("bootstrap creates the organization and admin, audits the run, and seeds no research data", () => {
  const db = openDatabase({ file: ":memory:" });
  const result = bootstrap(db, {
    organizationName: "Fixture Research Organization",
    slug: "fixture-research-org",
    adminEmail: ADMIN_EMAIL,
    adminPassword: "fixture-password-123",
    adminDisplayName: "Fixture Administrator",
  });

  assert.equal(result.createdOrganization, true);
  assert.equal(result.createdAdmin, true);
  assert.equal(count(db, "SELECT COUNT(*) AS total FROM organization"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS total FROM app_user"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS total FROM role_assignment WHERE role = 'admin'"), 1);

  const events = listAuditEvents(db, { organizationId: result.organizationId, action: "system.bootstrap" });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.outcome, "success");
  assert.equal(events[0]?.entity_type, "organization");
  assert.equal(events[0]?.entity_id, result.organizationId);

  // Bootstrap must never fabricate research data.
  assert.equal(count(db, "SELECT COUNT(*) AS total FROM participant"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS total FROM observed_answer"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS total FROM derived_score"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS total FROM assessment_session"), 0);
  db.close();
});

// 2 ------------------------------------------------------- study + criterion --

test("a study, protocol version and criterion are created and the stored rule parses", () => {
  const w = world();
  const criteria = listCriteria(w.db, w.studyId);
  assert.equal(criteria.length, 2);

  const consentCriterion = criteria.find((row) => row.kind === "inclusion" && row.label.includes("consent"));
  assert.ok(consentCriterion, "the consent criterion must exist");
  const parsed = parseCriterionRule(consentCriterion);
  assert.equal(parsed.subject, "consent");
  assert.equal(parsed.operator, "consent_status");
  assert.equal(parsed.field, w.studyId);
  assert.equal(parsed.value, "granted");

  // The same JSON must round-trip through the strict runtime parser.
  const reparsed = parseRule(JSON.parse(consentCriterion.rule_json));
  assert.deepEqual(reparsed, parsed);
  // Rule identifiers are stable within the JSON definition; database criterion IDs are separate.
  assert.equal(reparsed.id, CONSENT_RULE_ID);

  const protocols = w.db
    .prepare("SELECT COUNT(*) AS total FROM study_protocol_version WHERE study_id = ?")
    .get(w.studyId) as { total: number };
  assert.equal(protocols.total, 1);
  assert.equal(consentCriterion.protocol_version_id, w.protocolId);
  w.db.close();
});

// 3 ------------------------------------------------------------- provenance --

test("participant creation requires a documented source and records missing attributes", () => {
  const w = world();
  const base = {
    organizationId: w.orgId,
    pseudonym: "FIX-900",
    attributes: { birth_year: 1990 },
    createdBy: w.admin.id,
    evidenceLocator: "sheet1!A9",
    consent: {
      studyId: null,
      version: "fixture-consent-v1",
      basis: "written_signed" as const,
      status: "granted" as const,
    },
  };

  assert.throws(
    () => createParticipant(w.db, { ...base, evidenceDocumentedSourceId: "" }),
    (error: unknown) => isDomainError(error, "participant.missing_provenance"),
    "an empty documented source id must be refused",
  );
  assert.throws(
    () => createParticipant(w.db, { ...base, evidenceDocumentedSourceId: "src_does_not_exist" }),
    (error: unknown) => isDomainError(error, "participant.unknown_source"),
    "an unknown documented source id must be refused",
  );

  const created = createParticipant(w.db, { ...base, evidenceDocumentedSourceId: w.sourceId });
  assert.equal(created.participant.pseudonym, "FIX-900");
  assert.equal(created.identityWritten, false);

  // Provenance, consent and the evidence link are written in one transaction.
  assert.equal(
    count(w.db, "SELECT COUNT(*) AS total FROM participant WHERE id = ?", created.participant.id),
    1,
  );
  assert.equal(
    count(w.db, "SELECT COUNT(*) AS total FROM consent_record WHERE id = ?", created.consentId),
    1,
  );
  assert.equal(
    count(
      w.db,
      "SELECT COUNT(*) AS total FROM evidence_link WHERE entity_type = 'participant' AND entity_id = ? AND documented_source_id = ?",
      created.participant.id,
      w.sourceId,
    ),
    1,
  );

  const missingness = JSON.parse(created.participant.attribute_missingness_json) as Record<string, string>;
  assert.equal(missingness.age_at_enrolment, "not_documented_in_source");
  assert.equal(missingness.self_described_gender, "not_documented_in_source");
  assert.equal("birth_year" in missingness, false, "a documented attribute is never listed as missing");
  assert.equal(created.participant.birth_year, 1990);
  assert.equal(created.participant.age_at_enrolment, null, "an unknown attribute stays NULL");
  w.db.close();
});

// 4 ------------------------------------------------------------------ identity --

test("identity data requires a lawful basis and never leaks into analytic tables", () => {
  const w = world();

  // Repository guard: createParticipant refuses identity data without a basis.
  assert.throws(
    () =>
      createParticipant(w.db, {
        organizationId: w.orgId,
        pseudonym: "FIX-901",
        attributes: {},
        evidenceDocumentedSourceId: w.sourceId,
        evidenceLocator: "sheet1!A10",
        consent: { studyId: null, version: "fixture-consent-v1", basis: "written_signed", status: "granted" },
        identity: { contactEmail: "no.basis@example.test", lawfulBasis: "" },
      }),
    (error: unknown) => isDomainError(error, "participant.missing_lawful_basis"),
    "storing identity data without a lawful basis must throw",
  );

  // Database guard: the restricted identity table itself rejects an empty basis.
  assert.throws(
    () =>
      upsertPrivateIdentity(w.db, {
        participantId: w.participantId,
        fullName: null,
        contactEmail: null,
        contactPhone: null,
        contactHandle: null,
        lawfulBasis: "",
      }),
    (error: unknown) => isDomainError(error, "participant.missing_lawful_basis"),
    "an empty lawful basis must not be storable",
  );

  // A whitespace-only lawful basis is not a documented lawful basis.
  // Both the repository guard and database constraints must keep identity out.
  const gap = createParticipant(w.db, {
    organizationId: w.orgId,
    pseudonym: "FIX-902",
    attributes: {},
    evidenceDocumentedSourceId: w.sourceId,
    evidenceLocator: "sheet1!A11",
    consent: { studyId: null, version: "fixture-consent-v1", basis: "written_signed", status: "granted" },
  });
  assert.throws(
    () => upsertPrivateIdentity(w.db, {
      participantId: gap.participant.id,
      fullName: null,
      contactEmail: "whitespace.basis@example.test",
      contactPhone: null,
      contactHandle: null,
      lawfulBasis: "   ",
    }),
    (error: unknown) => isDomainError(error, "participant.missing_lawful_basis"),
    "a whitespace-only lawful basis must be refused before database persistence",
  );
  assert.equal(getPrivateIdentity(w.db, gap.participant.id), undefined);

  const identity = getPrivateIdentity(w.db, w.participantId);
  assert.ok(identity, "the fixture participant must have a restricted identity record");
  assert.equal(identity.contact_email, IDENTITY_EMAIL);
  assert.match(identity.lawful_basis, /Signed informed consent/);

  // The e-mail must exist only in the restricted identity table.
  assert.equal(tableContains(w.db, "participant", IDENTITY_EMAIL), false);
  assert.equal(tableContains(w.db, "observed_answer", IDENTITY_EMAIL), false);
  assert.equal(tableContains(w.db, "derived_score", IDENTITY_EMAIL), false);
  assert.equal(tableContains(w.db, "consent_record", IDENTITY_EMAIL), false);
  assert.equal(tableContains(w.db, "participant_private_identity", IDENTITY_EMAIL), true);
  w.db.close();
});

// 5 ----------------------------------------------------------------- scoring --

test("assessment scoring records coverage, provenance and supersession without rewriting history", () => {
  const w = world();
  const first = scoreAndPersistSession(w.db, w.sessionT1.id, { computedBy: w.admin.id });
  assert.equal(first.result.scores.length, 1);
  const score = first.result.scores[0];
  assert.ok(score);
  assert.equal(score.computability, "computed");
  assert.equal(score.itemsExpected, 4, "the open_text item is never an expected numeric observation");
  assert.equal(score.itemsUsed, 3);
  assert.equal(score.itemsMissing, 1);
  assert.equal(score.methodologicallyProvisional, true, "a prorated score is provisional");
  assert.equal(score.rawScore, 17 * (4 / 3), "(5 + 6 + reversed 2) scaled by itemsExpected/itemsUsed");

  const storedAnswers = listAnswers(w.db, w.sessionT1.id);
  const missingAnswer = storedAnswers.find((answer) => answer.item_code === "04");
  assert.ok(missingAnswer);
  assert.equal(missingAnswer.is_missing, 1, "a documented missing value stays missing");
  assert.equal(missingAnswer.value_numeric, null, "no value is ever imputed for a missing item");
  assert.equal(missingAnswer.missing_reason, "not_answered");
  assert.equal(missingAnswer.raw_value_text, "");

  const persisted = listDerivedScores(w.db, { sessionId: w.sessionT1.id });
  assert.equal(persisted.length, 1);
  const row = persisted[0];
  assert.ok(row);
  assert.equal(row.algorithm_version, ALGORITHM_VERSION);
  assert.equal(row.items_used, 3);
  assert.equal(row.items_missing, 1);
  assert.equal(row.is_provisional, 1);
  assert.equal(row.computability, "computed");
  assert.equal(row.not_computable_reason, null);
  const sourceIds = JSON.parse(row.source_item_ids_json) as string[];
  assert.deepEqual(sourceIds, score.sourceItemIds);
  assert.equal(sourceIds.length, 4, "provenance lists every referenced item, including the missing one");
  for (const item of w.items) {
    if (item.item_code === "Q9") continue;
    assert.ok(sourceIds.includes(item.id), `item ${item.item_code} must appear in source_item_ids_json`);
  }

  // Re-scoring appends a new row and supersedes the old one; the old row is immutable.
  const beforeRescore = w.db.prepare("SELECT raw_score, items_used, superseded_by_id FROM derived_score WHERE id = ?").get(row.id) as {
    raw_score: number;
    items_used: number;
    superseded_by_id: string | null;
  };
  assert.equal(beforeRescore.superseded_by_id, null);

  const second = scoreAndPersistSession(w.db, w.sessionT1.id, { computedBy: w.admin.id });
  assert.equal(second.persistedScoreIds.length, 1);
  assert.deepEqual(second.supersededScoreIds, first.persistedScoreIds);
  assert.deepEqual(second.result.scores[0]?.rawScore, score.rawScore, "re-scoring is deterministic");

  const history = listDerivedScores(w.db, { sessionId: w.sessionT1.id, includeSuperseded: true });
  assert.equal(history.length, 2, "the superseded row is preserved, not overwritten");
  const superseded = history.find((entry) => entry.id === row.id);
  assert.ok(superseded);
  assert.equal(superseded.superseded_by_id, second.persistedScoreIds[0]);
  assert.equal(superseded.raw_score, beforeRescore.raw_score, "the previous raw score is unchanged");
  assert.equal(superseded.items_used, beforeRescore.items_used);
  assert.equal(listDerivedScores(w.db, { sessionId: w.sessionT1.id }).length, 1, "only one active score remains");
  w.db.close();
});

// 6 -------------------------------------------------------- out-of-range data --

test("an out-of-range answer is excluded and counted, never silently neutralised", () => {
  const w = world();
  // Engine behaviour asserted here: an answer outside the declared item range is NOT
  // clamped and NOT used; it is treated as missing, so items_missing counts it and the
  // declared proration policy decides the score. (lib/domain/scoring.ts: resolveValue)
  const scored = scoreAndPersistSession(w.db, w.sessionT2.id, { computedBy: w.admin.id });
  const score = scored.result.scores[0];
  assert.ok(score);
  assert.equal(score.computability, "computed");
  assert.equal(score.itemsExpected, 4);
  assert.equal(score.itemsUsed, 3, "the out-of-range item does not count as used");
  assert.equal(score.itemsMissing, 1, "the out-of-range item is counted as missing");
  assert.equal(score.rawScore, 15 * (4 / 3), "(5 + reversed 2 + 4) scaled by itemsExpected/itemsUsed");
  assert.equal(score.methodologicallyProvisional, true);
  const diagnostics = score.diagnostics.map((entry) => entry.code);
  assert.ok(diagnostics.includes("scoring.value_out_of_range"), "the exclusion is reported as a diagnostic");

  const stored = listAnswers(w.db, w.sessionT2.id).find((answer) => answer.item_code === "02");
  assert.ok(stored);
  assert.equal(stored.value_numeric, 42, "the documented value is kept verbatim, never clamped");
  assert.equal(stored.raw_value_text, "42");
  assert.equal(stored.is_missing, 0, "the answer itself is not rewritten as missing");

  const row = listDerivedScores(w.db, { sessionId: w.sessionT2.id })[0];
  assert.ok(row);
  assert.equal(row.items_used, 3);
  assert.equal(row.items_missing, 1);
  assert.equal(row.is_provisional, 1);
  w.db.close();
});

// 7 ------------------------------------------------------------------- cohort --

test("cohort evaluation keeps unknown consent indeterminate and includes the participant only after consent", () => {
  const w = world();
  // Runtime traces are keyed by the persisted criterion row ID, not the source JSON rule ID.
  const criteria = listCriteria(w.db, w.studyId);
  const consentCriterion = criteria.find((row) => row.label === "Study consent granted");
  const ageCriterion = criteria.find((row) => row.label === "Age at enrolment 18+");
  assert.ok(consentCriterion && ageCriterion);

  const before = getStudyCohortPreview(w.db, w.studyId, w.pi);
  assert.equal(before.denominator, 1);
  assert.equal(before.included, 0, "a participant with unknown study consent is never included");
  assert.equal(before.indeterminate, 1);

  const evaluation = before.evaluations[0];
  assert.ok(evaluation);
  assert.equal(evaluation.decision, "indeterminate");
  assert.equal(evaluation.pseudonym, w.pseudonym);
  assert.equal(evaluation.traces.length, 2, "one consent rule and one attribute rule");
  for (const traceEntry of evaluation.traces) {
    assert.ok(traceEntry.explanation.trim().length > 0, `rule ${traceEntry.ruleId} needs an explanation`);
    assert.ok(traceEntry.observed.length > 0, `rule ${traceEntry.ruleId} needs an observed value`);
    assert.ok(traceEntry.expected.length > 0, `rule ${traceEntry.ruleId} needs an expected value`);
  }
  const consentTrace = evaluation.traces.find((traceEntry) => traceEntry.ruleId === consentCriterion.id);
  assert.ok(consentTrace);
  assert.equal(consentTrace.outcome, "indeterminate");
  assert.match(consentTrace.explanation, /no consent record/i);
  const ageTrace = evaluation.traces.find((traceEntry) => traceEntry.ruleId === ageCriterion.id);
  assert.equal(ageTrace?.outcome, "include");
  assert.equal(evaluation.indeterminateReasons.length, 1);

  // Only after the study-scoped consent is recorded does the participant qualify.
  recordConsent(w.db, {
    participantId: w.participantId,
    studyId: w.studyId,
    version: "fixture-consent-v1",
    status: "granted",
    basis: "written_signed",
    grantedAt: "2026-02-01T09:00:00.000Z",
    evidenceSourceId: w.sourceId,
    recordedBy: w.admin.id,
    notes: "Fixture study-scoped consent.",
  });

  const after = getStudyCohortPreview(w.db, w.studyId, w.pi);
  assert.equal(after.included, 1);
  assert.equal(after.indeterminate, 0);
  assert.equal(after.excluded, 0);
  const included = after.evaluations.find((entry) => entry.decision === "included");
  assert.ok(included, "the participant is included once the consent is documented");
  assert.equal(included.includeFailures, 0);
  assert.equal(included.traces.every((traceEntry) => traceEntry.explanation.trim().length > 0), true);
  w.db.close();
});

// 8 ---------------------------------------------------------- form preflight --

test("form preflight fails the required field with a documented missing source and still produces a dry-run payload", () => {
  const w = world();
  const report = w.preflightFailing;

  assert.equal(report.dryRun, true);
  assert.equal(report.outcome, "fail");

  const required = report.fields.find((entry) => entry.fieldId === w.requiredFieldId);
  assert.ok(required);
  assert.equal(required.outcome, "fail");
  assert.ok(
    required.issues.some((issue) => issue.message.includes(MISSING_SOURCE_MESSAGE)),
    `the required field must report "${MISSING_SOURCE_MESSAGE}"`,
  );
  assert.equal(required.resolvedValue, null, "no value is substituted for a documented missing answer");
  assert.equal(required.valueKind, "none");

  const optional = report.fields.find((entry) => entry.fieldId === w.optionalFieldId);
  assert.ok(optional);
  assert.equal(optional.outcome, "pass");
  assert.equal(optional.resolvedValue, "5");

  assert.equal(report.authorization.submissionAllowedByPlatform, false);
  assert.equal(report.blockingReasons.length > 0, true);
  assert.ok(report.blockingReasons.some((reason) => reason.includes(MISSING_SOURCE_MESSAGE)));
  assert.match(report.authorization.submissionBlockedReason ?? "", /external submission blocked/);

  // The dry-run payload is still produced: it contains the resolvable value only.
  assert.equal(report.payload[w.optionalFieldId], "5");
  assert.equal(w.requiredFieldId in report.payload, false);
  assert.equal(report.counts.fail, 1);
  // This field is mapped, but its documented answer is missing; it is not "unmapped".
  assert.equal(report.counts.unmappedRequired, 0);
  assert.equal(report.counts.missingSource, 1);
  w.db.close();
});

// 9 ---------------------------------------------------------- orchestration --

test("task orchestration gates approval, blocks external submission and refuses replay", async () => {
  const w = world();
  const task = createTaskFromPreflight({
    db: w.db,
    actor: w.pi,
    studyId: w.studyId,
    participantId: w.participantId,
    externalFormVersionId: w.formVersionId,
    assignedAgentId: null,
    taskKind: "submit_external_response",
    preflight: w.preflightClean,
    permittedAnswers: w.permittedAnswers,
  });
  assert.equal(task.state, "draft");
  assert.equal(task.requires_approval, 1);
  assert.equal(task.max_attempts, 3);
  assert.equal(task.kind, "submit_external_response");

  // Creating the same task again replays the existing row instead of duplicating it.
  const replay = createTaskFromPreflight({
    db: w.db,
    actor: w.pi,
    studyId: w.studyId,
    participantId: w.participantId,
    externalFormVersionId: w.formVersionId,
    assignedAgentId: null,
    taskKind: "submit_external_response",
    preflight: w.preflightClean,
    permittedAnswers: w.permittedAnswers,
  });
  assert.equal(replay.id, task.id, "the idempotency key returns the original task");
  assert.equal(count(w.db, "SELECT COUNT(*) AS total FROM agent_task WHERE idempotency_key = ?", task.idempotency_key), 1);

  const validated = validateTask(w.db, w.pi, task.id);
  assert.equal(validated.state, "validated");

  // Queueing before approval is refused, and a non-approver role cannot approve.
  assert.throws(
    () => queueTask(w.db, w.pi, task.id),
    (error: unknown) => isDomainError(error, "task.approval_required"),
    "a task that requires approval cannot be queued before it is approved",
  );
  assert.throws(
    () => approveTask(w.db, w.researcher, task.id, "fixture approval"),
    (error: unknown) => isDomainError(error, "auth.denied"),
    "a researcher without task:approve must not approve",
  );
  const approved = approveTask(w.db, w.pi, task.id, "Fixture approval recorded for the test.");
  assert.equal(approved.state, "approved");
  assert.equal(approved.approved_by, w.pi.id);
  assert.equal(approved.approval_note, "Fixture approval recorded for the test.");

  const queued = queueTask(w.db, w.pi, task.id);
  assert.equal(queued.state, "queued");

  const run = await runTask({ db: w.db, actor: w.pi, taskId: task.id, adapterId: "local-deterministic" });
  assert.equal(run.result.outcome, "needs_review", "an external submission can never be reported as succeeded");
  assert.equal(run.result.blockedByPolicy, true);
  assert.equal(run.task.state, "needs_review");
  assert.equal(run.task.attempt_count, 1);
  assert.match(run.result.message, /no authorized external submission path/);
  assert.equal(run.evidenceIds.length > 0, true, "evidence rows are written");

  const contract = JSON.parse(run.task.contract_json) as AgentTaskContract;
  assert.equal(contract.permissions.maySubmitExternalResponse, false);
  assert.equal(contract.callback.mode, "none");
  assert.equal(contract.taskKind, "submit_external_response");

  const attempts = listAttempts(w.db, task.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.attempt_number, 1);
  assert.equal(attempts[0]?.adapter, "local-deterministic");
  assert.equal(attempts[0]?.state_from, "queued");
  assert.equal(attempts[0]?.state_to, "running");
  const evidence = listEvidence(w.db, task.id);
  assert.equal(evidence.length >= 1, true);
  assert.equal(evidence.some((entry) => entry.evidence_type === "payload_snapshot"), true);

  // Replaying the same run must be refused instead of creating a second attempt.
  await assert.rejects(
    () => runTask({ db: w.db, actor: w.pi, taskId: task.id, adapterId: "local-deterministic" }),
    (error: unknown) => isDomainError(error, "task.not_runnable"),
    "a task in needs_review must not be re-run without an explicit retry",
  );

  // Retry budget: 3 attempts is the configured maximum.
  const retried = retryTask(w.db, w.pi, task.id);
  assert.equal(retried.state, "queued");
  const run2 = await runTask({ db: w.db, actor: w.pi, taskId: task.id, adapterId: "local-deterministic" });
  assert.equal(run2.task.attempt_count, 2);
  assert.equal(run2.task.state, "needs_review");
  retryTask(w.db, w.pi, task.id);
  const run3 = await runTask({ db: w.db, actor: w.pi, taskId: task.id, adapterId: "local-deterministic" });
  assert.equal(run3.task.attempt_count, 3);
  assert.equal(listAttempts(w.db, task.id).length, 3);
  assert.throws(
    () => retryTask(w.db, w.pi, task.id),
    (error: unknown) => isDomainError(error, "task.retry_budget_exhausted"),
    "retryTask must respect max_attempts",
  );

  // A preflight-only task performs no external submission and may succeed.
  const preflightTask = createTaskFromPreflight({
    db: w.db,
    actor: w.pi,
    studyId: w.studyId,
    participantId: w.participantId,
    externalFormVersionId: w.formVersionId,
    assignedAgentId: null,
    taskKind: "preflight_mapping",
    preflight: w.preflightClean,
    permittedAnswers: w.permittedAnswers,
  });
  validateTask(w.db, w.pi, preflightTask.id);
  approveTask(w.db, w.pi, preflightTask.id, "Fixture approval for the dry run.");
  queueTask(w.db, w.pi, preflightTask.id);
  const dryRun = await runTask({ db: w.db, actor: w.pi, taskId: preflightTask.id, adapterId: "local-deterministic" });
  assert.equal(dryRun.result.outcome, "succeeded");
  assert.equal(dryRun.task.state, "succeeded");
  assert.equal(dryRun.result.externalReceipt ?? null, null, "a local preflight returns no external receipt");
  assert.equal(dryRun.result.evidence.some((entry) => entry.evidenceType === "dry_run_report"), true);
  await assert.rejects(
    () => runTask({ db: w.db, actor: w.pi, taskId: preflightTask.id, adapterId: "local-deterministic" }),
    (error: unknown) => isDomainError(error, "task.already_succeeded"),
    "a succeeded task must never be executed twice",
  );

  // Every step recorded an audit event against the task.
  for (const action of ["task.create", "task.validate", "task.approve", "task.queue", "task.run", "task.retry"]) {
    const events = listAuditEvents(w.db, { organizationId: w.orgId, entityType: "agent_task", entityId: task.id, action });
    assert.equal(events.length > 0, true, `audit action ${action} must be recorded`);
  }
  const createEvents = listAuditEvents(w.db, { organizationId: w.orgId, entityType: "agent_task", action: "task.create.idempotent_replay" });
  assert.equal(createEvents.length, 1, "the idempotent replay is audited");

  const stored = getAgentTask(w.db, task.id);
  assert.equal(stored?.attempt_count, 3);
  w.db.close();
});

// 10 ----------------------------------------------------------- authorization --

test("authorization denies viewer writes and agent identity access", () => {
  const w = world();

  assert.throws(
    () => assertAuthorized(w.viewer, PERMISSIONS.participantWrite, { studyId: w.studyId }),
    (error: unknown) => isDomainError(error, "auth.denied"),
    "a viewer must not write participant data",
  );
  const viewerDecision = authorize(w.viewer, PERMISSIONS.participantWrite, { studyId: w.studyId });
  assert.equal(viewerDecision.allowed, false);
  assert.equal(viewerDecision.policyCode, "rbac.missing_permission");
  assert.equal(viewerDecision.missingPermission, PERMISSIONS.participantWrite);
  assert.equal(authorize(w.viewer, PERMISSIONS.participantRead, { studyId: w.studyId }).allowed, true);

  assert.throws(
    () => assertAuthorized(w.agent, PERMISSIONS.identityRead),
    (error: unknown) => isDomainError(error, "auth.denied"),
    "an agent actor must not read restricted identity data",
  );

  // Even an agent that somehow holds the permission is refused: human approval only.
  const overprivileged = { ...w.agent, permissions: [...w.agent.permissions, PERMISSIONS.identityRead] };
  const agentDecision = authorize(overprivileged, PERMISSIONS.identityRead);
  assert.equal(agentDecision.allowed, false);
  assert.equal(agentDecision.policyCode, "rbac.agent_forbidden");
  assert.match(agentDecision.reason, /human approval is required/);

  // Registration is organization-scoped, but the actor must still hold agent:write.
  assert.equal(authorize(w.agent, PERMISSIONS.agentWrite, { studyId: w.studyId }).allowed, false);
  const authorizedAgent = { ...w.agent, permissions: [...w.agent.permissions, PERMISSIONS.agentWrite] };
  const scopedAllowed = authorize(authorizedAgent, PERMISSIONS.agentWrite, { studyId: w.studyId });
  assert.equal(scopedAllowed.allowed, true, "an explicitly granted agentWrite needs no study write grant");
  assert.equal(authorize(w.viewer, PERMISSIONS.studyWrite, { studyId: w.studyId }).allowed, false);
  w.db.close();
});

// 11 ------------------------------------------------------------- append-only --

test("observed_answer and audit_event remain append-only on a live database", () => {
  const w = world();
  const answerId = listAnswers(w.db, w.sessionT1.id)[0]?.id;
  assert.ok(answerId);

  assert.throws(
    () => w.db.prepare("UPDATE observed_answer SET value_numeric = 7 WHERE id = ?").run(answerId),
    /append-only/i,
    "observed_answer must reject updates",
  );
  assert.throws(
    () => w.db.prepare("DELETE FROM observed_answer WHERE id = ?").run(answerId),
    /cannot be deleted/i,
    "observed_answer must reject deletes",
  );

  const auditId = listAuditEvents(w.db, { organizationId: w.orgId })[0]?.id;
  assert.ok(auditId);
  assert.throws(
    () => w.db.prepare("UPDATE audit_event SET action = 'tampered' WHERE id = ?").run(auditId),
    /append-only/i,
    "audit_event must reject updates",
  );
  assert.throws(
    () => w.db.prepare("DELETE FROM audit_event WHERE id = ?").run(auditId),
    /append-only/i,
    "audit_event must reject deletes",
  );

  // Scores are materialized explicitly; world() only documents observed answers.
  const scored = scoreAndPersistSession(w.db, w.sessionT1.id, { computedBy: w.admin.id });
  const derivedId = scored.persistedScoreIds[0];
  assert.ok(derivedId);
  assert.throws(
    () => w.db.prepare("UPDATE derived_score SET raw_score = 999 WHERE id = ?").run(derivedId),
    /immutable|append-only|cannot be (modified|updated)/i,
    "derived scores must not be rewritten after computation",
  );
  w.db.close();
});

// 12 ------------------------------------------------- enrolment + provenance --

test("enrolment and evidence links keep the participant study-scoped and traceable", () => {
  const w = world();
  const enrolment = enrolParticipant(w.db, {
    studyId: w.studyId,
    participantId: w.participantId,
    enrolmentSource: "fixture enrolment",
    status: "enrolled",
    enrolledAt: "2026-02-01T09:30:00.000Z",
  });
  assert.equal(enrolment.participant_id, w.participantId);
  assert.equal(enrolment.status, "enrolled");

  // Enrolment is idempotent per (study, participant).
  const again = enrolParticipant(w.db, {
    studyId: w.studyId,
    participantId: w.participantId,
    enrolmentSource: "fixture enrolment",
  });
  assert.equal(again.id, enrolment.id);
  assert.equal(count(w.db, "SELECT COUNT(*) AS total FROM study_participant WHERE study_id = ?", w.studyId), 1);

  const session = snapshotSession(w.db, w.sessionT1.id);
  assert.equal(session.documented_source_id, w.sourceId, "a session always cites its documented source");
  assert.equal(
    count(w.db, "SELECT COUNT(*) AS total FROM evidence_link WHERE entity_type = 'participant' AND entity_id = ?", w.participantId),
    1,
    "the participant carries exactly one provenance link",
  );
  assert.equal(
    count(w.db, "SELECT COUNT(*) AS total FROM evidence_link WHERE documented_source_id = ?", w.sourceId),
    1,
  );
  w.db.close();
});
