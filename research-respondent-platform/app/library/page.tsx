import Link from "next/link";
import { requireAuth } from "../../lib/services/session.ts";
import { listInstruments, listInstrumentVersions } from "../../lib/repo/assessments.ts";
import { ActionForm } from "../../components/action-form.tsx";
import { Chip, EmptyState, Metric, Note, Panel } from "../../components/ui.tsx";
import { createInstrumentAction } from "../actions/library.ts";

export const dynamic = "force-dynamic";

const RIGHTS_TONES: Record<string, "verified" | "partial" | "blocked" | "neutral"> = {
  public_domain: "verified",
  open_access: "verified",
  licensed_local: "partial",
  permission_pending: "blocked",
  restricted_no_redistribution: "blocked",
};

export default async function LibraryPage() {
  const { db, actor } = await requireAuth();
  const instruments = listInstruments(db);
  const versionRows = instruments.flatMap((instrument) =>
    listInstrumentVersions(db, instrument.id).map((version) => ({ instrument, version })),
  );

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Psychological Library</h1>
        <p className="mt-0.5 max-w-[90ch] text-[0.8125rem] text-[#55606d]">
          Instruments, their versions, scales and versioned scoring algorithms. Distinct traditions (MMPI-family clinical
          instruments, MPQ-family normal-range instruments, and the separate Strelau temperament frameworks) are recorded
          as separate instruments and are never merged because their labels resemble one another.
        </p>
      </div>

      <Note tone="warn">
        The library starts empty on purpose. No instrument item text is bundled with the platform: registered instruments,
        item wording and scoring rules are entered by the responsible researcher, together with the documented source and
        the licensing status. Restricted item text stays inside this database and is never included in analytic exports.
      </Note>

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Instruments" value={instruments.length} />
        <Metric label="Versions" value={versionRows.length} />
        <Metric
          label="Versions with recorded answers"
          value={versionRows.filter((row) => row.version.answer_count > 0).length}
          hint="item set frozen once answers exist"
        />
      </div>

      <Panel title="Register instrument" subtitle="Rights status is mandatory; clinical instruments need an explicit licence note.">
        <div className="p-4">
          <ActionForm action={createInstrumentAction} submitLabel="Register instrument" resetOnSuccess>
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="field-label" htmlFor="slug">
                  Slug
                </label>
                <input id="slug" name="slug" className="input" placeholder="strelau-ti-1993" required />
              </div>
              <div className="md:col-span-2">
                <label className="field-label" htmlFor="title">
                  Title
                </label>
                <input id="title" name="title" className="input" required />
              </div>
              <div>
                <label className="field-label" htmlFor="abbreviation">
                  Abbreviation
                </label>
                <input id="abbreviation" name="abbreviation" className="input" />
              </div>
              <div className="md:col-span-2">
                <label className="field-label" htmlFor="authors">
                  Authors / rights holders
                </label>
                <input id="authors" name="authors" className="input" />
              </div>
              <div>
                <label className="field-label" htmlFor="tradition">
                  Tradition
                </label>
                <select id="tradition" name="tradition" className="select" defaultValue="">
                  <option value="">unspecified</option>
                  <option value="big_five">big_five</option>
                  <option value="sixteen_pf">sixteen_pf</option>
                  <option value="temperament_strelau_pavlovian">temperament_strelau_pavlovian</option>
                  <option value="temperament_strelau_regulative">temperament_strelau_regulative</option>
                  <option value="temperament_other">temperament_other</option>
                  <option value="clinical_mmpi_family">clinical_mmpi_family</option>
                  <option value="normal_range_mpq_family">normal_range_mpq_family</option>
                  <option value="self_regulation">self_regulation</option>
                  <option value="tolerance_of_uncertainty">tolerance_of_uncertainty</option>
                  <option value="addiction_screening">addiction_screening</option>
                  <option value="cognitive_ability">cognitive_ability</option>
                  <option value="psychosomatic">psychosomatic</option>
                  <option value="other">other</option>
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="rightsStatus">
                  Rights status
                </label>
                <select id="rightsStatus" name="rightsStatus" className="select" defaultValue="licensed_local">
                  <option value="public_domain">public_domain</option>
                  <option value="open_access">open_access</option>
                  <option value="licensed_local">licensed_local</option>
                  <option value="permission_pending">permission_pending</option>
                  <option value="restricted_no_redistribution">restricted_no_redistribution</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="field-label" htmlFor="licenseHolder">
                  Licence holder / rights contact
                </label>
                <input id="licenseHolder" name="licenseHolder" className="input" placeholder="required for licensed or restricted instruments" />
              </div>
              <div className="md:col-span-3">
                <label className="field-label" htmlFor="constructDomains">
                  Construct domains (comma separated)
                </label>
                <input id="constructDomains" name="constructDomains" className="input" placeholder="temperament, reactivity, activity" />
              </div>
              <div className="md:col-span-3">
                <label className="field-label" htmlFor="rightsNote">
                  Rights note
                </label>
                <textarea id="rightsNote" name="rightsNote" className="textarea" placeholder="Where the permission is documented, who granted it, what may be redistributed." />
              </div>
              <div className="flex items-center gap-2">
                <input id="isClinical" name="isClinical" type="checkbox" />
                <label htmlFor="isClinical" className="text-[0.8125rem]">
                  Clinical instrument
                </label>
              </div>
              <div className="flex items-center gap-2">
                <input id="requiresSupervision" name="requiresSupervision" type="checkbox" />
                <label htmlFor="requiresSupervision" className="text-[0.8125rem]">
                  Requires supervision
                </label>
              </div>
            </div>
          </ActionForm>
        </div>
      </Panel>

      <Panel title={`Catalogue (${instruments.length})`} subtitle="Answer counts show how much real data each instrument version already holds.">
        {instruments.length === 0 ? (
          <EmptyState>Nothing registered yet. Register the first instrument above, then add its version, items and scales.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Abbreviation</th>
                  <th>Tradition</th>
                  <th>Rights</th>
                  <th>Clinical</th>
                  <th className="num">Versions</th>
                  <th className="num">Items</th>
                  <th className="num">Answers</th>
                </tr>
              </thead>
              <tbody>
                {instruments.map((instrument) => (
                  <tr key={instrument.id}>
                    <td>
                      <Link href={`/library/${instrument.id}`}>{instrument.title}</Link>
                      <span className="mono block text-[0.6875rem] text-[#55606d]">{instrument.slug}</span>
                    </td>
                    <td className="mono">{instrument.abbreviation ?? "—"}</td>
                    <td className="text-[0.75rem]">{instrument.tradition ?? "unspecified"}</td>
                    <td>
                      <Chip tone={RIGHTS_TONES[instrument.rights_status] ?? "neutral"}>{instrument.rights_status}</Chip>
                    </td>
                    <td>{instrument.is_clinical === 1 ? "yes" : "no"}</td>
                    <td className="num">{instrument.version_count}</td>
                    <td className="num">{instrument.item_count}</td>
                    <td className="num">{instrument.answer_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={`Versions (${versionRows.length})`} subtitle="A version with recorded answers is frozen: wording, options and keying can no longer change.">
        {versionRows.length === 0 ? (
          <EmptyState>No instrument versions yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Version</th>
                  <th>Language</th>
                  <th>Response format</th>
                  <th>Provisional</th>
                  <th>Clinical use</th>
                  <th className="num">Items</th>
                  <th className="num">Answers</th>
                  <th>Frozen</th>
                </tr>
              </thead>
              <tbody>
                {versionRows.map(({ instrument, version }) => (
                  <tr key={version.id}>
                    <td>{instrument.title}</td>
                    <td className="mono">
                      <Link href={`/library/versions/${version.id}`}>{version.version_label}</Link>
                    </td>
                    <td className="mono">{version.language}</td>
                    <td className="text-[0.75rem]">{version.response_format ?? "—"}</td>
                    <td>{version.is_provisional === 1 ? <Chip tone="partial">provisional</Chip> : "no"}</td>
                    <td>{version.clinical_use_permitted === 1 ? "permitted" : <Chip tone="blocked">not permitted</Chip>}</td>
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
