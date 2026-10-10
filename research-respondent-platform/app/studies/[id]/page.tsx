import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "../../../lib/services/session.ts";
import {
  getStudy,
  listCriteria,
  listProtocolVersions,
  listStudyParticipants,
  studyOverviewCounts,
} from "../../../lib/repo/studies.ts";
import { getStudyCohortPreview } from "../../../lib/services/cohorts.ts";
import {
  createCriterionAction,
  createProtocolAction,
  deleteCriterionAction,
  enrolParticipantAction,
  setEnrolmentStatusAction,
  updateStudyAction,
} from "../../actions/studies.ts";
import { ActionForm } from "../../../components/action-form.tsx";
import { Chip, Metric, Note, Panel, ValueOrMissing, formatDateTime, formatNumber, stateTone } from "../../../components/ui.tsx";
import { listParticipants } from "../../../lib/repo/participants.ts";
import { FACT_FIELD_CATALOG } from "../../../lib/domain/cohort.ts";

export const dynamic = "force-dynamic";

export default async function StudyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, actor } = await requireAuth();
  const study = getStudy(db, id);
  if (!study || study.organization_id !== actor.organizationId) {
    notFound();
  }

  const protocols = listProtocolVersions(db, id);
  const criteria = listCriteria(db, id);
  const enrolments = listStudyParticipants(db, id);
  const counts = studyOverviewCounts(db, id);
  const preview = getStudyCohortPreview(db, id, actor);
  const allParticipants = listParticipants(db, actor.organizationId, { limit: 300 });
  const enrolledIds = new Set(enrolments.map((row) => row.participant_id));
  const sessionRows = db
    .prepare(
      `SELECT s.id, s.timepoint_label, s.completed_at, p.pseudonym, i.title AS instrument_title,
              (SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.is_missing = 0) AS answered,
              (SELECT COUNT(*) FROM observed_answer oa WHERE oa.assessment_session_id = s.id AND oa.is_missing = 1) AS missing
       FROM assessment_session s
       JOIN participant p ON p.id = s.participant_id
       JOIN instrument_version iv ON iv.id = s.instrument_version_id
       JOIN instrument i ON i.id = iv.instrument_id
       WHERE s.study_id = ? ORDER BY s.created_at DESC LIMIT 100`,
    )
    .all(id) as Array<{
    id: string;
    timepoint_label: string;
    completed_at: string | null;
    pseudonym: string;
    instrument_title: string;
    answered: number;
    missing: number;
  }>;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mono text-[0.75rem] text-[#55606d]">{study.code}</p>
          <h1 className="text-lg font-semibold tracking-tight">{study.title}</h1>
          <p className="mt-1 max-w-[90ch] text-[0.8125rem] text-[#55606d]">{study.research_question}</p>
        </div>
        <Chip tone={stateTone(study.status)}>{study.status}</Chip>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Enrolled" value={counts.participants} />
        <Metric label="Sessions" value={counts.sessions} />
        <Metric label="Answers" value={counts.answers} />
        <Metric label="Missing" value={counts.missingAnswers} tone={counts.missingAnswers > 0 ? "partial" : "neutral"} />
        <Metric label="Scores" value={counts.computedScores} hint={`${counts.scores} rows`} />
        <Metric
          label="Consents granted"
          value={counts.consents.granted ?? 0}
          tone={(counts.consents.granted ?? 0) > 0 ? "verified" : "missing"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Study settings" subtitle="Status changes are audited with the previous value.">
          <div className="p-4">
            <ActionForm action={updateStudyAction} submitLabel="Save study" hidden={{ studyId: id }} className="grid gap-3">
              <div>
                <label className="field-label" htmlFor="title">
                  Title
                </label>
                <input id="title" name="title" className="input" defaultValue={study.title} required />
              </div>
              <div>
                <label className="field-label" htmlFor="researchQuestion">
                  Research question
                </label>
                <textarea
                  id="researchQuestion"
                  name="researchQuestion"
                  className="textarea"
                  defaultValue={study.research_question}
                  required
                />
              </div>
              <div>
                <label className="field-label" htmlFor="status">
                  Status
                </label>
                <select id="status" name="status" className="select" defaultValue={study.status}>
                  {["draft", "active", "paused", "closed", "archived"].map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
                <p className="hint">Only an active study should collect new data.</p>
              </div>
            </ActionForm>
          </div>
        </Panel>

        <Panel
          title="Protocol versions"
          subtitle="Each version is preserved; nothing is edited in place."
        >
          <div className="grid gap-3 p-4">
            <ActionForm action={createProtocolAction} submitLabel="Record new protocol version" hidden={{ studyId: id }} className="grid gap-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="versionLabel">
                    Version label
                  </label>
                  <input id="versionLabel" name="versionLabel" className="input" placeholder="1.0" required />
                </div>
                <div>
                  <label className="field-label" htmlFor="ethicalApproval">
                    Ethical approval reference
                  </label>
                  <input id="ethicalApproval" name="ethicalApproval" className="input" placeholder="IRB / ethics file id" />
                </div>
              </div>
              <div>
                <label className="field-label" htmlFor="designSummary">
                  Design summary
                </label>
                <textarea id="designSummary" name="designSummary" className="textarea" />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="inclusionCriteria">
                    Inclusion criteria (narrative)
                  </label>
                  <textarea id="inclusionCriteria" name="inclusionCriteria" className="textarea" />
                </div>
                <div>
                  <label className="field-label" htmlFor="exclusionCriteria">
                    Exclusion criteria (narrative)
                  </label>
                  <textarea id="exclusionCriteria" name="exclusionCriteria" className="textarea" />
                </div>
              </div>
            </ActionForm>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Effective from</th>
                    <th>Supersedes</th>
                    <th>Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {protocols.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-[#55606d]">
                        No protocol version recorded yet.
                      </td>
                    </tr>
                  ) : (
                    protocols.map((protocol) => (
                      <tr key={protocol.id}>
                        <td className="mono">{protocol.version_label}</td>
                        <td className="mono">{formatDateTime(protocol.effective_from)}</td>
                        <td className="mono">
                          <ValueOrMissing value={protocol.supersedes_id} reason="first protocol version" />
                        </td>
                        <td>{protocol.ethical_approval ?? <ValueOrMissing value={null} />}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        title="Recruitment criteria"
        subtitle="Machine-readable rules; each rule explains its own decision for every participant."
      >
        <div className="grid gap-3 p-4">
          <Note>
            Supported subjects:{" "}
            {Object.entries(FACT_FIELD_CATALOG)
              .map(([subject, descriptor]) => `${subject} (${descriptor.fields.map((field) => field.field).join(", ")})`)
              .join(" · ")}
          </Note>
          <ActionForm action={createCriterionAction} submitLabel="Add criterion" hidden={{ studyId: id }} className="grid gap-3">
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="field-label" htmlFor="kind">
                  Kind
                </label>
                <select id="kind" name="kind" className="select" defaultValue="inclusion">
                  <option value="inclusion">inclusion</option>
                  <option value="exclusion">exclusion</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="field-label" htmlFor="label">
                  Label shown in explanations
                </label>
                <input id="label" name="label" className="input" placeholder="Active consent on file" required />
              </div>
            </div>
            <div>
              <label className="field-label" htmlFor="ruleJson">
                Rule (JSON)
              </label>
              <textarea
                id="ruleJson"
                name="ruleJson"
                className="textarea mono"
                defaultValue={'{"id":"consent","subject":"consent","operator":"consent_status","value":"granted"}'}
                required
              />
            </div>
            <div>
              <label className="field-label" htmlFor="rationale">
                Methodological rationale (optional)
              </label>
              <input id="rationale" name="rationale" className="input" />
            </div>
          </ActionForm>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Label</th>
                  <th>Rule</th>
                  <th>Rationale</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {criteria.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-[#55606d]">
                      No criteria defined. Cohorts will include every participant.
                    </td>
                  </tr>
                ) : (
                  criteria.map((criterion) => (
                    <tr key={criterion.id}>
                      <td>
                        <Chip tone={criterion.kind === "inclusion" ? "info" : "blocked"}>{criterion.kind}</Chip>
                      </td>
                      <td>{criterion.label}</td>
                      <td className="mono max-w-[46ch] break-all text-[0.75rem]">{criterion.rule_json}</td>
                      <td className="text-[0.75rem] text-[#55606d]">{criterion.rationale ?? "—"}</td>
                      <td>
                        <ActionForm
                          action={deleteCriterionAction}
                          submitLabel="Remove"
                          quiet
                          confirm="Remove this criterion? The audit log keeps the record of the change."
                          hidden={{ studyId: id, criterionId: criterion.id }}
                          className=""
                        >
                          <span />
                        </ActionForm>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>

      <Panel
        title="Eligibility preview"
        subtitle="Evaluated against the criteria above; unknown data yields an indeterminate decision, never a silent pass."
        actions={
          <Link href={`/cohorts?studyId=${id}`} className="btn-quiet no-underline">
            cohort builder
          </Link>
        }
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
                  {warning.code}: {warning.message}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Participant</th>
                  <th>Decision</th>
                  <th>Rule trace</th>
                </tr>
              </thead>
              <tbody>
                {preview.evaluations.slice(0, 25).map((evaluation) => (
                  <tr key={evaluation.participantId}>
                    <td className="mono">{evaluation.pseudonym}</td>
                    <td>
                      <Chip tone={evaluation.decision === "included" ? "verified" : evaluation.decision === "excluded" ? "blocked" : "partial"}>
                        {evaluation.decision}
                      </Chip>
                    </td>
                    <td>
                      <ul className="grid gap-0.5 text-[0.75rem]">
                        {evaluation.traces.map((trace) => (
                          <li key={trace.ruleId}>
                            <span className="mono">{trace.outcome}</span> · {trace.label || trace.ruleId}: {trace.explanation}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
                {preview.evaluations.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-[#55606d]">
                      No participants to evaluate yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title={`Study participants (${enrolments.length})`} subtitle="Enrolment requires a granted consent record.">
          <div className="grid gap-3 p-4">
            <ActionForm action={enrolParticipantAction} submitLabel="Enrol participant" hidden={{ studyId: id }} className="grid gap-3 md:grid-cols-[2fr_auto]">
              <div>
                <label className="field-label" htmlFor="participantId">
                  Participant
                </label>
                <select id="participantId" name="participantId" className="select" required>
                  <option value="">Select a participant not yet enrolled…</option>
                  {allParticipants
                    .filter((participant) => !enrolledIds.has(participant.id))
                    .map((participant) => (
                      <option key={participant.id} value={participant.id}>
                        {participant.pseudonym} · consent: {participant.consent_status ?? "none"} · sessions: {participant.session_count}
                      </option>
                    ))}
                </select>
              </div>
            </ActionForm>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Pseudonym</th>
                    <th>Status</th>
                    <th>Enrolled</th>
                    <th>Source</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {enrolments.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-[#55606d]">
                        Nobody enrolled yet.
                      </td>
                    </tr>
                  ) : (
                    enrolments.map((enrolment) => (
                      <tr key={enrolment.id}>
                        <td className="mono">
                          <Link href={`/participants/${enrolment.participant_id}`}>{enrolment.pseudonym}</Link>
                        </td>
                        <td>
                          <Chip tone={stateTone(enrolment.status)}>{enrolment.status}</Chip>
                        </td>
                        <td className="mono">{formatDateTime(enrolment.enrolled_at)}</td>
                        <td className="text-[0.75rem] text-[#55606d]">{enrolment.enrolment_source}</td>
                        <td>
                          <ActionForm
                            action={setEnrolmentStatusAction}
                            submitLabel="Set"
                            quiet
                            hidden={{ studyId: id, participantId: enrolment.participant_id }}
                            className="flex items-center gap-1"
                          >
                            <select name="status" className="select" defaultValue={enrolment.status}>
                              {["invited", "enrolled", "active", "completed", "withdrawn", "excluded"].map((status) => (
                                <option key={status} value={status}>
                                  {status}
                                </option>
                              ))}
                            </select>
                          </ActionForm>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>

        <Panel title={`Assessment sessions (${sessionRows.length})`} subtitle="Recorded answers per documented session.">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Participant</th>
                  <th>Instrument</th>
                  <th>Timepoint</th>
                  <th>Completed</th>
                  <th className="num">Answered</th>
                  <th className="num">Missing</th>
                </tr>
              </thead>
              <tbody>
                {sessionRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-[#55606d]">
                      No assessment sessions recorded for this study.
                    </td>
                  </tr>
                ) : (
                  sessionRows.map((session) => (
                    <tr key={session.id}>
                      <td className="mono">
                        <Link href={`/participants/sessions/${session.id}`}>{session.pseudonym}</Link>
                      </td>
                      <td>{session.instrument_title}</td>
                      <td className="mono">{session.timepoint_label}</td>
                      <td className="mono">{formatDateTime(session.completed_at)}</td>
                      <td className="num">{session.answered}</td>
                      <td className="num">{session.missing}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel title="Coverage" subtitle="Completeness is reported, never improved.">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Metric
            label="Answer completeness"
            value={counts.answers > 0 ? formatNumber(1 - counts.missingAnswers / counts.answers, 3) : "—"}
            hint="1.000 = every administered item recorded"
          />
          <Metric
            label="Scores computable"
            value={counts.scores > 0 ? formatNumber(counts.computedScores / counts.scores, 3) : "—"}
            hint="share of score rows with computability = computed"
          />
          <Metric label="Distinct instruments" value={new Set(sessionRows.map((row) => row.instrument_title)).size} />
        </div>
      </Panel>
    </div>
  );
}
