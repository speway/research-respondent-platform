/**
 * Import commit.
 *
 * Persists a reviewed import plan. Every write is attributable: the plan's
 * documented source, per-answer locators, an explicit consent record per study
 * and participant, and an audit event for the run.
 */
import type { Db } from "../../db/index.ts";
import { DomainError, type ImportCommitResult, type ImportPlan, type ImportPlanRow } from "../domain/types.ts";
import { newId, nowIso } from "../util/ids.ts";
import {
  createParticipant,
  findParticipantByIdentityEmail,
  findParticipantByPseudonym,
  getParticipant,
  nextPseudonym,
  recordConsent,
  upsertPrivateIdentity,
} from "../repo/participants.ts";
import {
  createAssessmentSession,
  persistAnswers,
  type ItemRow,
  type AnswerInput,
} from "../repo/assessments.ts";
import { registerDocumentedSource, addEvidenceLink } from "../repo/sources.ts";
import { enrolParticipant } from "../repo/studies.ts";
import { recordAudit } from "./audit.ts";
import type { Actor } from "../domain/types.ts";

export interface CommitOptions {
  actor: Actor;
  itemByCode: Map<string, ItemRow>;
  instrumentVersionId: string;
  studyId: string | null;
  protocolVersionId?: string | null;
  /** Fail (true) or skip (false) when a pseudonym already exists. */
  failOnExistingPseudonym?: boolean;
  /**
   * Attach a consent record to every imported participant for this study.
   * Required when the source document does not already contain one.
   */
  attachConsent: boolean;
  /** Optional override of the pseudonym prefix used by the plan. */
  pseudonymPrefix?: string;
}

export function commitImportPlan(db: Db, plan: ImportPlan, options: CommitOptions): ImportCommitResult {
  if (plan.blockers.length > 0) {
    throw new DomainError("import.blocked", "Refusing to commit a plan with blocking issues.", {
      blockers: plan.blockers.map((blocker) => blocker.code),
    });
  }
  const usableRows = plan.rows.filter((row) => !row.skippable);
  if (usableRows.length === 0) {
    throw new DomainError("import.no_usable_rows", "No usable rows to import.");
  }

  const result: ImportCommitResult = {
    documentedSourceId: "",
    sessionsCreated: 0,
    answersCreated: 0,
    participantsCreated: 0,
    participantsMatched: 0,
    identityRecordsCreated: 0,
    consentRecordsCreated: 0,
    skippedRows: plan.rows.length - usableRows.length,
    auditEventIds: [],
  };

  const timestamp = nowIso();
  const tx = db.transaction(() => {
    const source = registerDocumentedSource(db, {
      ...plan.descriptor,
      rowCount: plan.summary.totalRows,
      recordedBy: options.actor.id,
    });
    result.documentedSourceId = source.id;

    for (const row of usableRows) {
      const persisted = persistRow(db, row, plan, options, source.id, timestamp, result);
      if (persisted) {
        result.sessionsCreated += 1;
      }
    }
  });
  tx();

  const auditId = recordAudit(db, {
    organizationId: options.actor.organizationId,
    actor: options.actor,
    action: "import.commit",
    entityType: "documented_source",
    entityId: result.documentedSourceId,
    studyId: options.studyId,
    outcome: "success",
    severity: "notice",
    detail: {
      sourceTitle: plan.descriptor.title,
      reference: plan.descriptor.reference,
      originType: plan.descriptor.originType,
      timepoint: plan.options.timepointLabel,
      usableRows: usableRows.length,
      skippedRows: result.skippedRows,
      sessionsCreated: result.sessionsCreated,
      answersCreated: result.answersCreated,
      participantsCreated: result.participantsCreated,
      participantsMatched: result.participantsMatched,
      consentDeclaredBy: plan.options.consent.evidenceNote,
      perItemMissing: plan.summary.perItemMissing,
    },
  });
  result.auditEventIds.push(auditId);
  return result;
}

