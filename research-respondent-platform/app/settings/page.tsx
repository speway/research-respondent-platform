import { requireAuth } from "../../lib/services/session.ts";
import { PERMISSIONS } from "../../lib/services/authz.ts";
import { listUsers } from "../../lib/repo/org.ts";
import { Chip, EmptyState, Metric, Note, Panel, formatDateTime } from "../../components/ui.tsx";

export const dynamic = "force-dynamic";

/** Authenticated, organization-scoped configuration overview. No credentials are rendered. */
export default async function SettingsPage() {
  const { db, actor, user } = await requireAuth();
  const organization = db
    .prepare("SELECT name, slug, created_at FROM organization WHERE id = ?")
    .get(actor.organizationId) as { name: string; slug: string; created_at: string } | undefined;
  const canManage = actor.permissions.includes(PERMISSIONS.settingsWrite);
  const users = canManage ? listUsers(db, actor.organizationId) : [];

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 max-w-[90ch] text-[0.8125rem] text-[#55606d]">
          Current account, organization and integration readiness. This screen does not disclose stored credentials or change permissions.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Metric label="Organization" value={organization?.name ?? "Unavailable"} />
        <Metric label="Your roles" value={actor.roles.length} hint={actor.roles.join(", ") || "No active roles"} />
        <Metric label="Settings write access" value={canManage ? "Granted" : "Read-only"} tone={canManage ? "verified" : "neutral"} />
      </div>
      <Panel title="Signed-in account">
        <div className="grid gap-3 p-4 text-sm sm:grid-cols-2">
          <div><p className="text-xs text-[#55606d]">Display name</p><p>{user.display_name}</p></div>
          <div><p className="text-xs text-[#55606d]">Account email</p><p>{user.email}</p></div>
          <div><p className="text-xs text-[#55606d]">Organization slug</p><p className="mono">{organization?.slug ?? "—"}</p></div>
          <div><p className="text-xs text-[#55606d]">Created</p><p className="mono">{formatDateTime(organization?.created_at)}</p></div>
        </div>
      </Panel>
      <Panel title="Integration status" subtitle="Capability statements do not indicate an authenticated connection.">
        <div className="grid gap-3 p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Local SQLite storage</span><Chip tone="partial">Development only</Chip>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Google Forms response submission</span><Chip tone="blocked">Not supported / unverified</Chip>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>External agent credentials</span><Chip tone="neutral">Managed outside this page</Chip>
          </div>
        </div>
      </Panel>
      <Note tone="warn">
        Configuration changes and external data transfers require the appropriate authorization and an audited implementation.
        A visible setting is not proof that a third-party service has been connected.
      </Note>
      {canManage ? (
        <Panel title="Organization users" subtitle="Visible only to users with settings:write. Role assignments are read-only here.">
          {users.length === 0 ? <EmptyState>No users have been registered.</EmptyState> : (
            <div className="overflow-x-auto">
              <table className="data-table w-full text-left">
                <thead><tr><th>Display name</th><th>Account</th><th>Roles</th><th>Active</th></tr></thead>
                <tbody>{users.map((member) => (
                  <tr key={member.id}>
                    <td>{member.display_name}</td>
                    <td>{member.email}</td>
                    <td>{member.roles.join(", ") || "none"}</td>
                    <td><Chip tone={member.is_active === 1 ? "verified" : "blocked"}>{member.is_active === 1 ? "Yes" : "No"}</Chip></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
