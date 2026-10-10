import { requireAuth } from "../../lib/services/session.ts";
import { assertAuthorized, PERMISSIONS } from "../../lib/services/authz.ts";
import { auditIntegrityReport, listAuditEvents } from "../../lib/services/audit.ts";
import { assessRetention, listExportJobs } from "../../lib/repo/exports.ts";
import { Chip, EmptyState, Metric, Note, Panel, formatDateTime, stateTone } from "../../components/ui.tsx";

export const dynamic = "force-dynamic";

/** Organization-scoped, read-only audit and export monitoring. */
export default async function AuditPage() {
  const { db, actor } = await requireAuth();
  assertAuthorized(actor, PERMISSIONS.auditRead);
  const report = auditIntegrityReport(db, actor.organizationId);
  const events = listAuditEvents(db, { organizationId: actor.organizationId, limit: 100 });
  const exports = listExportJobs(db, actor.organizationId, 40);
  const retention = assessRetention(db, actor.organizationId);

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Audit &amp; Exports</h1>
        <p className="mt-0.5 max-w-[90ch] text-[0.8125rem] text-[#55606d]">
          Read-only view of immutable audit events, export job states and retention reviews for your organization.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Audit events" value={report.totalEvents} />
        <Metric label="Denied actions" value={report.byOutcome.denied ?? 0} tone={report.byOutcome.denied ? "partial" : "neutral"} />
        <Metric label="Export jobs" value={exports.length} hint="latest 40 jobs" />
        <Metric label="Append-only guard" value={report.appendOnlyEnforced ? "Active" : "Missing"} tone={report.appendOnlyEnforced ? "verified" : "blocked"} />
      </div>
      {!report.appendOnlyEnforced ? (
        <Note tone="fail">Audit immutability triggers are missing. Review database migrations before processing research data.</Note>
      ) : null}
      <Panel title="Audit trail" subtitle="Recent events, newest first. Detailed payloads and private identity are not shown here.">
        {events.length === 0 ? <EmptyState>No audit events have been recorded for this organization.</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="data-table w-full text-left">
              <thead><tr><th>Time (UTC)</th><th>Action</th><th>Actor</th><th>Entity</th><th>Outcome</th></tr></thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="mono whitespace-nowrap">{formatDateTime(event.occurred_at)}</td>
                    <td>{event.action}</td>
                    <td>{event.actor_label}</td>
                    <td>{event.entity_type}</td>
                    <td><Chip tone={stateTone(event.outcome)}>{event.outcome}</Chip></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Export jobs" subtitle="Requests and approvals are handled separately through permission-checked services.">
        {exports.length === 0 ? <EmptyState>No exports have been requested.</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="data-table w-full text-left">
              <thead><tr><th>Requested (UTC)</th><th>Scope</th><th>Format</th><th>Identity</th><th>Status</th></tr></thead>
              <tbody>
                {exports.map((job) => (
                  <tr key={job.id}>
                    <td className="mono whitespace-nowrap">{formatDateTime(job.requested_at)}</td>
                    <td>{job.scope}</td>
                    <td>{job.format}</td>
                    <td>{job.contains_identity === 1 ? "Restricted" : "No"}</td>
                    <td><Chip tone={stateTone(job.status)}>{job.status}</Chip></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Retention review" subtitle="No records are deleted or anonymized by opening this page.">
        {retention.length === 0 ? <EmptyState>No retention policies have been configured.</EmptyState> : (
          <div className="p-4 space-y-2">
            {retention.map((entry) => (
              <div key={entry.entityType} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dfe3e8] py-2">
                <div><p className="font-medium">{entry.entityType}</p><p className="text-xs text-[#55606d]">{entry.note}</p></div>
                <Chip tone={entry.eligibleCount > 0 ? "partial" : "neutral"}>{entry.eligibleCount} due for review</Chip>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
