import Link from "next/link";
import { requireAuth } from "../../lib/services/session.ts";
import { countParticipants, listParticipants } from "../../lib/repo/participants.ts";
import { listStudies } from "../../lib/repo/studies.ts";
import { EmptyState, Metric, Panel, ValueOrMissing, formatDateTime, Chip, stateTone } from "../../components/ui.tsx";

export const dynamic = "force-dynamic";

export default async function ParticipantsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; studyId?: string; page?: string }>;
}) {
  const { search, studyId, page } = await searchParams;
  const { db, actor } = await requireAuth();
  const pageNumber = Math.max(Number.parseInt(page ?? "1", 10) || 1, 1);
  const pageSize = 50;
  const rows = listParticipants(db, actor.organizationId, {
    search,
    studyId,
    limit: pageSize,
    offset: (pageNumber - 1) * pageSize,
  });
  const total = countParticipants(db, actor.organizationId);
  const studies = listStudies(db, actor.organizationId);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Participants</h1>
          <p className="mt-0.5 max-w-[85ch] text-[0.8125rem] text-[#55606d]">
            Pseudonymous registry separated from identity data. Every record carries its documented source and a consent
            record; attributes the source does not contain stay explicitly missing.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/participants/import" className="btn btn-primary no-underline">
            Import documented source
          </Link>
          <Link href="/participants/new" className="btn no-underline">
            Create participant
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Registry size" value={total} hint="pseudonymous records" />
        <Metric label="Shown" value={rows.length} hint={`page ${pageNumber}`} />
        <Metric label="Studies" value={studies.length} />
      </div>

      <Panel title="Filters" subtitle="Search matches the pseudonym only; identity search is a separately granted scope.">
        <form className="grid gap-3 p-4 md:grid-cols-[2fr_2fr_auto]" method="get">
          <div>
            <label className="field-label" htmlFor="search">
              Pseudonym contains
            </label>
            <input id="search" name="search" className="input" defaultValue={search ?? ""} placeholder="P-01" />
          </div>
          <div>
            <label className="field-label" htmlFor="studyId">
              Study
            </label>
            <select id="studyId" name="studyId" className="select" defaultValue={studyId ?? ""}>
              <option value="">All studies</option>
              {studies.map((study) => (
                <option key={study.id} value={study.id}>
                  {study.code} — {study.title}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn">
              Apply
            </button>
            <Link href="/participants" className="btn no-underline">
              Reset
            </Link>
          </div>
        </form>
      </Panel>

      <Panel title="Registry" subtitle="Missing = the source document did not contain the value. Never filled in.">
        {rows.length === 0 ? (
          <EmptyState>
            No participants match.{" "}
            <Link href="/participants/import">Import a documented source</Link> or{" "}
            <Link href="/participants/new">create a record with provenance</Link> to begin.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Pseudonym</th>
                  <th>Consent</th>
                  <th>Age at enrolment</th>
                  <th>Language</th>
                  <th>Education</th>
                  <th>Region</th>
                  <th className="num">Studies</th>
                  <th className="num">Sessions</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">
                      <Link href={`/participants/${row.id}`}>{row.pseudonym}</Link>
                    </td>
                    <td>
                      <Chip tone={stateTone(row.consent_status ?? "none")}>{row.consent_status ?? "none"}</Chip>
                    </td>
                    <td>
                      <ValueOrMissing value={row.age_at_enrolment} />
                    </td>
                    <td>
                      <ValueOrMissing value={row.preferred_language} />
                    </td>
                    <td>
                      <ValueOrMissing value={row.education_level} />
                    </td>
                    <td>
                      <ValueOrMissing value={row.region} />
                    </td>
                    <td className="num">{row.study_count}</td>
                    <td className="num">{row.session_count}</td>
                    <td className="mono">{formatDateTime(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-[#dfe3e8] px-3 py-2 text-[0.75rem] text-[#55606d]">
          <span>
            Showing {rows.length} of {total}
          </span>
          <span className="flex gap-2">
            {pageNumber > 1 ? (
              <Link
                className="btn-quiet no-underline"
                href={`/participants?page=${pageNumber - 1}${search ? `&search=${encodeURIComponent(search)}` : ""}${studyId ? `&studyId=${studyId}` : ""}`}
              >
                previous
              </Link>
            ) : null}
            {pageNumber * pageSize < total ? (
              <Link
                className="btn-quiet no-underline"
                href={`/participants?page=${pageNumber + 1}${search ? `&search=${encodeURIComponent(search)}` : ""}${studyId ? `&studyId=${studyId}` : ""}`}
              >
                next
              </Link>
            ) : null}
          </span>
        </div>
      </Panel>
    </div>
  );
}
