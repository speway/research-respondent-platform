import Link from "next/link";
import { requireAuth } from "../../lib/services/session.ts";
import { listStudies } from "../../lib/repo/studies.ts";
import { listParticipants } from "../../lib/repo/participants.ts";
import {
  GOOGLE_FORMS_CAPABILITY_NOTE,
  listExternalForms,
  listExternalFormVersions,
  listFieldMappings,
  listFormFields,
  mappingCoverage,
} from "../../lib/repo/forms.ts";
import { listDocumentedSources } from "../../lib/repo/sources.ts";
import { loadMappingSourceContext } from "../../lib/services/preflight-context.ts";
import { buildPreflight } from "../../lib/domain/mapping.ts";
import { toFieldInput, toMappingCandidate } from "../../lib/repo/forms.ts";
import {
  captureFormVersionAction,
  createExternalFormAction,
  deleteMappingAction,
  preflightAction,
  upsertMappingAction,
  validateMappingAction,
} from "../actions/forms.ts";
import { ActionForm } from "../../components/action-form.tsx";
import { Chip, EmptyState, Metric, Note, Panel, formatDateTime } from "../../components/ui.tsx";

export const dynamic = "force-dynamic";

export default async function FormsPage({
  searchParams,
}: {
  searchParams: Promise<{ studyId?: string; versionId?: string; participantId?: string }>;
}) {
  const { studyId, versionId, participantId } = await searchParams;
  const { db, actor } = await requireAuth();
  const studies = listStudies(db, actor.organizationId);
  const forms = listExternalForms(db, actor.organizationId);
  const selectedStudyId = studyId ?? studies[0]?.id ?? "";
  const allVersions = forms.flatMap((form) =>
    listExternalFormVersions(db, form.id).map((version) => ({ form, version })),
  );
  const selectedVersion =
    allVersions.find((entry) => entry.version.id === versionId) ?? allVersions[0] ?? null;
  const fields = selectedVersion ? listFormFields(db, selectedVersion.version.id) : [];
  const mappings = selectedVersion && selectedStudyId ? listFieldMappings(db, selectedStudyId, selectedVersion.version.id) : [];
  const coverage = selectedStudyId ? mappingCoverage(db, selectedStudyId) : { byStatus: {}, unmappedRequired: 0 };
  const sources = listDocumentedSources(db, actor.organizationId, 10);
  const participants = listParticipants(db, actor.organizationId, { limit: 100 });
  const selectedParticipantId = participantId ?? participants[0]?.id ?? "";

  const preflightPreview =
    selectedVersion && selectedStudyId && selectedParticipantId
      ? (() => {
          const context = loadMappingSourceContext(db, {
            participantId: selectedParticipantId,
            studyId: selectedStudyId,
          });
          const consent = db
            .prepare(
              `SELECT status, consent_version, withdrawn_at FROM consent_record
               WHERE participant_id = ? AND (study_id = ? OR study_id IS NULL)
               ORDER BY recorded_at DESC LIMIT 1`,
            )
            .get(selectedParticipantId, selectedStudyId) as
            | { status: string; consent_version: string; withdrawn_at: string | null }
            | undefined;
          return buildPreflight({
            studyId: selectedStudyId,
            participantId: selectedParticipantId,
            externalFormVersionId: selectedVersion.version.id,
            fields: fields.map(toFieldInput),
            mappings: mappings.map(toMappingCandidate),
            context,
            consent: {
              status: consent?.status ?? "none",
              version: consent?.consent_version ?? null,
              withdrawnAt: consent?.withdrawn_at ?? null,
            },
            platformSubmissionAuthorized: false,
            generatedAt: new Date().toISOString(),
          });
        })()
      : null;

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Forms &amp; Mappings</h1>
        <p className="mt-0.5 max-w-[95ch] text-[0.8125rem] text-[#55606d]">
          External form definitions, versioned structure captures and typed field mappings from documented participant
          answers. Mapping is validated before anything is prepared, and the platform never submits a response on a
          participant&apos;s behalf without a verified, authorized path.
        </p>
      </div>

      <Note tone="warn">
        <strong>Documented provider limitation.</strong> {GOOGLE_FORMS_CAPABILITY_NOTE}
      </Note>

      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Registered forms" value={forms.length} />
        <Metric label="Structure versions" value={allVersions.length} />
        <Metric label="Mappings (study)" value={Object.values(coverage.byStatus).reduce((total, value) => total + value, 0)} />
        <Metric
          label="Unmapped required fields"
          value={coverage.unmappedRequired}
          tone={coverage.unmappedRequired > 0 ? "blocked" : "verified"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Register external form" subtitle="Metadata only; no credential is stored here, only the account name.">
          <div className="p-4">
            <ActionForm action={createExternalFormAction} submitLabel="Register form" resetOnSuccess>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="provider">
                    Provider
                  </label>
                  <select id="provider" name="provider" className="select" defaultValue="google_forms">
                    <option value="google_forms">google_forms</option>
                    <option value="microsoft_forms">microsoft_forms</option>
                    <option value="limesurvey">limesurvey</option>
                    <option value="other">other</option>
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="externalId">
                    Provider form id
                  </label>
                  <input id="externalId" name="externalId" className="input" required />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="title">
                    Form title
                  </label>
                  <input id="title" name="title" className="input" required />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="ownerAccount">
                    Owner account (name only)
                  </label>
                  <input id="ownerAccount" name="ownerAccount" className="input" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="responderUrl">
                    Responder URL
                  </label>
                  <input id="responderUrl" name="responderUrl" className="input" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="capabilityEvidence">
                    Capability evidence
                  </label>
                  <input id="capabilityEvidence" name="capabilityEvidence" className="input" placeholder="e.g. Forms API docs section, date checked" />
                </div>
              </div>
            </ActionForm>
          </div>
        </Panel>

        <Panel
          title="Capture a form structure version"
          subtitle="The structure is supplied from a documented capture and stored verbatim with its hash."
        >
          <div className="p-4">
            {forms.length === 0 ? (
              <EmptyState>Register a form first.</EmptyState>
            ) : (
              <ActionForm action={captureFormVersionAction} submitLabel="Capture version">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="field-label" htmlFor="externalFormId">
                      Form
                    </label>
                    <select id="externalFormId" name="externalFormId" className="select" required>
                      {forms.map((form) => (
                        <option key={form.id} value={form.id}>
                          {form.title} ({form.provider})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="versionLabel">
                      Version label
                    </label>
                    <input id="versionLabel" name="versionLabel" className="input" placeholder="2025-11" required />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="revisionId">
                      Provider revision id
                    </label>
                    <input id="revisionId" name="revisionId" className="input" />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="sourceTitle">
                      Capture source title
                    </label>
                    <input
                      id="sourceTitle"
                      name="sourceTitle"
                      className="input"
                      placeholder="forms.get response 2025-11-02"
                      required
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="field-label" htmlFor="sourceReference">
                      Capture reference
                    </label>
                    <input id="sourceReference" name="sourceReference" className="input" placeholder="file name / URI / operator initials" required />
                  </div>
                  <div className="md:col-span-2">
                    <label className="field-label" htmlFor="fieldsJson">
                      Fields (JSON array)
                    </label>
                    <textarea
                      id="fieldsJson"
                      name="fieldsJson"
                      className="textarea mono"
                      rows={10}
                      defaultValue={JSON.stringify(
                        [
                          {
                            fieldId: "q1",
                            orderIndex: 0,
                            title: "01 Я плохо выношу неопределенные ситуации.",
                            fieldType: "linear_scale",
                            isRequired: true,
                            options: ["1", "2", "3", "4", "5", "6", "7"],
                            section: null,
                          },
                        ],
                        null,
                        2,
                      )}
                      required
                    />
                    <p className="hint">
                      Field types: short_text, paragraph, multiple_choice, checkbox, dropdown, linear_scale, date, time,
                      grid, file_upload, section_header, unknown. Copy the wording exactly as the provider returns it.
                    </p>
                  </div>
                </div>
              </ActionForm>
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Captured versions" subtitle="A new capture supersedes the previous one and marks its mappings stale.">
        {allVersions.length === 0 ? (
          <EmptyState>No structure captured yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Form</th>
                  <th>Provider</th>
                  <th>Version</th>
                  <th>Fields</th>
                  <th>Captured</th>
                  <th>Structure hash</th>
                  <th>Supersedes</th>
                </tr>
              </thead>
              <tbody>
                {allVersions.map(({ form, version }) => (
                  <tr key={version.id}>
                    <td>{form.title}</td>
                    <td>
                      <Chip tone="neutral">{form.provider}</Chip>
                    </td>
                    <td className="mono">
                      <Link href={`/forms?studyId=${selectedStudyId}&versionId=${version.id}`}>{version.version_label}</Link>
                    </td>
                    <td className="num">{version.field_count}</td>
                    <td className="mono">{formatDateTime(version.captured_at)}</td>
                    <td className="mono text-[0.6875rem]">{version.structure_sha256.slice(0, 16)}…</td>
                    <td className="mono text-[0.6875rem]">{version.supersedes_id ? "yes" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {selectedVersion ? (
        <Panel
          title={`Field mapping — ${selectedVersion.form.title} ${selectedVersion.version.version_label}`}
          subtitle="Each field binds to a documented source. Section headers and unmapped fields are shown explicitly."
          actions={
            <div className="flex gap-2">
              <ActionForm
                action={validateMappingAction}
                submitLabel="Validate structure"
                quiet
                hidden={{ studyId: selectedStudyId, externalFormVersionId: selectedVersion.version.id }}
                className="inline"
              >
                <span />
              </ActionForm>
            </div>
          }
        >
          <div className="grid gap-3 p-4">
            {fields.length === 0 ? (
              <EmptyState>This version has no captured fields.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Required</th>
                      <th>Mapping</th>
                      <th>Status</th>
                      <th>Bind or edit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((field) => {
                      const mapping = mappings.find((row) => row.external_form_field_id === field.id);
                      return (
                        <tr key={field.id}>
                          <td className="num">{field.order_index}</td>
                          <td className="max-w-[38ch] text-[0.8125rem]">
                            {field.title}
                            <span className="mono block text-[0.6875rem] text-[#55606d]">{field.field_id}</span>
                            {field.section ? <span className="block text-[0.6875rem] text-[#55606d]">{field.section}</span> : null}
                          </td>
                          <td className="text-[0.75rem]">{field.field_type}</td>
                          <td>{field.is_required === 1 ? <Chip tone="info">required</Chip> : "no"}</td>
                          <td className="text-[0.75rem]">
                            {mapping ? (
                              <>
                                <Chip tone={mapping.mapping_kind === "unmapped" ? "blocked" : "verified"}>{mapping.mapping_kind}</Chip>
                                <span className="mono block text-[0.6875rem]">{mapping.source_ref_json}</span>
                              </>
                            ) : (
                              <Chip tone="blocked">unmapped</Chip>
                            )}
                          </td>
                          <td>
                            {mapping ? (
                              <Chip tone={mapping.status === "validated" ? "verified" : mapping.status === "rejected" ? "blocked" : "partial"}>
                                {mapping.status}
                              </Chip>
                            ) : (
                              <span className="text-[0.75rem] text-[#55606d]">—</span>
                            )}
                          </td>
                          <td>
                            <div className="grid gap-1">
                              <ActionForm
                                action={upsertMappingAction}
                                submitLabel="Save"
                                quiet
                                hidden={{
                                  studyId: selectedStudyId,
                                  externalFormVersionId: selectedVersion.version.id,
                                  externalFormFieldId: field.id,
                                }}
                                className="grid gap-1"
                              >
                                <select name="mappingKind" className="select" defaultValue={mapping?.mapping_kind ?? "unmapped"}>
                                  {["unmapped", "observed_answer", "derived_score", "participant_attribute", "fixed_constant"].map(
                                    (kind) => (
                                      <option key={kind} value={kind}>
                                        {kind}
                                      </option>
                                    ),
                                  )}
                                </select>
                                <input
                                  name="sourceRefJson"
                                  className="input mono"
                                  placeholder='{"itemCode":"07"}'
                                  defaultValue={mapping?.source_ref_json ?? "{}"}
                                />
                                <input
                                  name="rationale"
                                  className="input"
                                  placeholder="rationale (optional)"
                                  defaultValue={mapping?.rationale ?? ""}
                                />
                              </ActionForm>
                              {mapping ? (
                                <ActionForm
                                  action={deleteMappingAction}
                                  submitLabel="Remove"
                                  quiet
                                  hidden={{ studyId: selectedStudyId, mappingId: mapping.id }}
                                  className="inline"
                                >
                                  <span />
                                </ActionForm>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Preflight (dry run)"
        subtitle="Answer-level validation and the payload a task would carry. Nothing is submitted."
      >
        <div className="grid gap-3 p-4">
          <form method="get" className="grid gap-3 md:grid-cols-4">
            <div>
              <label className="field-label" htmlFor="studyIdFilter">
                Study
              </label>
              <select id="studyIdFilter" name="studyId" className="select" defaultValue={selectedStudyId}>
                {studies.map((study) => (
                  <option key={study.id} value={study.id}>
                    {study.code}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="versionIdFilter">
                Form version
              </label>
              <select id="versionIdFilter" name="versionId" className="select" defaultValue={selectedVersion?.version.id ?? ""}>
                {allVersions.map(({ form, version }) => (
                  <option key={version.id} value={version.id}>
                    {form.title} — {version.version_label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="participantIdFilter">
                Participant
              </label>
              <select id="participantIdFilter" name="participantId" className="select" defaultValue={selectedParticipantId}>
                {participants.map((participant) => (
                  <option key={participant.id} value={participant.id}>
                    {participant.pseudonym}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button type="submit" className="btn btn-primary">
                Run preflight
              </button>
            </div>
          </form>

          {preflightPreview ? (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <Metric label="Outcome" value={preflightPreview.outcome} tone={preflightPreview.outcome === "pass" ? "verified" : preflightPreview.outcome === "fail" ? "blocked" : "partial"} />
                <Metric label="Fields pass" value={preflightPreview.counts.pass} />
                <Metric label="Fields fail" value={preflightPreview.counts.fail} tone={preflightPreview.counts.fail > 0 ? "blocked" : "verified"} />
                <Metric
                  label="Submission allowed"
                  value={preflightPreview.authorization.submissionAllowedByPlatform ? "yes" : "no"}
                  tone="blocked"
                  hint="no verified provider submission path exists"
                />
              </div>

              {preflightPreview.blockingReasons.length > 0 ? (
                <ul className="grid gap-1">
                  {preflightPreview.blockingReasons.map((reason, index) => (
                    <li key={index} className="note note-fail">
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Outcome</th>
                      <th>Resolved value</th>
                      <th>Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preflightPreview.fields.map((field) => (
                      <tr key={field.fieldId}>
                        <td className="max-w-[34ch] text-[0.8125rem]">
                          {field.fieldTitle}
                          <span className="mono block text-[0.6875rem] text-[#55606d]">{field.fieldId}</span>
                        </td>
                        <td>
                          <Chip tone={field.outcome === "pass" ? "verified" : field.outcome === "fail" ? "blocked" : "partial"}>
                            {field.outcome}
                          </Chip>
                        </td>
                        <td className="mono text-[0.75rem]">{field.resolvedValue ?? <span className="chip chip-missing">missing</span>}</td>
                        <td>
                          <ul className="grid gap-0.5 text-[0.6875rem]">
                            {field.issues.length === 0 ? (
                              <li>none</li>
                            ) : (
                              field.issues.map((issue, index) => (
                                <li key={index} className={issue.severity === "fail" ? "text-[#98211f]" : "text-[#8a5309]"}>
                                  {issue.code}: {issue.message}
                                </li>
                              ))
                            )}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Panel title="Dry-run payload" subtitle="Exactly what an approved task would carry.">
                <pre className="mono overflow-x-auto p-4 text-[0.75rem]">
                  {JSON.stringify(preflightPreview.payload, null, 2)}
                </pre>
              </Panel>

              <ul className="grid gap-1">
                {preflightPreview.auditNotes.map((note, index) => (
                  <li key={index} className="note">
                    {note}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState>
              Select a study, a captured form version and a participant to run the preflight.
            </EmptyState>
          )}

          <ActionForm
            action={preflightAction}
            submitLabel="Run preflight and record the outcome in the audit log"
            quiet
            hidden={{
              studyId: selectedStudyId,
              participantId: selectedParticipantId,
              externalFormVersionId: selectedVersion?.version.id ?? "",
            }}
            className="grid gap-2"
          >
            <span />
          </ActionForm>
        </div>
      </Panel>

      <Panel title="Documented sources available for mapping" subtitle="Only these records can feed a form field.">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Origin</th>
                <th>Reference</th>
                <th>Received</th>
                <th className="num">Answers</th>
              </tr>
            </thead>
            <tbody>
              {sources.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-[#55606d]">
                    No documented sources imported yet.
                  </td>
                </tr>
              ) : (
                sources.map((source) => (
                  <tr key={source.id}>
                    <td>{source.title}</td>
                    <td>
                      <Chip tone="neutral">{source.origin_type}</Chip>
                    </td>
                    <td className="mono text-[0.6875rem]">{source.reference}</td>
                    <td className="mono">{formatDateTime(source.received_at)}</td>
                    <td className="num">{source.answer_count}</td>
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
