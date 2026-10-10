import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "../../../lib/services/session.ts";
import { getParticipantProfile, getPrivateIdentity } from "../../../lib/repo/participants.ts";
import { listStudies } from "../../../lib/repo/studies.ts";
import { PERMISSIONS, actorHasPermission } from "../../../lib/services/authz.ts";
import {
  addAnnotationAction,
  recordConsentAction,
  updateAttributesAction,
  upsertIdentityAction,
} from "../../actions/participants.ts";
import { ActionForm } from "../../../components/action-form.tsx";
import { Chip, Metric, Note, Panel, ValueOrMissing, formatDateTime, formatNumber } from "../../../components/ui.tsx";

export const dynamic = "force-dynamic";

export default async function ParticipantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, actor } = await requireAuth();
  const profile = getParticipantProfile(db, id);
  if (!profile) {
    notFound();
  }
  const participant = profile.participant;
  if (participant.organization_id !== actor.organizationId) {
    notFound();
  }

  const canReadIdentity = actorHasPermission(actor, PERMISSIONS.identityRead);
  const identity = canReadIdentity ? getPrivateIdentity(db, id) : undefined;
  const studies = listStudies(db, actor.organizationId);
  const missingness = Object.entries(profile.missingness);
  const activeConsent = profile.consents.find((consent) => consent.status === "granted" && consent.withdrawn_at === null);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mono text-[0.75rem] text-[#55606d]">
            <Link href="/participants">Participants</Link> / {participant.pseudonym}
          </p>
          <h1 className="text-lg font-semibold tracking-tight">{participant.pseudonym}</h1>
          <p className="mt-0.5 text-[0.8125rem] text-[#55606d]">
            Created {formatDateTime(participant.created_at)} · {profile.sessions.length} assessment session(s) ·{" "}
            {profile.scores.length} derived score row(s)
          </p>
        </div>
        <Chip tone={activeConsent ? "verified" : "blocked"}>
          {activeConsent ? `consent ${activeConsent.consent_version}` : "no active consent"}
        </Chip>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Sessions" value={profile.sessions.length} />
        <Metric
          label="Recorded answers"
          value={profile.sessions.reduce((total, session) => total + session.answered, 0)}
          tone="verified"
        />
        <Metric
          label="Missing answers"
          value={profile.sessions.reduce((total, session) => total + session.missing, 0)}
          tone={profile.sessions.some((session) => session.missing > 0) ? "partial" : "neutral"}
        />
        <Metric
          label="Undocumented attributes"
          value={missingness.length}
          hint="stored as missing, never guessed"
          tone={missingness.length > 0 ? "partial" : "verified"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Analytic attributes" subtitle="Only values present in the documented source are stored.">
          <div className="grid gap-3 p-4">
            <ActionForm action={updateAttributesAction} submitLabel="Save attributes" hidden={{ participantId: id }}>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="age_at_enrolment">
                    Age at enrolment
                  </label>
                  <input
                    id="age_at_enrolment"
                    name="age_at_enrolment"
                    type="number"
                    className="input"
                    defaultValue={participant.age_at_enrolment ?? ""}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="birth_year">
                    Birth year
                  </label>
                  <input id="birth_year" name="birth_year" type="number" className="input" defaultValue={participant.birth_year ?? ""} />
                </div>
                <div>
                  <label className="field-label" htmlFor="self_described_gender">
                    Self-described gender
                  </label>
                  <input
                    id="self_described_gender"
                    name="self_described_gender"
                    className="input"
                    defaultValue={participant.self_described_gender ?? ""}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="preferred_language">
                    Preferred language
                  </label>
                  <input
                    id="preferred_language"
                    name="preferred_language"
                    className="input"
                    defaultValue={participant.preferred_language ?? ""}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="education_level">
                    Education level
                  </label>
                  <input id="education_level" name="education_level" className="input" defaultValue={participant.education_level ?? ""} />
                </div>
                <div>
                  <label className="field-label" htmlFor="region">
                    Region
                  </label>
                  <input id="region" name="region" className="input" defaultValue={participant.region ?? ""} />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="recruitment_channel">
                    Recruitment channel
                  </label>
                  <input
                    id="recruitment_channel"
                    name="recruitment_channel"
                    className="input"
                    defaultValue={participant.recruitment_channel ?? ""}
                  />
                </div>
              </div>
            </ActionForm>
            {missingness.length > 0 ? (
              <div className="note note-warn">
                Not documented in the source:{" "}
                {missingness.map(([field, reason]) => `${field} (${reason})`).join(", ")}. Leave these empty; the platform
                never imputes them.
              </div>
            ) : (
              <div className="note note-ok">Every catalogued attribute has a documented value.</div>
            )}
          </div>
        </Panel>

        <Panel title="Consent history" subtitle="Consent is versioned; withdrawal blocks exports and any external submission.">
          <div className="grid gap-3 p-4">
            <ActionForm action={recordConsentAction} submitLabel="Record consent event" hidden={{ participantId: id }}>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="version">
                    Consent version
                  </label>
                  <input id="version" name="version" className="input" placeholder="consent-v2 2025-10" required />
                </div>
                <div>
                  <label className="field-label" htmlFor="status">
                    Status
                  </label>
                  <select id="status" name="status" className="select" defaultValue="granted">
                    <option value="granted">granted</option>
                    <option value="declined">declined</option>
                    <option value="withdrawn">withdrawn</option>
                    <option value="expired">expired</option>
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="basis">
                    Basis
                  </label>
                  <select id="basis" name="basis" className="select" defaultValue="written_signed">
                    {["written_signed", "digital_form", "verbal_witnessed", "guardian_proxy", "institutional_blanket"].map(
                      (basis) => (
                        <option key={basis} value={basis}>
                          {basis}
                        </option>
                      ),
                    )}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="studyId">
                    Study scope
                  </label>
                  <select id="studyId" name="studyId" className="select">
                    <option value="">Organization-wide</option>
                    {studies.map((study) => (
                      <option key={study.id} value={study.id}>
                        {study.code}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="note">
                    Evidence description
                  </label>
                  <input
                    id="note"
                    name="note"
                    className="input"
                    placeholder="Signed form filed 2025-10-12, archive box 4, project folder P-23"
                    required
                  />
                </div>
              </div>
            </ActionForm>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Basis</th>
                    <th>Scope</th>
                    <th>Granted</th>
                    <th>Withdrawn</th>
                    <th>Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.consents.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-[#55606d]">
                        No consent record. This participant cannot be enrolled, exported or assigned a form task.
                      </td>
                    </tr>
                  ) : (
                    profile.consents.map((consent) => (
                      <tr key={consent.id}>
                        <td className="mono">{consent.consent_version}</td>
                        <td>
                          <Chip tone={consent.status === "granted" ? "verified" : "blocked"}>{consent.status}</Chip>
                        </td>
                        <td className="text-[0.75rem]">{consent.basis}</td>
                        <td className="text-[0.75rem]">
                          {consent.study_id ? (
                            <span className="mono">{studies.find((study) => study.id === consent.study_id)?.code ?? consent.study_id}</span>
                          ) : (
                            "organization-wide"
                          )}
                        </td>
                        <td className="mono">{formatDateTime(consent.granted_at)}</td>
                        <td className="mono">{formatDateTime(consent.withdrawn_at)}</td>
                        <td className="mono">{formatDateTime(consent.recorded_at)}</td>
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
        title="Restricted identity record"
        subtitle="Stored in a separate table; never included in analytic exports; access is a separately granted permission."
      >
        <div className="p-4">
          {!canReadIdentity ? (
            <Note tone="warn">
              Your role set does not include identity:read. Identity data exists only for participants whose records include
              it, and reading it requires an explicit access grant recorded by a data steward.
            </Note>
          ) : identity ? (
            <div className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric label="Full name" value={identity.full_name ?? "—"} />
                <Metric label="Contact e-mail" value={identity.contact_email ?? "—"} />
                <Metric label="Phone" value={identity.contact_phone ?? "—"} />
                <Metric label="Retention until" value={identity.retention_until ?? "not set"} />
              </div>
              <Note>Lawful basis: {identity.lawful_basis}</Note>
            </div>
          ) : (
            <Note>No identity data stored for this participant.</Note>
          )}
          {canReadIdentity || actorHasPermission(actor, PERMISSIONS.identityWrite) ? (
            <div className="mt-3">
              <ActionForm action={upsertIdentityAction} submitLabel="Save identity record" hidden={{ participantId: id }}>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="field-label" htmlFor="fullName">
                      Full name
                    </label>
                    <input id="fullName" name="fullName" className="input" autoComplete="off" />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="contactEmail">
                      Contact e-mail
                    </label>
                    <input id="contactEmail" name="contactEmail" type="email" className="input" autoComplete="off" />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="contactPhone">
                      Phone
                    </label>
                    <input id="contactPhone" name="contactPhone" className="input" autoComplete="off" />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="retentionUntil">
                      Retention until
                    </label>
                    <input id="retentionUntil" name="retentionUntil" type="date" className="input" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="field-label" htmlFor="lawfulBasis">
                      Lawful basis (required)
                    </label>
                    <input id="lawfulBasis" name="lawfulBasis" className="input" required />
                  </div>
                </div>
              </ActionForm>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Response history" subtitle="One row per documented assessment session; values are never edited in place.">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Instrument</th>
                <th>Timepoint</th>
                <th>Completed</th>
                <th>Documented source</th>
                <th className="num">Answered</th>
                <th className="num">Missing</th>
              </tr>
            </thead>
            <tbody>
              {profile.sessions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-[#55606d]">
                    No assessment sessions. Import a documented source to record responses.
                  </td>
                </tr>
              ) : (
                profile.sessions.map((session) => (
                  <tr key={session.sessionId}>
                    <td className="mono">
                      <Link href={`/participants/sessions/${session.sessionId}`}>{session.sessionId.slice(0, 12)}…</Link>
                    </td>
                    <td>
                      {session.instrumentTitle}
                      {session.instrumentAbbreviation ? <span className="mono"> ({session.instrumentAbbreviation})</span> : null}
                    </td>
                    <td className="mono">{session.timepointLabel}</td>
                    <td className="mono">{formatDateTime(session.completedAt)}</td>
                    <td className="text-[0.75rem]">
                      {session.documentedSourceTitle}
                      <span className="mono block text-[0.6875rem] text-[#55606d]">{session.documentedSourceId}</span>
                    </td>
                    <td className="num">{session.answered}</td>
                    <td className="num">{session.missing}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Derived scores" subtitle="Each row records the algorithm version, the items used and whether it is provisional.">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Scale</th>
                <th className="num">Raw</th>
                <th className="num">Transformed</th>
                <th>Computability</th>
                <th className="num">Items used</th>
                <th className="num">Items missing</th>
                <th>Algorithm</th>
                <th>Computed</th>
              </tr>
            </thead>
            <tbody>
              {profile.scores.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-[#55606d]">
                    No derived scores yet. Open a session and run the registered scoring algorithms.
                  </td>
                </tr>
              ) : (
                profile.scores.map((score) => (
                  <tr key={score.scoreId}>
                    <td>
                      {score.scaleTitle}
                      <span className="mono block text-[0.6875rem] text-[#55606d]">{score.scaleCode}</span>
                    </td>
                    <td className="num">{score.rawScore === null ? <ValueOrMissing value={null} /> : formatNumber(score.rawScore)}</td>
                    <td className="num">
                      {score.transformedScore === null ? <ValueOrMissing value={null} /> : formatNumber(score.transformedScore)}
                    </td>
                    <td>
                      <Chip tone={score.computability === "computed" ? "verified" : "blocked"}>{score.computability}</Chip>
                      {score.supersededById ? <Chip tone="missing">superseded</Chip> : null}
                    </td>
                    <td className="num">{score.itemsUsed}</td>
                    <td className="num">{score.itemsMissing}</td>
                    <td className="mono text-[0.6875rem]">{score.algorithmVersion}</td>
                    <td className="mono">{formatDateTime(score.computedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Evidence chain" subtitle="Every record links back to a registered documented source.">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Origin</th>
                  <th>Reference</th>
                  <th>Locator</th>
                </tr>
              </thead>
              <tbody>
                {profile.evidence.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-[#55606d]">
                      No evidence links recorded.
                    </td>
                  </tr>
                ) : (
                  profile.evidence.map((evidence, index) => (
                    <tr key={`${evidence.sourceId}-${index}`}>
                      <td>{evidence.title}</td>
                      <td>
                        <Chip tone="neutral">{evidence.originType}</Chip>
                      </td>
                      <td className="mono text-[0.6875rem]">{evidence.reference}</td>
                      <td className="mono text-[0.6875rem]">{evidence.locator ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Interpretation annotations" subtitle="Assessor notes, hypotheses and limitations are stored separately from raw data.">
          <div className="grid gap-3 p-4">
            <ActionForm action={addAnnotationAction} submitLabel="Add annotation" hidden={{ participantId: id }}>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="annotationType">
                    Type
                  </label>
                  <select id="annotationType" name="annotationType" className="select" defaultValue="assessor_note">
                    {["assessor_note", "hypothesis", "limitation", "norm_caution", "clinical_flag", "follow_up_required"].map(
                      (type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ),
                    )}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="confidence">
                    Confidence
                  </label>
                  <select id="confidence" name="confidence" className="select" defaultValue="">
                    <option value="">unspecified</option>
                    <option value="low">low</option>
                    <option value="moderate">moderate</option>
                    <option value="high">high</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="body">
                    Text
                  </label>
                  <textarea id="body" name="body" className="textarea" required />
                </div>
              </div>
            </ActionForm>
            <ul className="grid gap-2">
              {profile.annotations.length === 0 ? (
                <li className="text-[0.8125rem] text-[#55606d]">No annotations recorded.</li>
              ) : (
                profile.annotations.map((annotation) => (
                  <li key={annotation.id} className="note">
                    <span className="mono text-[0.6875rem] text-[#55606d]">
                      {annotation.type} · {formatDateTime(annotation.createdAt)}
                      {annotation.confidence ? ` · confidence ${annotation.confidence}` : ""}
                    </span>
                    <p className="mt-1">{annotation.body}</p>
                  </li>
                ))
              )}
            </ul>
          </div>
        </Panel>
      </div>
    </div>
  );
}
