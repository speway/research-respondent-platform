import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "../../../../lib/services/session.ts";
import { getSessionDetail, buildScoringInput } from "../../../../lib/repo/assessments.ts";
import { scoreSessionAction } from "../../../actions/library.ts";
import { ActionForm } from "../../../../components/action-form.tsx";
import { Chip, Metric, Note, Panel, ValueOrMissing, formatDateTime, formatNumber } from "../../../../components/ui.tsx";
import { scoreSession } from "../../../../lib/domain/scoring.ts";

export const dynamic = "force-dynamic";

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, actor } = await requireAuth();
  const detail = getSessionDetail(db, id);
  if (!detail) {
    notFound();
  }
  const participantCheck = db
    .prepare("SELECT organization_id FROM participant WHERE id = ?")
    .get(detail.session.participant_id) as { organization_id: string } | undefined;
  if (participantCheck?.organization_id !== actor.organizationId) {
    notFound();
  }

  const answers = detail.answers;
  const missing = answers.filter((answer) => answer.is_missing === 1);
  const input = buildScoringInput(db, id);
  const dryRun = input.specs.length > 0 ? scoreSession({
    assessmentSessionId: id,
    instrumentVersionId: input.session.instrument_version_id,
    instrumentTitle: input.instrumentTitle,
    clinicalUsePermitted: input.clinicalUsePermitted,
    provisionalInstrument: input.provisionalInstrument,
    items: input.scorableItems,
    answers: input.scorableAnswers,
    scales: input.specs,
  }) : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mono text-[0.75rem] text-[#55606d]">
            <Link href={`/participants/${detail.session.participant_id}`}>{detail.pseudonym}</Link> / session{" "}
            {detail.session.timepoint_label}
          </p>
          <h1 className="text-lg font-semibold tracking-tight">
            {detail.instrument?.title ?? input.instrumentTitle}
            {detail.instrument ? <span className="mono text-[0.8125rem] text-[#55606d]"> v{detail.instrument.version_label}</span> : null}
          </h1>
          <p className="mt-0.5 text-[0.8125rem] text-[#55606d]">
            {detail.session.administration_mode} · language {detail.session.language} · completed{" "}
            {formatDateTime(detail.session.completed_at)}
          </p>
        </div>
        <ActionForm action={scoreSessionAction} submitLabel="Compute scores" quiet hidden={{ sessionId: id }} className="">
          <span className="sr-only">score</span>
        </ActionForm>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Recorded answers" value={answers.length - missing.length} tone="verified" />
        <Metric label="Documented missing" value={missing.length} tone={missing.length > 0 ? "partial" : "neutral"} />
        <Metric label="Instrument items" value={input.scorableItems.length} />
        <Metric label="Registered scales" value={input.specs.length} />
      </div>

      {input.specs.length === 0 ? (
        <Note tone="warn">
          No scoring algorithm is registered for this instrument version. Register scales and algorithms in the{" "}
          <Link href={`/library/versions/${detail.session.instrument_version_id}`}>Psychological Library</Link> before scoring.
          Nothing is computed from an unspecified rule.
        </Note>
      ) : null}

      <Panel
        title="Raw responses"
        subtitle="Verbatim values with their source locator. Missing stays missing; the platform never rewrites an observed answer."
      >
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Question (verbatim)</th>
                <th>Raw value</th>
                <th>Coded</th>
                <th>Status</th>
                <th>Collected</th>
                <th>Source locator</th>
              </tr>
            </thead>
            <tbody>
              {answers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-[#55606d]">
                    No responses recorded in this session.
                  </td>
                </tr>
              ) : (
                answers.map((answer) => (
                  <tr key={answer.id}>
                    <td className="mono">{answer.item_code}</td>
                    <td className="max-w-[42ch] text-[0.8125rem]">{answer.question_text}</td>
                    <td className="mono">{answer.raw_value_text === "" ? <ValueOrMissing value={null} /> : answer.raw_value_text}</td>
                    <td className="mono">
                      {answer.value_coded ?? (answer.value_numeric === null ? <ValueOrMissing value={null} /> : answer.value_numeric)}
                    </td>
                    <td>
                      {answer.is_missing === 1 ? (
                        <Chip tone="missing" title={answer.missing_reason ?? "missing"}>
                          missing: {answer.missing_reason}
                        </Chip>
                      ) : (
                        <Chip tone="verified">observed</Chip>
                      )}
                      {answer.reverse_scored === 1 ? <Chip tone="info">reverse-keyed</Chip> : null}
                    </td>
                    <td className="mono">{formatDateTime(answer.collected_at)}</td>
                    <td className="mono text-[0.6875rem]">{answer.source_locator}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Documented source" subtitle="Where this session's answers came from.">
        <div className="grid gap-2 p-4 text-[0.8125rem]">
          {detail.source ? (
            <>
              <p>
                <strong>{detail.source.title}</strong> · <Chip tone="neutral">{detail.source.origin_type}</Chip>
              </p>
              <p className="mono text-[0.75rem] text-[#55606d]">{detail.source.reference}</p>
              <p className="text-[0.75rem] text-[#55606d]">Collected: {formatDateTime(detail.source.collected_at)}</p>
              <p className="mono text-[0.6875rem] text-[#55606d]">Source id {detail.source.id}</p>
            </>
          ) : (
            <p className="text-[#98211f]">The session references a source that no longer exists. This must be investigated.</p>
          )}
        </div>
      </Panel>

      <Panel
        title="Scoring preview"
        subtitle="Deterministic dry run of the registered algorithms against the stored answers; nothing is written until you compute."
      >
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Scale</th>
                <th className="num">Raw</th>
                <th className="num">Transformed</th>
                <th className="num">SD</th>
                <th className="num">Percentile</th>
                <th>Band</th>
                <th>Computability</th>
                <th className="num">Used</th>
                <th className="num">Missing</th>
                <th>Algorithm</th>
                <th>Diagnostics</th>
              </tr>
            </thead>
            <tbody>
              {!dryRun || dryRun.scores.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-[#55606d]">
                    No scale scores can be derived with the currently registered algorithms.
                  </td>
                </tr>
              ) : (
                dryRun.scores.map((score) => (
                  <tr key={score.scaleCode}>
                    <td className="mono">{score.scaleCode}</td>
                    <td className="num">{score.rawScore === null ? <ValueOrMissing value={null} /> : formatNumber(score.rawScore)}</td>
                    <td className="num">
                      {score.transformedScore === null ? <ValueOrMissing value={null} /> : formatNumber(score.transformedScore)}
                    </td>
                    <td className="num">
                      {score.standardizedScore === null ? <ValueOrMissing value={null} /> : formatNumber(score.standardizedScore, 3)}
                    </td>
                    <td className="num">{score.percentile === null ? <ValueOrMissing value={null} /> : formatNumber(score.percentile, 1)}</td>
                    <td>{score.bandLabel ?? "—"}</td>
                    <td>
                      <Chip tone={score.computability === "computed" ? "verified" : "blocked"}>{score.computability}</Chip>
                      {score.methodologicallyProvisional ? <Chip tone="partial">provisional</Chip> : null}
                    </td>
                    <td className="num">{score.itemsUsed}</td>
                    <td className="num">{score.itemsMissing}</td>
                    <td className="mono text-[0.6875rem]">{score.algorithmVersion}</td>
                    <td>
                      <ul className="grid gap-0.5 text-[0.6875rem]">
                        {score.diagnostics.length === 0 ? (
                          <li>none</li>
                        ) : (
                          score.diagnostics.map((diagnostic, index) => (
                            <li key={index} className={diagnostic.severity === "fail" ? "text-[#98211f]" : "text-[#8a5309]"}>
                              {diagnostic.code}
                              {diagnostic.itemCode ? ` (${diagnostic.itemCode})` : ""}: {diagnostic.message}
                            </li>
                          ))
                        )}
                        {score.notComputableReason ? <li className="text-[#98211f]">reason: {score.notComputableReason}</li> : null}
                      </ul>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {dryRun ? (
          <div className="grid gap-2 border-t border-[#dfe3e8] p-4 text-[0.75rem] text-[#55606d]">
            <p>
              Coverage: {dryRun.coverage.answeredItems} of {dryRun.coverage.totalItems} items answered (
              {formatNumber(dryRun.coverage.completenessRatio, 3)}); missing by reason:{" "}
              {Object.entries(dryRun.coverage.missingByReason)
                .map(([reason, count]) => `${reason}=${count}`)
                .join(", ") || "none"}
              .
            </p>
            <p>
              Item-level contributions (which items fed each score, and whether they were reversed) are recorded with the
              persisted score so a result can always be re-derived from its inputs.
            </p>
          </div>
        ) : null}
      </Panel>

      <Panel title="Persisted score rows (including superseded)" subtitle="History is preserved: a re-score supersedes, never overwrites.">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Scale</th>
                <th className="num">Raw</th>
                <th>Computability</th>
                <th>Algorithm</th>
                <th>Computed</th>
                <th>Superseded by</th>
              </tr>
            </thead>
            <tbody>
              {detail.scores.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-[#55606d]">
                    Nothing persisted yet.
                  </td>
                </tr>
              ) : (
                detail.scores.map((score) => (
                  <tr key={score.id}>
                    <td className="mono">{score.scale_code}</td>
                    <td className="num">{score.raw_score === null ? <ValueOrMissing value={null} /> : formatNumber(score.raw_score)}</td>
                    <td>
                      <Chip tone={score.computability === "computed" ? "verified" : "blocked"}>{score.computability}</Chip>
                      {score.is_provisional === 1 ? <Chip tone="partial">provisional</Chip> : null}
                    </td>
                    <td className="mono text-[0.6875rem]">{score.algorithm_version}</td>
                    <td className="mono">{formatDateTime(score.computed_at)}</td>
                    <td className="mono text-[0.6875rem]">{score.superseded_by_id ?? "—"}</td>
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
