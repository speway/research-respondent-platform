import Link from "next/link";
import { requireAuth } from "../../lib/services/session.ts";
import { listStudies } from "../../lib/repo/studies.ts";
import { getSegmentCohortPreview, getStudyCriteriaPreview } from "../../lib/services/cohorts.ts";
import { listSegments, listSegmentSnapshots } from "../../lib/repo/cohorts.ts";
import { createSegmentAction, deleteSegmentAction, snapshotSegmentAction } from "../actions/cohorts.ts";
import { ActionForm } from "../../components/action-form.tsx";
import { Chip, EmptyState, Metric, Note, Panel, formatDateTime } from "../../components/ui.tsx";
import { FACT_FIELD_CATALOG } from "../../lib/domain/cohort.ts";

export const dynamic = "force-dynamic";

export default async function CohortsPage({
  searchParams,
}: {
  searchParams: Promise<{ studyId?: string; segmentId?: string }>;
}) {
  const { studyId, segmentId } = await searchParams;
  const { db, actor } = await requireAuth();
  const studies = listStudies(db, actor.organizationId);
  const selectedStudyId = studyId ?? studies[0]?.id ?? null;
  const selectedStudy = studies.find((study) => study.id === selectedStudyId) ?? null;
  const segments = listSegments(db, actor.organizationId).filter((segment) =>
    selectedStudyId ? segment.study_id === selectedStudyId : true,
  );
  const selectedSegment = segmentId
    ? segments.find((segment) => segment.id === segmentId) ??
      listSegments(db, actor.organizationId).find((segment) => segment.id === segmentId) ??
      null
    : segments[0] ?? null;

  const preview = selectedSegment
    ? getSegmentCohortPreview(db, selectedSegment.id)
    : selectedStudyId
      ? getStudyCriteriaPreview(db, selectedStudyId)
      : null;
  const snapshots = selectedSegment ? listSegmentSnapshots(db, selectedSegment.id) : [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Cohorts</h1>
          <p className="mt-0.5 max-w-[90ch] text-[0.8125rem] text-[#55606d]">
            Dynamic filters over documented values. Every participant gets an explicit decision with the observed value,
            the expected value and the reason. Unknown data produces an <span className="mono">indeterminate</span> result
            and is never counted as included.
          </p>
        </div>
        <form method="get" className="flex items-end gap-2">
          <div>
            <label className="field-label" htmlFor="studyId">
              Study
            </label>
            <select id="studyId" name="studyId" className="select" defaultValue={selectedStudyId ?? ""}>
              {studies.map((study) => (
                <option key={study.id} value={study.id}>
                  {study.code} — {study.title}
                </option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit">
            Switch
          </button>
        </form>
      </div>

      {studies.length === 0 ? (
        <EmptyState>
          Create a <Link href="/studies">study</Link> first; cohorts are always scoped to a study.
        </EmptyState>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Saved cohorts" value={segments.length} />
        <Metric label="Denominator" value={preview?.denominator ?? 0} hint="participants considered" />
        <Metric label="Included" value={preview?.included ?? 0} tone="verified" />
        <Metric
          label="Indeterminate"
          value={preview?.indeterminate ?? 0}
          tone={(preview?.indeterminate ?? 0) > 0 ? "partial" : "neutral"}
          hint="unknown data - resolve before export"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.5fr]">
        <Panel
          title="Save a cohort"
          subtitle="Rules are JSON objects validated by the rule engine before they are stored."
        >
          <div className="grid gap-3 p-4">
            <Note>
              Available rule subjects and fields:
              <span className="mono block text-[0.6875rem]">
                {Object.entries(FACT_FIELD_CATALOG)
                  .map(([subject, descriptor]) => `${subject}: ${descriptor.fields.map((field) => field.field).join(", ")}`)
                  .join(" | ")}
              </span>
            </Note>
            <ActionForm action={createSegmentAction} submitLabel="Save cohort" hidden={{ studyId: selectedStudyId ?? "" }}>
              <div>
                <label className="field-label" htmlFor="name">
                  Cohort name
                </label>
                <input id="name" name="name" className="input" placeholder="Consented P-23 with tolerance data" required />
              </div>
              <div>
                <label className="field-label" htmlFor="description">
                  Description
                </label>
                <input id="description" name="description" className="input" />
              </div>
              <div>
                <label className="field-label" htmlFor="rulesJson">
                  Rules (JSON array)
                </label>
                <textarea
                  id="rulesJson"
                  name="rulesJson"
                  className="textarea mono"
                  rows={8}
                  defaultValue={JSON.stringify(
                    [
                      {
                        kind: "include",
                        label: "Active consent on file",
                        rule: { id: "consent", subject: "consent", operator: "consent_status", value: "granted" },
                      },
                      {
                        kind: "include",
                        label: "Has a tolerance-of-uncertainty score",
                        rule: {
                          id: "score",
                          subject: "scale_score",
                          operator: "is_present",
                          scaleCode: "TOTAL",
                        },
                      },
                    ],
                    null,
                    2,
                  )}
                />
              </div>
            </ActionForm>
          </div>
        </Panel>

        <Panel
          title="Saved cohorts"
          subtitle="Snapshots freeze the rule set and its outcome for later reference."
        >
          {segments.length === 0 ? (
            <EmptyState>No cohorts saved for this study yet.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Description</th>
                    <th className="num">Rules</th>
                    <th className="num">Snapshots</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {segments.map((segment) => (
                    <tr key={segment.id}>
                      <td>
                        <Link href={`/cohorts?studyId=${selectedStudyId ?? ""}&segmentId=${segment.id}`}>{segment.name}</Link>
                      </td>
                      <td className="text-[0.75rem] text-[#55606d]">{segment.description ?? "—"}</td>
                      <td className="num">{segment.rule_count}</td>
                      <td className="num">{segment.snapshot_count}</td>
                      <td className="mono">{formatDateTime(segment.created_at)}</td>
                      <td className="flex gap-1">
                        <ActionForm
                          action={snapshotSegmentAction}
                          submitLabel="Snapshot"
                          quiet
                          hidden={{ segmentId: segment.id }}
                          className="inline"
                        >
                          <span />
                        </ActionForm>
                        <ActionForm
                          action={deleteSegmentAction}
                          submitLabel="Delete"
                          quiet
                          confirm="Delete this cohort definition? Snapshots and audit events are removed with it; recorded responses are unaffected."
                          hidden={{ segmentId: segment.id }}
                          className="inline"
                        >
                          <span />
                        </ActionForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {preview ? (
        <Panel
          title={selectedSegment ? `Cohort preview: ${selectedSegment.name}` : "Study criteria preview"}
          subtitle="One row per participant with the full decision trace."
        >
          <div className="grid gap-3 p-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <Metric label="Denominator" value={preview.denominator} />
              <Metric label="Included" value={preview.included} tone="verified" />
              <Metric label="Excluded" value={preview.excluded} tone="blocked" />
              <Metric label="Indeterminate" value={preview.indeterminate} tone="partial" />
            </div>

            {preview.warnings.length > 0 ? (
              <ul className="grid gap-1">
                {preview.warnings.map((warning, index) => (
                  <li key={index} className={`note ${warning.severity === "fail" ? "note-fail" : "note-warn"}`}>
                    <span className="mono">{warning.code}</span>: {warning.message}
                  </li>
                ))}
              </ul>
            ) : null}

            {preview.ruleSummary.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th className="num">Include</th>
                      <th className="num">Exclude</th>
                      <th className="num">Indeterminate</th>
                      <th className="num">Not applicable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.ruleSummary.map((rule) => (
                      <tr key={rule.ruleId}>
                        <td className="text-[0.8125rem]">{rule.label || rule.ruleId}</td>
                        <td className="num">{rule.include}</td>
                        <td className="num">{rule.exclude}</td>
                        <td className="num">{rule.indeterminate}</td>
                        <td className="num">{rule.notApplicable}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {preview.missingnessSummary.length > 0 ? (
              <div>
                <p className="field-label">Missing-data summary driving indeterminate decisions</p>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th className="num">Missing</th>
                      <th className="num">Present</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.missingnessSummary.map((entry) => (
                      <tr key={entry.field}>
                        <td className="mono">{entry.field}</td>
                        <td className="num">{entry.missingCount}</td>
                        <td className="num">{entry.presentCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Participant</th>
                    <th>Decision</th>
                    <th>Trace</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.evaluations.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-[#55606d]">
                        No participants to evaluate.
                      </td>
                    </tr>
                  ) : (
                    preview.evaluations.slice(0, 100).map((evaluation) => (
                      <tr key={evaluation.participantId}>
                        <td className="mono">
                          <Link href={`/participants/${evaluation.participantId}`}>{evaluation.pseudonym}</Link>
                        </td>
                        <td>
                          <Chip
                            tone={
                              evaluation.decision === "included"
                                ? "verified"
                                : evaluation.decision === "excluded"
                                  ? "blocked"
                                  : "partial"
                            }
                          >
                            {evaluation.decision}
                          </Chip>
                        </td>
                        <td>
                          <ul className="grid gap-0.5 text-[0.75rem]">
                            {evaluation.traces.map((trace) => (
                              <li key={trace.ruleId}>
                                <Chip
                                  tone={
                                    trace.outcome === "include"
                                      ? "verified"
                                      : trace.outcome === "exclude"
                                        ? "blocked"
                                        : trace.outcome === "indeterminate"
                                          ? "partial"
                                          : "neutral"
                                  }
                                >
                                  {trace.outcome}
                                </Chip>{" "}
                                {trace.label || trace.ruleId}: {trace.explanation}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>
      ) : null}

      {selectedSegment ? (
        <Panel title="Snapshots" subtitle="A snapshot records the rule hash and the exact counts at evaluation time.">
          {snapshots.length === 0 ? (
            <EmptyState>No snapshot yet. Take one before exporting or assigning work.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="num">Revision</th>
                    <th>Evaluated</th>
                    <th className="num">Denominator</th>
                    <th className="num">Included</th>
                    <th className="num">Excluded</th>
                    <th className="num">Indeterminate</th>
                    <th>Rules hash</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((snapshot) => (
                    <tr key={snapshot.id}>
                      <td className="num">{snapshot.revision}</td>
                      <td className="mono">{formatDateTime(snapshot.evaluated_at)}</td>
                      <td className="num">{snapshot.denominator}</td>
                      <td className="num">{snapshot.included_count}</td>
                      <td className="num">{snapshot.excluded_count}</td>
                      <td className="num">{snapshot.indeterminate_count}</td>
                      <td className="mono text-[0.6875rem]">{snapshot.rules_sha256.slice(0, 16)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
