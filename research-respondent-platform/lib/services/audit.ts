/**
 * Immutable audit trail.
 *
 * `audit_event` is append-only at the storage layer (see migration 0002), so
 * this module only ever inserts. Every consequential action in the platform is
 * recorded here, including denials.
 */
import type { Db } from "../../db/index.ts";
import { newId, nowIso, safeJsonParse } from "../util/ids.ts";
import type { Actor } from "../domain/types.ts";

export interface AuditInput {
  organizationId: string;
  actor: Actor;
  action: string;
  entityType: string;
  entityId?: string | null;
  studyId?: string | null;
  participantId?: string | null;
  outcome: "success" | "failure" | "denied" | "partial";
  severity?: "info" | "notice" | "warning" | "critical";
  detail?: Record<string, unknown>;
  requestId?: string | null;
  ipHint?: string | null;
  occurredAt?: string;
}

export interface AuditEventRow {
  id: string;
  organization_id: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  study_id: string | null;
  participant_id: string | null;
  outcome: string;
  severity: string;
  detail_json: string;
  request_id: string | null;
  ip_hint: string | null;
}

const SENSITIVE_KEY_PATTERN = /(password|secret|token|apikey|api_key|authorization|cookie)/i;

/**
 * Removes credential-shaped keys and truncates long strings so that audit
 * detail can never become a secret leak.
 */
export function scrubAuditDetail(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[depth-limit]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => scrubAuditDetail(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = "[redacted]";
        continue;
      }
      output[key] = scrubAuditDetail(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function recordAudit(db: Db, input: AuditInput): string {
  const id = newId("aud");
  db.prepare(
    `INSERT INTO audit_event (
       id, organization_id, occurred_at, actor_type, actor_id, actor_label, action,
       entity_type, entity_id, study_id, participant_id, outcome, severity, detail_json, request_id, ip_hint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.organizationId,
    input.occurredAt ?? nowIso(),
    input.actor.type,
    input.actor.id,
    input.actor.label,
    input.action,
    input.entityType,
    input.entityId ?? null,
    input.studyId ?? null,
    input.participantId ?? null,
    input.outcome,
    input.severity ?? "info",
    JSON.stringify(scrubAuditDetail(input.detail ?? {})),
    input.requestId ?? null,
    input.ipHint ?? null,
  );
  return id;
}

/** Convenience wrapper for a denial that must not throw. */
export function recordDenial(db: Db, input: Omit<AuditInput, "outcome" | "severity">): string {
  return recordAudit(db, { ...input, outcome: "denied", severity: "warning" });
}

export interface AuditQuery {
  organizationId: string;
  studyId?: string;
  participantId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  outcome?: string;
  severity?: string;
  actorLabel?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export function listAuditEvents(db: Db, query: AuditQuery): AuditEventRow[] {
  const clauses: string[] = ["organization_id = ?"];
  const params: unknown[] = [query.organizationId];
  const add = (sql: string, value: unknown) => {
    clauses.push(sql);
    params.push(value);
  };
  if (query.studyId) add("study_id = ?", query.studyId);
  if (query.participantId) add("participant_id = ?", query.participantId);
  if (query.entityType) add("entity_type = ?", query.entityType);
  if (query.entityId) add("entity_id = ?", query.entityId);
  if (query.action) add("action = ?", query.action);
  if (query.outcome) add("outcome = ?", query.outcome);
  if (query.severity) add("severity = ?", query.severity);
  if (query.actorLabel) add("actor_label LIKE ?", `%${query.actorLabel}%`);
  if (query.since) add("occurred_at >= ?", query.since);
  if (query.until) add("occurred_at <= ?", query.until);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  return db
    .prepare(
      `SELECT * FROM audit_event WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as AuditEventRow[];
}

export function countAuditEvents(db: Db, query: AuditQuery): number {
  const clauses: string[] = ["organization_id = ?"];
  const params: unknown[] = [query.organizationId];
  if (query.studyId) {
    clauses.push("study_id = ?");
    params.push(query.studyId);
  }
  if (query.outcome) {
    clauses.push("outcome = ?");
    params.push(query.outcome);
  }
  if (query.since) {
    clauses.push("occurred_at >= ?");
    params.push(query.since);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM audit_event WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { total: number };
  return row.total;
}

export function parseAuditDetail(row: AuditEventRow): Record<string, unknown> {
  return safeJsonParse<Record<string, unknown>>(row.detail_json, {});
}

export interface AuditIntegrityReport {
  totalEvents: number;
  byOutcome: Record<string, number>;
  bySeverity: Record<string, number>;
  deniedActions: Array<{ action: string; count: number }>;
  oldestEvent: string | null;
  newestEvent: string | null;
  /** Any UPDATE/DELETE attempt would have raised; this proves immutability is armed. */
  appendOnlyEnforced: boolean;
}

export function auditIntegrityReport(db: Db, organizationId: string): AuditIntegrityReport {
  const byOutcome = db
    .prepare("SELECT outcome, COUNT(*) AS total FROM audit_event WHERE organization_id = ? GROUP BY outcome")
    .all(organizationId) as Array<{ outcome: string; total: number }>;
  const bySeverity = db
    .prepare("SELECT severity, COUNT(*) AS total FROM audit_event WHERE organization_id = ? GROUP BY severity")
    .all(organizationId) as Array<{ severity: string; total: number }>;
  const denied = db
    .prepare(
      `SELECT action, COUNT(*) AS count FROM audit_event
       WHERE organization_id = ? AND outcome = 'denied' GROUP BY action ORDER BY count DESC LIMIT 20`,
    )
    .all(organizationId) as Array<{ action: string; count: number }>;
  const range = db
    .prepare(
      "SELECT MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest, COUNT(*) AS total FROM audit_event WHERE organization_id = ?",
    )
    .get(organizationId) as { oldest: string | null; newest: string | null; total: number };
  const triggers = db
    .prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_audit_event_no_%'")
    .get() as { total: number };
  return {
    totalEvents: range.total,
    byOutcome: Object.fromEntries(byOutcome.map((row) => [row.outcome, row.total])),
    bySeverity: Object.fromEntries(bySeverity.map((row) => [row.severity, row.total])),
    deniedActions: denied,
    oldestEvent: range.oldest,
    newestEvent: range.newest,
    appendOnlyEnforced: triggers.total === 2,
  };
}
