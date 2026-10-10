import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "../../../../lib/services/session.ts";
import { taskDetail } from "../../../../lib/services/orchestration.ts";
import { Chip, Metric, Note, Panel, formatDateTime, stateTone } from "../../../../components/ui.tsx";

export const dynamic = "force-dynamic";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, actor } = await requireAuth();
  let detail;
  try {
    detail = taskDetail(db, id);
  } catch {
    notFound();
  }
  if (detail.task.organization_id !== actor.organizationId) {
    notFound();
  }

  const contract = detail.contract;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mono text-[0.75rem] text-[#55606d]">
            <Link href="/agents">Agents &amp; Tasks</Link> / {detail.task.id}
          </p>
          <h1 className="text-lg font-semibold tracking-tight">
            {detail.task.kind} · {detail.study.code}
          </h1>
          <p className="mt-0.5 text-[0.8125rem] text-[#55606d]">
            participant <span className="mono">{detail.pseudonym}</span> · created {formatDateTime(detail.task.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone={stateTone(detail.task.state)}>{detail.task.state}</Chip>
          <span className="mono text-[0.75rem] text-[#55606d]">
            attempts {detail.task.attempt_count}/{detail.task.max_attempts}
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Idempotency key" value={`${detail.task.idempotency_key.slice(0, 12)}…`} hint="duplicate delivery is rejected" />
        <Metric label="Contract hash" value={`${detail.task.contract_sha256.slice(0, 12)}…`} hint="tampering is detected before a run" />
        <Metric label="Attempts" value={detail.attempts.length} />
        <Metric label="Evidence records" value={detail.evidence.length} />
      </div>

      {detail.task.last_error ? <Note tone="fail">Last error: {detail.task.last_error}</Note> : null}
      {detail.task.approval_note ? <Note tone="ok">Approval note: {detail.task.approval_note}</Note> : null}

      <Panel title="Bounded task contract" subtitle="Exactly what the agent receives. Pseudonymous identifiers only; no identity data, no credentials.">
        <pre className="mono overflow-x-auto p-4 text-[0.75rem]">{JSON.stringify(contract, null, 2)}</pre>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Attempts" subtitle="Every run, its adapter and its retryability.">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Transition</th>
                  <th>Adapter</th>
                  <th>Started</th>
                  <th>Finished</th>
                  <th>Retryable</th>
                </tr>
              </thead>
              <tbody>
                {detail.attempts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-[#55606d]">
                      No attempt recorded yet.
                    </td>
                  </tr>
                ) : (
                  detail.attempts.map((attempt) => (
                    <tr key={String(attempt.id)}>
                      <td className="num">{String(attempt.attempt_number)}</td>
                      <td className="mono text-[0.75rem]">
                        {String(attempt.state_from)} → {String(attempt.state_to)}
                      </td>
                      <td className="mono">{String(attempt.adapter)}</td>
                      <td className="mono">{formatDateTime(attempt.started_at as string | null)}</td>
                      <td className="mono">{formatDateTime(attempt.finished_at as string | null)}</td>
                      <td>{attempt.retryable === null ? "—" : attempt.retryable === 1 ? "yes" : "no"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Execution evidence" subtitle="Content-hashed so it can be checked later; credentials are never recorded.">
          <div className="grid gap-2 p-4">
            {detail.evidence.length === 0 ? (
              <p className="text-[0.8125rem] text-[#55606d]">No evidence recorded yet.</p>
            ) : (
              detail.evidence.map((record) => (
                <div key={record.id} className="note">
                  <p className="mono text-[0.6875rem] text-[#55606d]">
                    {record.evidence_type} · {formatDateTime(record.recorded_at)} · sha256 {record.body_sha256.slice(0, 16)}…
                  </p>
                  <pre className="mono mt-1 overflow-x-auto text-[0.6875rem]">{record.body_json}</pre>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Audit trail for this task" subtitle="Append-only: state changes cannot be rewritten.">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>Severity</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {detail.audit.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-[#55606d]">
                    No audit events for this task.
                  </td>
                </tr>
              ) : (
                detail.audit.map((event) => (
                  <tr key={String(event.id)}>
                    <td className="mono">{formatDateTime(event.occurred_at as string)}</td>
                    <td>{String(event.actor_label)}</td>
                    <td className="mono">{String(event.action)}</td>
                    <td>
                      <Chip tone={stateTone(String(event.outcome))}>{String(event.outcome)}</Chip>
                    </td>
                    <td className="text-[0.75rem]">{String(event.severity)}</td>
                    <td className="mono max-w-[60ch] break-all text-[0.6875rem]">{String(event.detail_json)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
