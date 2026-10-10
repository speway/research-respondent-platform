import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "../../../../lib/services/session.ts";
import {
  getInstrument,
  getInstrumentVersion,
  listAlgorithms,
  listItems,
  listScales,
  parseAlgorithmRow,
} from "../../../../lib/repo/assessments.ts";
import { addItemAction, createAlgorithmAction, createScaleAction } from "../../../actions/library.ts";
import { ActionForm } from "../../../../components/action-form.tsx";
import { Chip, Metric, Note, Panel, ValueOrMissing, formatDateTime, formatNumber } from "../../../../components/ui.tsx";

export const dynamic = "force-dynamic";

export default async function InstrumentVersionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await requireAuth();
  const version = getInstrumentVersion(db, id);
  if (!version) {
    notFound();
  }
  const instrument = getInstrument(db, version.instrument_id);
  const items = listItems(db, id);
  const scales = listScales(db, id);
  const algorithms = listAlgorithms(db, id);

  return (
    <div className="grid gap-4">
      <div>
        <p className="mono text-[0.75rem] text-[#55606d]">
          <Link href="/library">Psychological Library</Link> / {instrument?.title ?? "instrument"} / v{version.version_label}
        </p>
        <h1 className="text-lg font-semibold tracking-tight">
          {instrument?.title} — version {version.version_label} ({version.language})
        </h1>
        <p className="mt-0.5 text-[0.8125rem] text-[#55606d]">
          {version.adaptation ?? "no adaptation recorded"} · norms: {version.norm_reference ?? "not recorded"}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Items" value={items.length} />
        <Metric label="Reverse-keyed" value={items.filter((item) => item.reverse_scored === 1).length} />
        <Metric label="Scales" value={scales.length} />
        <Metric label="Algorithms" value={algorithms.length} />
        <Metric
          label="Frozen"
          value={version.frozen_at ? "yes" : "no"}
          hint={version.frozen_at ? "item wording can no longer change" : "editable until the first answer is recorded"}
          tone={version.frozen_at ? "partial" : "neutral"}
        />
      </div>

      <Note tone={version.clinical_use_permitted === 1 ? "ok" : "warn"}>
        Clinical use {version.clinical_use_permitted === 1 ? "is" : "is NOT"} permitted for this version.{" "}
        {version.is_provisional === 1
          ? "This version is marked provisional: every derived score is flagged provisional and must be reported as such."
          : "This version is not marked provisional."}{" "}
        {version.limitations ? `Recorded limitations: ${version.limitations}` : "No limitations statement recorded yet."}
      </Note>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Items" subtitle="Wording is stored verbatim. It is frozen as soon as the first answer exists for this version.">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Code</th>
                  <th>Wording</th>
                  <th>Type</th>
                  <th>Range</th>
                  <th>Keying</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-[#55606d]">
                      No items yet. Add the first item below; do not paste restricted item text unless the licence permits it.
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id}>
                      <td className="num">{item.order_index}</td>
                      <td className="mono">{item.item_code}</td>
                      <td className="max-w-[46ch] text-[0.8125rem]">{item.text_verbatim}</td>
                      <td className="text-[0.75rem]">{item.response_type}</td>
                      <td className="mono text-[0.75rem]">
                        {item.min_value === null && item.max_value === null
                          ? "—"
                          : `${item.min_value ?? "?"} … ${item.max_value ?? "?"}`}
                      </td>
                      <td>{item.reverse_scored === 1 ? <Chip tone="info">reverse</Chip> : <span className="text-[0.75rem]">direct</span>}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-[#dfe3e8] p-4">
            <ActionForm action={addItemAction} submitLabel="Add item" hidden={{ instrumentVersionId: id }} resetOnSuccess>
              <div className="grid gap-3 md:grid-cols-4">
                <div>
                  <label className="field-label" htmlFor="itemCode">
                    Item code
                  </label>
                  <input id="itemCode" name="itemCode" className="input" placeholder="07" required />
                </div>
                <div>
                  <label className="field-label" htmlFor="orderIndex">
                    Order
                  </label>
                  <input id="orderIndex" name="orderIndex" type="number" min={1} className="input" required />
                </div>
                <div>
                  <label className="field-label" htmlFor="responseType">
                    Response type
                  </label>
                  <select id="responseType" name="responseType" className="select" defaultValue="likert">
                    {["likert", "yes_no", "multiple_choice", "numeric", "open_text", "date", "categorical"].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="textLanguage">
                    Item language
                  </label>
                  <input id="textLanguage" name="textLanguage" className="input" defaultValue={version.language} required />
                </div>
                <div className="md:col-span-4">
                  <label className="field-label" htmlFor="textVerbatim">
                    Item wording (verbatim)
                  </label>
                  <textarea id="textVerbatim" name="textVerbatim" className="textarea" required />
                </div>
                <div className="md:col-span-2">
                  <label className="field-label" htmlFor="options">
                    Response options (pipe separated)
                  </label>
                  <input id="options" name="options" className="input" placeholder="никогда|редко|иногда|часто|всегда" />
                </div>
                <div>
                  <label className="field-label" htmlFor="minValue">
                    Minimum
                  </label>
                  <input id="minValue" name="minValue" type="number" className="input" placeholder="1" />
                </div>
                <div>
                  <label className="field-label" htmlFor="maxValue">
                    Maximum
                  </label>
                  <input id="maxValue" name="maxValue" type="number" className="input" placeholder="5" />
                </div>
                <div className="flex items-center gap-2">
                  <input id="reverseScored" name="reverseScored" type="checkbox" />
                  <label htmlFor="reverseScored" className="text-[0.8125rem]">
                    Reverse-keyed for its scale
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input id="required" name="required" type="checkbox" defaultChecked />
                  <label htmlFor="required" className="text-[0.8125rem]">
                    Required
                  </label>
                </div>
              </div>
            </ActionForm>
          </div>
        </Panel>

        <div className="grid gap-4">
          <Panel title="Scales" subtitle="Scale definitions group items; algorithms do the arithmetic.">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Title</th>
                    <th>Kind</th>
                    <th>Direction</th>
                  </tr>
                </thead>
                <tbody>
                  {scales.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-[#55606d]">
                        No scales defined.
                      </td>
                    </tr>
                  ) : (
                    scales.map((scale) => (
                      <tr key={scale.id}>
                        <td className="mono">{scale.scale_code}</td>
                        <td>{scale.title}</td>
                        <td className="text-[0.75rem]">{scale.kind}</td>
                        <td className="text-[0.75rem]">{scale.direction}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-[#dfe3e8] p-4">
              <ActionForm action={createScaleAction} submitLabel="Create scale" hidden={{ instrumentVersionId: id }} resetOnSuccess>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="field-label" htmlFor="scaleCode">
                      Scale code
                    </label>
                    <input id="scaleCode" name="scaleCode" className="input" placeholder="TOTAL" required />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="title">
                      Title
                    </label>
                    <input id="title" name="title" className="input" required />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="kind">
                      Kind
                    </label>
                    <select id="kind" name="kind" className="select" defaultValue="raw_sum">
                      {["raw_sum", "mean", "weighted_sum", "factor_score", "clinical_elevation", "index"].map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="direction">
                      Direction
                    </label>
                    <select id="direction" name="direction" className="select" defaultValue="higher_is_more">
                      {["higher_is_more", "higher_is_less", "bipolar"].map((direction) => (
                        <option key={direction} value={direction}>
                          {direction}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="minPossible">
                      Minimum possible
                    </label>
                    <input id="minPossible" name="minPossible" type="number" className="input" />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="maxPossible">
                      Maximum possible
                    </label>
                    <input id="maxPossible" name="maxPossible" type="number" className="input" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="field-label" htmlFor="normNotes">
                      Norm notes
                    </label>
                    <input id="normNotes" name="normNotes" className="input" />
                  </div>
                </div>
              </ActionForm>
            </div>
          </Panel>

          <Panel title="Scoring algorithms" subtitle="Declarative, versioned pipelines. A changed rule is a new algorithm version, never an edit.">
            {algorithms.length === 0 ? (
              <p className="empty-state">
                No algorithm registered. Without one, no score is produced - the platform never guesses a scoring rule.
              </p>
            ) : (
              <ul className="grid gap-2 p-4">
                {algorithms.map((algorithm) => {
                  const parsed = parseAlgorithmRow(algorithm);
                  return (
                    <li key={algorithm.id} className="note">
                      <p className="mono text-[0.75rem]">
                        {algorithm.algorithm_version} · policy {algorithm.missing_policy} · min items{" "}
                        {algorithm.min_items_required} · scale{" "}
                        {scales.find((scale) => scale.id === algorithm.scale_definition_id)?.scale_code ?? "unbound"}
                      </p>
                      <p className="mt-1 text-[0.75rem]">
                        steps: {parsed.steps.map((step) => step.kind).join(" → ") || "none"}
                      </p>
                      {parsed.documentation ? <p className="mt-1 text-[0.75rem] text-[#55606d]">{parsed.documentation}</p> : null}
                      <p className="mt-1 text-[0.6875rem] text-[#55606d]">created {formatDateTime(algorithm.created_at)}</p>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="border-t border-[#dfe3e8] p-4">
              <ActionForm action={createAlgorithmAction} submitLabel="Register algorithm" hidden={{ instrumentVersionId: id }}>
                <div>
                  <label className="field-label" htmlFor="scaleDefinitionId">
                    Scale
                  </label>
                  <select id="scaleDefinitionId" name="scaleDefinitionId" className="select" required>
                    {scales.map((scale) => (
                      <option key={scale.id} value={scale.id}>
                        {scale.scale_code} — {scale.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="algorithmJson">
                    Algorithm JSON
                  </label>
                  <textarea
                    id="algorithmJson"
                    name="algorithmJson"
                    className="textarea mono"
                    rows={8}
                    defaultValue={JSON.stringify(
                      {
                        algorithmVersion: "1.0",
                        missingPolicy: "strict_complete",
                        minItemsRequired: 1,
                        documentation: "Replace with the scoring instructions from the instrument manual or adaptation paper.",
                        steps: [{ kind: "recoded_sum", itemCodes: ["01", "02"], reverseItemCodes: [] }],
                      },
                      null,
                      2,
                    )}
                    required
                  />
                  <p className="hint">
                    Step kinds: recoded_sum, weighted_sum, mean_of_items, subscale_sum, linear_transform, z_score,
                    percentile_lookup, band_lookup. Missing-data policies: strict_complete, prorate_if_min_met,
                    sum_available_only, no_score.
                  </p>
                </div>
              </ActionForm>
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="Version metadata" subtitle="Everything a later reviewer needs to judge a score.">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="field-label">Publication year</p>
            <p>{version.publication_year ?? <ValueOrMissing value={null} />}</p>
          </div>
          <div>
            <p className="field-label">Response format</p>
            <p>{version.response_format ?? <ValueOrMissing value={null} />}</p>
          </div>
          <div>
            <p className="field-label">Norm reference</p>
            <p>{version.norm_reference ?? <ValueOrMissing value={null} />}</p>
          </div>
          <div>
            <p className="field-label">Documented source</p>
            <p className="mono text-[0.75rem]">{version.source_document_id ?? "not recorded"}</p>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <p className="field-label">Scoring notes</p>
            <p className="text-[0.8125rem]">{version.scoring_notes ?? "None recorded."}</p>
          </div>
        </div>
      </Panel>

      <Panel title="Registered items coverage" subtitle="Items without bounds cannot be reverse-keyed; the scorer reports that as a diagnostic.">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Response type</th>
                <th className="num">Min</th>
                <th className="num">Max</th>
                <th>Options</th>
                <th>Section</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`coverage-${item.id}`}>
                  <td className="mono">{item.item_code}</td>
                  <td className="text-[0.75rem]">{item.response_type}</td>
                  <td className="num">{item.min_value === null ? <ValueOrMissing value={null} /> : formatNumber(item.min_value)}</td>
                  <td className="num">{item.max_value === null ? <ValueOrMissing value={null} /> : formatNumber(item.max_value)}</td>
                  <td className="text-[0.75rem]">{(JSON.parse(item.options_json) as string[]).join(" | ") || "—"}</td>
                  <td className="text-[0.75rem]">{item.section ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
