import Link from "next/link";
import { requireAuth } from "../../lib/services/session.ts";
import { listStudies } from "../../lib/repo/studies.ts";
import { ActionForm } from "../../components/action-form.tsx";
import { Panel, Chip, formatDateTime, stateTone } from "../../components/ui.tsx";
import { createStudyAction } from "../actions/studies.ts";

export const dynamic = "force-dynamic";

export default async function StudiesPage() {
  const { db, actor } = await requireAuth();
  const studies = listStudies(db, actor.organizationId);

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Studies</h1>
        <p className="mt-0.5 max-w-[80ch] text-[0.8125rem] text-[#55606d]">
          Each study holds its own protocol versions, recruitment criteria, approved instruments, collection timepoints
          and participant permissions. Protocol versions are never overwritten; a new version supersedes the previous one.
        </p>
      </div>

      <Panel title="Create study" subtitle="A study starts in draft status and stays invisible to collection until activated.">
        <div className="p-4">
          <ActionForm action={createStudyAction} submitLabel="Create study" resetOnSuccess className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="field-label" htmlFor="code">
                Study code
              </label>
              <input id="code" name="code" className="input" placeholder="UNC-P23" required />
              <p className="hint">Short identifier used in exports and task contracts.</p>
            </div>
            <div>
              <label className="field-label" htmlFor="principalEmail">
                Principal investigator e-mail (optional)
              </label>
              <input id="principalEmail" name="principalEmail" type="email" className="input" />
            </div>
            <div className="md:col-span-2">
              <label className="field-label" htmlFor="title">
                Title
              </label>
              <input id="title" name="title" className="input" required minLength={3} />
            </div>
            <div className="md:col-span-2">
              <label className="field-label" htmlFor="researchQuestion">
                Research question
              </label>
              <textarea id="researchQuestion" name="researchQuestion" className="textarea" required minLength={10} />
            </div>
          </ActionForm>
        </div>
      </Panel>

      <Panel title={`Study register (${studies.length})`} subtitle="Counts are computed from stored records only.">
        {studies.length === 0 ? (
          <p className="empty-state">No studies yet. Create one above to begin.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Title</th>
                  <th>Question</th>
                  <th>Status</th>
                  <th className="num">Participants</th>
                  <th className="num">Protocols</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {studies.map((study) => (
                  <tr key={study.id}>
                    <td className="mono">
                      <Link href={`/studies/${study.id}`}>{study.code}</Link>
                    </td>
                    <td>{study.title}</td>
                    <td className="max-w-[38ch] text-[0.8125rem] text-[#55606d]">{study.research_question}</td>
                    <td>
                      <Chip tone={stateTone(study.status)}>{study.status}</Chip>
                    </td>
                    <td className="num">{study.participant_count}</td>
                    <td className="num">{study.protocol_count}</td>
                    <td className="mono">{formatDateTime(study.created_at)}</td>
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
