import Link from "next/link";
import { requireAuth } from "../../../lib/services/session.ts";
import { listStudies } from "../../../lib/repo/studies.ts";
import { ActionForm } from "../../../components/action-form.tsx";
import { Note, Panel } from "../../../components/ui.tsx";
import { createParticipantAction } from "../../actions/participants.ts";

export const dynamic = "force-dynamic";

const ORIGIN_TYPES = [
  "paper_form",
  "google_form_export",
  "spreadsheet",
  "manual_entry_signed",
  "interview_transcript",
  "observation_log",
  "spss_dataset",
  "csv_export",
  "instrument_report",
  "external_api",
] as const;

export default async function NewParticipantPage() {
  const { db, actor } = await requireAuth();
  const studies = listStudies(db, actor.organizationId);

  return (
    <div className="grid gap-4">
      <div>
        <p className="mono text-[0.75rem] text-[#55606d]">
          <Link href="/participants">Participants</Link> / new
        </p>
        <h1 className="text-lg font-semibold tracking-tight">Create participant record</h1>
        <p className="mt-0.5 max-w-[85ch] text-[0.8125rem] text-[#55606d]">
          A participant record is created only together with a documented source and a consent record. Leave any field the
          source does not contain empty: it will be stored as explicitly missing rather than guessed.
        </p>
      </div>

      <Note tone="warn">
        This form creates the participant registry entry only. Questionnaire responses are recorded separately through a
        documented import (&quot;Import documented source&quot;), so every answer keeps its original locator and timestamp.
      </Note>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Participant record" subtitle="Pseudonym is generated from the prefix and existing records.">
          <div className="p-4">
            <ActionForm action={createParticipantAction} submitLabel="Create participant" resetOnSuccess>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="pseudonymPrefix">
                    Pseudonym prefix
                  </label>
                  <input id="pseudonymPrefix" name="pseudonymPrefix" className="input" defaultValue="P" required />
                  <p className="hint">Produces e.g. P-001, P-002 in this organization.</p>
                </div>
                <div>
                  <label className="field-label" htmlFor="studyId">
                    Study (optional)
                  </label>
                  <select id="studyId" name="studyId" className="select">
                    <option value="">No study linkage</option>
                    {studies.map((study) => (
                      <option key={study.id} value={study.id}>
                        {study.code} — {study.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <fieldset className="grid gap-3 md:grid-cols-2">
                <legend className="field-label">Documented attributes (leave empty when not documented)</legend>
                <div>
                  <label className="field-label" htmlFor="age_at_enrolment">
                    Age at enrolment
                  </label>
                  <input id="age_at_enrolment" name="age_at_enrolment" type="number" min={10} max={120} className="input" />
                </div>
                <div>
                  <label className="field-label" htmlFor="birth_year">
                    Birth year
                  </label>
                  <input id="birth_year" name="birth_year" type="number" min={1900} max={2100} className="input" />
                </div>
                <div>
                  <label className="field-label" htmlFor="self_described_gender">
                    Self-described gender
                  </label>
                  <input id="self_described_gender" name="self_described_gender" className="input" />
                </div>
                <div>
                  <label className="field-label" htmlFor="preferred_language">
                    Preferred language
                  </label>
                  <input id="preferred_language" name="preferred_language" className="input" placeholder="ru" />
                </div>
                <div>
                  <label className="field-label" htmlFor="education_level">
                    Education level
                  </label>
                  <input id="education_level" name="education_level" className="input" />
                </div>
                <div>
                  <label className="field-label" htmlFor="region">
                    Region
                  </label>
                  <input id="region" name="region" className="input" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="recruitment_channel">
                    Recruitment channel
                  </label>
                  <input id="recruitment_channel" name="recruitment_channel" className="input" placeholder="course cohort P-23" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="notes">
                    Registry note
                  </label>
                  <textarea id="notes" name="notes" className="textarea" />
                </div>
              </fieldset>

              <fieldset className="grid gap-3 md:grid-cols-2">
                <legend className="field-label">Provenance of this record</legend>
                <div>
                  <label className="field-label" htmlFor="sourceOrigin">
                    Source origin type
                  </label>
                  <select id="sourceOrigin" name="sourceOrigin" className="select" defaultValue="paper_form">
                    {ORIGIN_TYPES.map((origin) => (
                      <option key={origin} value={origin}>
                        {origin}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="sourceCollectedAt">
                    Collection date (optional)
                  </label>
                  <input id="sourceCollectedAt" name="sourceCollectedAt" type="date" className="input" />
                </div>
                <div>
                  <label className="field-label" htmlFor="sourceTitle">
                    Source title
                  </label>
                  <input id="sourceTitle" name="sourceTitle" className="input" placeholder="Signed consent forms P-23, folder 2" required />
                </div>
                <div>
                  <label className="field-label" htmlFor="sourceReference">
                    Source reference
                  </label>
                  <input id="sourceReference" name="sourceReference" className="input" placeholder="archive://consent/P23/2" required />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="evidenceLocator">
                    Where in the source this participant appears
                  </label>
                  <input id="evidenceLocator" name="evidenceLocator" className="input" placeholder="page 1, line 4" required />
                </div>
              </fieldset>

              <fieldset className="grid gap-3 md:grid-cols-2">
                <legend className="field-label">Consent evidence</legend>
                <div>
                  <label className="field-label" htmlFor="consentVersion">
                    Consent version
                  </label>
                  <input id="consentVersion" name="consentVersion" className="input" placeholder="consent-v2 2025-10" required />
                </div>
                <div>
                  <label className="field-label" htmlFor="consentBasis">
                    Basis
                  </label>
                  <select id="consentBasis" name="consentBasis" className="select" defaultValue="written_signed">
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
                  <label className="field-label" htmlFor="consentGrantedAt">
                    Consent date (optional)
                  </label>
                  <input id="consentGrantedAt" name="consentGrantedAt" type="date" className="input" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="consentEvidenceNote">
                    Consent evidence description
                  </label>
                  <input
                    id="consentEvidenceNote"
                    name="consentEvidenceNote"
                    className="input"
                    placeholder="Signed informed-consent form filed 2025-10-12, archive box 4"
                    required
                  />
                </div>
              </fieldset>

              <fieldset className="grid gap-3 md:grid-cols-2">
                <legend className="field-label">Restricted identity data (optional, separately permissioned)</legend>
                <div>
                  <label className="field-label" htmlFor="identityName">
                    Full name
                  </label>
                  <input id="identityName" name="identityName" className="input" autoComplete="off" />
                </div>
                <div>
                  <label className="field-label" htmlFor="identityEmail">
                    Contact e-mail
                  </label>
                  <input id="identityEmail" name="identityEmail" type="email" className="input" autoComplete="off" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="lawfulBasis">
                    Lawful basis for storing identity data
                  </label>
                  <input
                    id="lawfulBasis"
                    name="lawfulBasis"
                    className="input"
                    placeholder="Signed informed consent incl. re-contact permission"
                  />
                  <p className="hint">
                    Stored only in participant_private_identity and never included in analytic exports. Recording identity
                    data is itself an audited action.
                  </p>
                </div>
              </fieldset>
            </ActionForm>
          </div>
        </Panel>

        <Panel title="What happens on save" subtitle="No value is invented at any step.">
          <ol className="grid gap-2 p-4 text-[0.8125rem]">
            <li>1. A `documented_source` row records the declared origin, title, reference and the operator.</li>
            <li>2. The participant row stores only the attributes you supplied; every empty field is listed in `attribute_missingness_json` as `not_documented_in_source`.</li>
            <li>3. A `consent_record` row stores the version, basis, scope and the evidence note.</li>
            <li>4. An `evidence_link` row ties the participant to the source and the locator you gave.</li>
            <li>5. If identity data was provided, a `participant_private_identity` row is written in a separate table, and the action is audited with severity `warning`.</li>
            <li>6. One `participant.create` audit event captures the pseudonym, source and consent version.</li>
          </ol>
        </Panel>
      </div>
    </div>
  );
}