function persistRow(
  db: Db,
  row: ImportPlanRow,
  plan: ImportPlan,
  options: CommitOptions,
  documentedSourceId: string,
  timestamp: string,
  result: ImportCommitResult,
): boolean {
  const answers = row.items.filter((item) => !item.isMissing);
  if (answers.length === 0) {
    return false;
  }

  let participantId: string | null = null;
  let matchedExisting = false;

  if (row.identity?.contact_email) {
    const existing = findParticipantByIdentityEmail(db, row.identity.contact_email);
    if (existing) {
      participantId = existing.id;
      matchedExisting = true;
    }
  }
  if (!participantId && row.participantKey) {
    const existing = findParticipantByPseudonym(db, options.actor.organizationId, row.participantKey);
    if (existing) {
      participantId = existing.id;
      matchedExisting = true;
    }
  }
  if (!participantId) {
    const existing = findParticipantByPseudonym(db, options.actor.organizationId, row.pseudonym);
    if (existing) {
      if (options.failOnExistingPseudonym) {
        throw new DomainError("import.pseudonym_conflict", `Pseudonym ${row.pseudonym} already exists.`, {
          participantId: existing.id,
          rowNumber: row.rowNumber,
        });
      }
      participantId = existing.id;
      matchedExisting = true;
    }
  }

  const identity = row.identity;
  if (!participantId) {
    const created = createParticipant(db, {
      organizationId: options.actor.organizationId,
      pseudonym: row.pseudonym,
      attributes: {
        age_at_enrolment: normalizeAttributeInteger(row.attributes["age"] ?? row.attributes["age_at_enrolment"] ?? null),
        birth_year: normalizeAttributeInteger(row.attributes["birth_year"] ?? null),
        self_described_gender: normalizeAttributeString(row.attributes["gender"] ?? row.attributes["self_described_gender"] ?? null),
        preferred_language: normalizeAttributeString(row.attributes["language"] ?? plan.options.language),
        education_level: normalizeAttributeString(row.attributes["education_level"] ?? null),
        region: normalizeAttributeString(row.attributes["region"] ?? null),
        recruitment_channel: normalizeAttributeString(row.attributes["recruitment_channel"] ?? null),
      },
      unknownAttributes: [],
      notes: `Created by documented import of "${plan.descriptor.title}" (${plan.descriptor.reference}), timepoint ${plan.options.timepointLabel}.`,
      createdBy: options.actor.id,
      evidenceDocumentedSourceId: documentedSourceId,
      evidenceLocator: `row ${row.rowNumber}`,
      consent: {
        studyId: options.studyId,
        version: plan.options.consent.version,
        basis: plan.options.consent.basis,
        status: plan.options.consent.declared ? "granted" : "declined",
        grantedAt: plan.options.consent.grantedAt ?? null,
        scope: plan.options.consent.scope,
        notes: plan.options.consent.evidenceNote,
      },
      identity: identity
        ? {
            fullName: identity.full_name ?? null,
            contactEmail: identity.contact_email ?? null,
            contactPhone: identity.contact_phone ?? null,
            lawfulBasis: `Research data processing under documented consent: ${plan.options.consent.evidenceNote}`,
          }
        : null,
    });
    participantId = created.participant.id;
    result.participantsCreated += 1;
    if (created.identityWritten) {
      result.identityRecordsCreated += 1;
    }
  } else if (matchedExisting) {
    result.participantsMatched += 1;
    if (identity && plan.options.storeIdentity) {
      upsertPrivateIdentity(db, {
        participantId,
        fullName: identity.full_name ?? null,
        contactEmail: identity.contact_email ?? null,
        contactPhone: identity.contact_phone ?? null,
        contactHandle: null,
        lawfulBasis: `Research data processing under documented consent: ${plan.options.consent.evidenceNote}`,
        recordedBy: options.actor.id,
      });
      result.identityRecordsCreated += 1;
    }
  }

  if (!participantId) {
    throw new DomainError("import.participant_unresolved", `Row ${row.rowNumber}: could not resolve a participant record.`);
  }

  const session = createAssessmentSession(db, {
    studyId: options.studyId,
    participantId,
    instrumentVersionId: options.instrumentVersionId,
    timepointLabel: plan.options.timepointLabel,
    administrationMode: plan.options.administrationMode,
    language: plan.options.language,
    completedAt: row.collectedAt,
    documentedSourceId,
    protocolVersionId: options.protocolVersionId ?? null,
    qualityFlags: collectRowFlags(row),
    notes: `Imported from ${plan.descriptor.reference}, row ${row.rowNumber}.`,
    recordedBy: options.actor.id,
  });

  const answerInputs: AnswerInput[] = [];
  for (const item of row.items) {
    const definition = options.itemByCode.get(item.itemCode);
    if (!definition) {
      throw new DomainError("import.unknown_item", `Item ${item.itemCode} is not part of the target instrument version.`);
    }
    answerInputs.push({
      itemDefinitionId: definition.id,
      itemCode: item.itemCode,
      rawValueText: item.rawValueText,
      valueNumeric: item.valueNumeric,
      valueCoded: item.valueCoded,
      isMissing: item.isMissing,
      missingReason: item.missingReason,
      sourceLocator: `row ${row.rowNumber}, column ${item.columnIndex + 1} ("${item.itemCode}")`,
      collectedAt: row.collectedAt,
    });
  }
  const written = persistAnswers(db, session, answerInputs, options.actor.id);
  result.answersCreated += written;

  addEvidenceLink(db, {
    documentedSourceId,
    entityType: "assessment_session",
    entityId: session.id,
    locator: `row ${row.rowNumber}`,
    note: `${written} answer(s) recorded for ${plan.options.timepointLabel}`,
  });

  if (options.attachConsent) {
    const existingConsent = db
      .prepare(
        `SELECT id FROM consent_record WHERE participant_id = ? AND ((study_id IS NULL AND ? IS NULL) OR study_id = ?)
           AND consent_version = ? LIMIT 1`,
      )
      .get(participantId, options.studyId, options.studyId, plan.options.consent.version) as { id: string } | undefined;
    if (!existingConsent) {
      recordConsent(db, {
        participantId,
        studyId: options.studyId,
        version: plan.options.consent.version,
        status: "granted",
        basis: plan.options.consent.basis,
        grantedAt: plan.options.consent.grantedAt ?? null,
        scope: plan.options.consent.scope,
        evidenceSourceId: documentedSourceId,
        recordedBy: options.actor.id,
        notes: plan.options.consent.evidenceNote,
      });
      result.consentRecordsCreated += 1;
    }
  }

  if (options.studyId) {
    enrolParticipant(db, {
      studyId: options.studyId,
      participantId,
      enrolmentSource: `documented import: ${plan.descriptor.title}`,
      status: "enrolled",
      enrolledAt: row.collectedAt ?? timestamp,
    });
  }

  return true;
}

