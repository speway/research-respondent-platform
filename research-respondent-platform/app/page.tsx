import Link from "next/link";
import { redirect } from "next/navigation";
import { hostingMode } from "../lib/services/hosting-policy.ts";
import { Panel, Metric, Chip, formatDateTime, stateTone } from "../components/ui.tsx";
import { requireAuth } from "../lib/services/session.ts";
import { listStudies, studyOverviewCounts } from "../lib/repo/studies.ts";
import { countParticipants } from "../lib/repo/participants.ts";
import { provenanceCoverage, listDocumentedSources } from "../lib/repo/sources.ts";
import { sessionCoverage } from "../lib/repo/assessments.ts";
import { taskQueueSummary } from "../lib/repo/tasks.ts";
import { auditIntegrityReport, listAuditEvents } from "../lib/services/audit.ts";
import { assessRetention } from "../lib/repo/exports.ts";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  if (hostingMode(process.env) === "isolated-preview") redirect("/workbench");
  const { db, actor } = await requireAuth();
  const organizationId = actor.organizationId;

  const studies = listStudies(db, organizationId);
  const participants = countParticipants(db, organizationId);
  const coverage = provenanceCoverage(db, organizationId);
  const sessions = sessionCoverage(db);
  const queue = taskQueueSummary(db, organizationId);
  const audit = auditIntegrityReport(db, organizationId);
  const sources = listDocumentedSources(db, organizationId, 8);
  const recentAudit = listAuditEvents(db, { organizationId, limit: 12 });
  const retention = assessRetention(db, organizationId);

  const dataQualityAlerts: Array<{ tone: "warn" | "fail" | "ok"; text: string }> = [];
  if (coverage.answersTotal === 0) {
    dataQualityAlerts.push({
      tone: "warn",
      text: "No observed answers are stored yet. Import a documented source (Participants → Import) before building cohorts or scoring.",
    });
  }
  if (coverage.answersTotal > 0 && coverage.answersWithSource !== coverage.answersTotal) {
    dataQualityAlerts.push({
      tone: "fail",
      text: `${coverage.answersTotal - coverage.answersWithSource} answer(s) lack a documented source link. This must not happen; inspect the audit log.`,
    });
  } else if (coverage.answersTotal > 0) {
    dataQualityAlerts.push({
      tone: "ok",
      text: `Every recorded answer (${coverage.answersTotal}) links to a documented source.`,
    });
  }
  if (coverage.scoresTotal > coverage.scoresWithAlgorithm) {
    dataQualityAlerts.push({
      tone: "fail",
      text: `${coverage.scoresTotal - coverage.scoresWithAlgorithm} derived score(s) lack a scoring-algorithm version.`,
    });
  }
  if (sessions.missing > 0) {
    dataQualityAlerts.push({
      tone: "warn",
      text: `${sessions.missing} item response(s) are documented as missing. They stay missing; they are never imputed.`,
    });
  }
  const expiringRetention = retention.filter((entry) => entry.eligibleCount > 0);
  if (expiringRetention.length > 0) {
    dataQualityAlerts.push({
      tone: "warn",
      text: `${expiringRetention.length} retention policy rule(s) have records past their retention period. Review Audit & Exports.`,
    });
  }
  if (!audit.appendOnlyEnforced) {
    dataQualityAlerts.push({ tone: "fail", text: "Audit append-only triggers are missing from the database." });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
          <p className="mt-0.5 text-[0.8125rem] text-[#55606d]">
            Signed in as <span className="mono">{actor.label}</span> · roles: {actor.roles.join(", ") || "none"}
          </p>
        </div>
        <Link href="/participants/import" className="btn btn-primary no-underline">
          Import documented source
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Studies" value={studies.length} hint={`${studies.filter((study) => study.status === "active").length} active`} />
        <Metric label="Participants" value={participants} hint="pseudonymous registry entries" />
        <Metric
          label="Documented sources"
          value={coverage.sourceCount}
          hint={`${coverage.checksummedSources} with recorded checksum`}
        />
        <Metric
          label="Observed answers"
          value={coverage.answersTotal}
          hint={`${coverage.answersWithSource} with provenance`}
          tone={coverage.answersTotal > 0 && coverage.answersWithSource === coverage.answersTotal ? "verified" : "partial"}
        />
        <Metric label="Assessment sessions" value={sessions.sessions} hint={`${sessions.answers} recorded responses`} />
        <Metric
          label="Missing responses"
          value={sessions.missing}
          hint="preserved as missing, never filled"
          tone={sessions.missing > 0 ? "partial" : "neutral"}
        />
        <Metric label="Derived scores" value={coverage.scoresTotal} hint={`${coverage.scoresWithAlgorithm} versioned`} />
        <Metric
          label="Tasks awaiting approval"
          value={queue.awaitingApproval}
          hint={`${queue.byState.queued ?? 0} queued · ${queue.byState.needs_review ?? 0} need review`}
          tone={queue.awaitingApproval > 0 ? "partial" : "neutral"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Studies" subtitle="Each study carries its own protocol versions, criteria and permissions.">
          {studies.length === 0 ? (
            <p className="empty-state">
              No studies yet. <Link href="/studies">Create the first study</Link> to define a research question,
              protocol version and eligibility criteria.
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th className="num">Participants</th>
                  <th className="num">Protocols</th>
                  <th className="num">Tasks</th>
                </tr>
              </thead>
              <tbody>
                {studies.map((study) => {
                  const counts = studyOverviewCounts(db, study.id);
                  return (
                    <tr key={study.id}>
                      <td className="mono">
                        <Link href={`/studies/${study.id}`}>{study.code}</Link>
                      </td>
                      <td>{study.title}</td>
                      <td>
                        <Chip tone={stateTone(study.status)}>{study.status}</Chip>
                      </td>
                      <td className="num">{study.participant_count}</td>
                      <td className="num">{study.protocol_count}</td>
                      <td className="num">
                        {Object.values(counts.tasks).reduce((total, value) => total + value, 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Data-quality and integrity alerts" subtitle="Signals computed from stored records only.">
          <ul className="grid gap-2 p-3">
            {dataQualityAlerts.length === 0 ? (
              <li className="text-[0.8125rem] text-[#55606d]">No alerts. Every recorded value is traceable to a source.</li>
            ) : (
              dataQualityAlerts.map((alert, index) => (
                <li key={index} className={`note ${alert.tone === "ok" ? "note-ok" : alert.tone === "warn" ? "note-warn" : "note-fail"}`}>
                  {alert.text}
                </li>
              ))
            )}
            <li className="note">
              Audit events: <span className="mono">{audit.totalEvents}</span> · append-only enforced:{" "}
              <span className="mono">{String(audit.appendOnlyEnforced)}</span> · denials recorded:{" "}
              <span className="mono">{(audit.byOutcome.denied ?? 0).toString()}</span>
            </li>
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Recent documented sources"
          subtitle="Every imported record traces back to one of these."
          actions={
            <Link href="/participants/import" className="btn-quiet no-underline">
              import
            </Link>
          }
        >
          {sources.length === 0 ? (
            <p className="empty-state">No documented sources registered yet.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Origin</th>
                  <th>Received</th>
                  <th className="num">Answers</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <span title={source.reference}>{source.title}</span>
                      <span className="mono block text-[0.6875rem] text-[#55606d]">{source.reference}</span>
                    </td>
                    <td>
                      <Chip tone="neutral">{source.origin_type}</Chip>
                    </td>
                    <td className="mono">{formatDateTime(source.received_at)}</td>
                    <td className="num">{source.answer_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Recent audit events"
          subtitle="Immutable; update and delete are rejected by database triggers."
          actions={
            <Link href="/audit" className="btn-quiet no-underline">
              full log
            </Link>
          }
        >
          {recentAudit.length === 0 ? (
            <p className="empty-state">No audit events recorded yet.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {recentAudit.map((event) => (
                  <tr key={event.id}>
                    <td className="mono">{formatDateTime(event.occurred_at)}</td>
                    <td>{event.actor_label}</td>
                    <td className="mono">{event.action}</td>
                    <td>
                      <Chip tone={stateTone(event.outcome)}>{event.outcome}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
