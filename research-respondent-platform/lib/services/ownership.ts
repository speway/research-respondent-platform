/** Fixed queries keep organization ownership checks at server-action boundaries. */
import { assertAuthorized, authorize, type Permission } from "./authz.ts";
import type { Db } from "../../db/index.ts";
import { DomainError, type Actor } from "../domain/types.ts";

const queries = {
  task: "SELECT organization_id FROM agent_task WHERE id = ?",
  agent: "SELECT organization_id FROM agent WHERE id = ?",
  capability: "SELECT a.organization_id FROM agent_capability c JOIN agent a ON a.id = c.agent_id WHERE c.id = ?",
  study: "SELECT organization_id FROM study WHERE id = ?",
  participant: "SELECT organization_id FROM participant WHERE id = ?",
  export: "SELECT organization_id FROM export_job WHERE id = ?",
  segment: "SELECT organization_id FROM segment WHERE id = ?",
  instrument: "SELECT organization_id FROM instrument WHERE id = ?",
  instrumentVersion: "SELECT i.organization_id FROM instrument_version v JOIN instrument i ON i.id = v.instrument_id WHERE v.id = ?",
  session: "SELECT p.organization_id FROM assessment_session s JOIN participant p ON p.id = s.participant_id WHERE s.id = ?",
  form: "SELECT organization_id FROM external_form WHERE id = ?",
  formVersion: "SELECT f.organization_id FROM external_form_version v JOIN external_form f ON f.id = v.external_form_id WHERE v.id = ?",
  formField: "SELECT f.organization_id FROM external_form_field x JOIN external_form_version v ON v.id = x.external_form_version_id JOIN external_form f ON f.id = v.external_form_id WHERE x.id = ?",
} as const;

export function assertOwned(db: Db, actor: Actor, kind: keyof typeof queries, id: string): void {
  const record = db.prepare(queries[kind]).get(id) as { organization_id: string } | undefined;
  if (!record || record.organization_id !== actor.organizationId) {
    throw new DomainError("auth.denied", "Record is unavailable in this organization.");
  }
}

export function assertStudyChild(db: Db, studyId: string, kind: "criterion" | "mapping", id: string): void {
  const table = kind === "criterion" ? "recruitment_criterion" : "field_mapping";
  const row = db.prepare(`SELECT study_id FROM ${table} WHERE id = ?`).get(id) as { study_id: string } | undefined;
  if (!row || row.study_id !== studyId) throw new DomainError("auth.denied", "Record is unavailable in this study.");
}

/** Participant-wide edits require a grant in at least one enrolled study. */
export function assertParticipantPermission(db: Db, actor: Actor, participantId: string, permission: Permission): void {
  assertOwned(db, actor, "participant", participantId);
  if (!actor.permissionStudyScopes?.[permission]) { assertAuthorized(actor, permission); return; }
  const studies = db.prepare("SELECT study_id FROM study_participant WHERE participant_id = ?")
    .all(participantId) as Array<{ study_id: string }>;
  if (!studies.some((study) => authorize(actor, permission, { studyId: study.study_id }).allowed)) {
    throw new DomainError("auth.denied", "Participant edit requires an enrolled study grant.");
  }
}