function collectRowFlags(row: ImportPlanRow): string[] {
  const flags = new Set<string>();
  for (const item of row.items) {
    for (const code of item.issueCodes) {
      flags.add(code);
    }
  }
  for (const issue of row.issues) {
    if (issue.severity !== "info") {
      flags.add(issue.code);
    }
  }
  return [...flags];
}

function normalizeAttributeInteger(value: string | number | boolean | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const match = /\d{1,3}/.exec(String(value));
  return match ? Number.parseInt(match[0], 10) : null;
}

function normalizeAttributeString(value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

/** Resolves the pseudonym that the commit would use, for dry-run reporting. */
export function previewPseudonyms(db: Db, organizationId: string, plan: ImportPlan, prefix = "P"): string[] {
  const existing = new Set(
    (db.prepare("SELECT pseudonym FROM participant WHERE organization_id = ?").all(organizationId) as Array<{
      pseudonym: string;
    }>).map((row) => row.pseudonym),
  );
  const start = Number.parseInt(nextPseudonym(db, organizationId, prefix).split("-").pop() ?? "1", 10);
  let counter = Number.isFinite(start) ? start : 1;
  return plan.rows
    .filter((row) => !row.skippable)
    .map((row) => {
      if (row.identity?.contact_email) {
        const match = findParticipantByIdentityEmail(db, row.identity.contact_email);
        if (match) {
          return match.pseudonym;
        }
      }
      if (row.participantKey && existing.has(row.participantKey)) {
        return row.participantKey;
      }
      let candidate = row.pseudonym;
      while (existing.has(candidate)) {
        candidate = `${prefix}-${String(counter).padStart(3, "0")}`;
        counter += 1;
      }
      existing.add(candidate);
      return candidate;
    });
}

export function participantExists(db: Db, participantId: string): boolean {
  return getParticipant(db, participantId) !== undefined;
}

export function makeSessionLocator(rowNumber: number): string {
  return `row ${rowNumber}`;
}

export function importRunId(): string {
  return newId("imp");
}
