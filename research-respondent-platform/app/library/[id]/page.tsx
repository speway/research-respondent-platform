import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "../../../lib/services/session.ts";
import { getInstrument, listInstrumentVersions } from "../../../lib/repo/assessments.ts";
import { createInstrumentVersionAction } from "../../actions/library.ts";
import { ActionForm } from "../../../components/action-form.tsx";
import { Chip, EmptyState, Note, Panel } from "../../../components/ui.tsx";

export const dynamic = "force-dynamic";

export default async function InstrumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await requireAuth();
  const instrument = getInstrument(db, id);
  if (!instrument) {
    notFound();
  }
  const versions = listInstrumentVersions(db, id);
  const domains = JSON.parse(instrument.construct_domains_json) as string[];

  return (
    <div className="grid gap-4">
      <div>
        <p className="mono text-[0.75rem] text-[#55606d]">
          <Link href="/library">Psychological Library</Link> / {instrument.slug}
        </p>
        <h1 className="text-lg font-semibold tracking-tight">{instrument.title}</h1>
        <p className="mt-0.5 text-[0.8125rem] text-[#55606d]">
          {instrument.authors ?? "authors not recorded"} · tradition {instrument.tradition ?? "unspecified"}
          {domains.length > 0 ? ` · domains: ${domains.join(", ")}` : ""}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Panel title="Rights and interpretation limits" subtitle="Recorded once, visible on every derived score.">
          <div className="grid gap-2 p-4 text-[0.8125rem]">
            <p>
              Rights status: <Chip tone={instrument.rights_status === "public_domain" || instrument.rights_status === "open_access" ? "verified" : "partial"}>{instrument.rights_status}</Chip>
            </p>
            <p>
              Licence holder: <span className="mono">{instrument.license_holder ?? "not recorded"}</span>
            </p>
            <p>{instrument.rights_note ?? "No rights note recorded."}</p>
            <p>
              Clinical instrument: <strong>{instrument.is_clinical === 1 ? "yes" : "no"}</strong> · requires supervision:{" "}
              <strong>{instrument.requires_supervision === 1 ? "yes" : "no"}</strong>
            </p>
            <Note tone="warn">
              {instrument.is_clinical === 1
                ? "Clinical scales are only scored when the version explicitly permits clinical use. The platform never presents a clinical band derived from partial or unlicensed data."
                : "This is not marked as a clinical instrument. Clinical inferences must not be drawn from its scores."}
            </Note>
          </div>
        </Panel>

        <Panel title="Record a new version" subtitle="Versions coexist; older versions keep their own items, scales and answers.">
          <div className="p-4">
            <ActionForm action={createInstrumentVersionAction} submitLabel="Record version" hidden={{ instrumentId: id }}>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="versionLabel">
                    Version label
                  </label>
                  <input id="versionLabel" name="versionLabel" className="input" placeholder="1.0" required />
                </div>
                <div>
                  <label className="field-label" htmlFor="language">
                    Language
                  </label>
                  <input id="language" name="language" className="input" defaultValue="ru" required />
                </div>
                <div>
                  <label className="field-label" htmlFor="adaptation">
                    Adaptation / translation
                  </label>
                  <input id="adaptation" name="adaptation" className="input" />
                </div>
                <div>
                  <label className="field-label" htmlFor="publicationYear">
                    Publication year
                  </label>
                  <input id="publicationYear" name="publicationYear" className="input" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="responseFormat">
                    Response format
                  </label>
                  <input id="responseFormat" name="responseFormat" className="input" placeholder="1-5 Likert, higher = more" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="normReference">
                    Norm reference
                  </label>
                  <input id="normReference" name="normReference" className="input" placeholder="Validation study, sample, norms used" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="scoringNotes">
                    Scoring notes
                  </label>
                  <textarea id="scoringNotes" name="scoringNotes" className="textarea" />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="limitations">
                    Limitations
                  </label>
                  <textarea id="limitations" name="limitations" className="textarea" />
                </div>
                <div className="flex items-center gap-2">
                  <input id="isProvisional" name="isProvisional" type="checkbox" />
                  <label htmlFor="isProvisional" className="text-[0.8125rem]">
                    Provisional version
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input id="clinicalUsePermitted" name="clinicalUsePermitted" type="checkbox" />
                  <label htmlFor="clinicalUsePermitted" className="text-[0.8125rem]">
                    Clinical use permitted
                  </label>
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="sourceTitle">
                    Documented source of this version
                  </label>
                  <input
                    id="sourceTitle"
                    name="sourceTitle"
                    className="input"
                    placeholder="Instrument manual / adaptation paper / licence letter"
                    required
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="sourceReference">
                    Source reference
                  </label>
                  <input
                    id="sourceReference"
                    name="sourceReference"
                    className="input"
                    placeholder="DOI, library shelf mark or permission letter id"
                    required
                  />
                </div>
              </div>
            </ActionForm>
          </div>
        </Panel>
      </div>

      <Panel title={`Versions (${versions.length})`} subtitle="Open a version to manage its items, scales and scoring algorithms.">
        {versions.length === 0 ? (
          <EmptyState>No version recorded yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Language</th>
                  <th>Adaptation</th>
                  <th>Flags</th>
                  <th className="num">Items</th>
                  <th className="num">Answers</th>
                  <th>Frozen at</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td className="mono">
                      <Link href={`/library/versions/${version.id}`}>{version.version_label}</Link>
                    </td>
                    <td className="mono">{version.language}</td>
                    <td className="text-[0.75rem]">{version.adaptation ?? "—"}</td>
                    <td>
                      {version.is_provisional === 1 ? <Chip tone="partial">provisional</Chip> : null}
                      {version.clinical_use_permitted === 1 ? <Chip tone="verified">clinical permitted</Chip> : <Chip tone="blocked">no clinical use</Chip>}
                    </td>
                    <td className="num">{version.item_count}</td>
                    <td className="num">{version.answer_count}</td>
                    <td className="mono text-[0.6875rem]">{version.frozen_at ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
