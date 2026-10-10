import Link from "next/link";
import { requireAuth } from "../../lib/services/session.ts";
import { listStudies } from "../../lib/repo/studies.ts";
import { listParticipants } from "../../lib/repo/participants.ts";
import { listAgents, listCapabilities, listAgentTasks, listAttempts, listEvidence, taskQueueSummary } from "../../lib/repo/tasks.ts";
import { listExternalForms, listExternalFormVersions } from "../../lib/repo/forms.ts";
import { adapterCapabilities } from "../../lib/services/orchestration.ts";
import {
  approveTaskAction,
  cancelTaskAction,
  createTaskAction,
  grantCapabilityAction,
  queueTaskAction,
  registerAgentAction,
  retryTaskAction,
  revokeCapabilityAction,
  runTaskAction,
  toggleAgentAction,
  validateTaskAction,
} from "../actions/agents.ts";
import { ActionForm } from "../../components/action-form.tsx";
import { Chip, EmptyState, Metric, Note, Panel, formatDateTime, stateTone } from "../../components/ui.tsx";

export const dynamic = "force-dynamic";

const TASK_KINDS = [
  "preflight_mapping",
  "compose_form_payload",
  "submit_external_response",
  "verify_submission",
  "collect_documented_answers",
] as const;

const CAPABILITIES = [
  "read_field_map",
  "read_permitted_answers",
  "preflight_only",
  "submit_external_response",
  "attach_execution_evidence",
  "request_human_review",
] as const;

export default async function AgentsPage() {
  const { db, actor } = await requireAuth();
  const agents = listAgents(db, actor.organizationId);
  const queue = taskQueueSummary(db, actor.organizationId);
  const tasks = listAgentTasks(db, { organizationId: actor.organizationId, limit: 60 });
  const studies = listStudies(db, actor.organizationId);
  const participants = listParticipants(db, actor.organizationId, { limit: 200 });
  const forms = listExternalForms(db, actor.organizationId);
  const formVersions = forms.flatMap((form) =>
    listExternalFormVersions(db, form.id).map((version) => ({ form, version })),
  );
  const localAdapter = adapterCapabilities("local-deterministic");

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Agents &amp; Tasks</h1>
        <p className="mt-0.5 max-w-[95ch] text-[0.8125rem] text-[#55606d]">
          Provider-neutral task contracts. An agent receives a bounded JSON package with a pseudonymous participant
          reference, the validated field map, only the answers it is permitted to read, an expiry and an idempotency key.
          Every state change, attempt and piece of evidence is recorded.
        </p>
      </div>

      <Note tone="warn">
        No external submission path is configured or claimed. The Google Forms API can read form structure and submitted
        responses of a form the caller owns, but it does not expose a supported way to create a response on a
        participant&apos;s behalf. Tasks whose purpose is an external submission therefore end in{" "}
        <span className="mono">needs_review</span> with <span className="mono">blockedByPolicy</span>, never in{" "}
        <span className="mono">succeeded</span>.
      </Note>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Registered agents" value={agents.length} hint={`${agents.filter((agent) => agent.is_active === 1).length} active`} />
        <Metric label="Awaiting approval" value={queue.awaitingApproval} tone={queue.awaitingApproval > 0 ? "partial" : "neutral"} />
        <Metric label="Queued" value={queue.byState.queued ?? 0} />
        <Metric
          label="Needs review"
          value={queue.byState.needs_review ?? 0}
          tone={(queue.byState.needs_review ?? 0) > 0 ? "partial" : "neutral"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Register agent" subtitle="Only a secret reference (environment variable name) is stored, never a credential.">
          <div className="p-4">
            <ActionForm action={registerAgentAction} submitLabel="Register agent" resetOnSuccess>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="name">
                    Name
                  </label>
                  <input id="name" name="name" className="input" required />
                </div>
                <div>
                  <label className="field-label" htmlFor="provider">
                    Provider
                  </label>
                  <select id="provider" name="provider" className="select" defaultValue="local_deterministic">
                    {["deepseek", "openai", "anthropic", "google", "local_deterministic", "human_operator", "mcp_generic", "other"].map(
                      (provider) => (
                        <option key={provider} value={provider}>
                          {provider}
                        </option>
                      ),
                    )}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="kind">
                    Kind
                  </label>
                  <select id="kind" name="kind" className="select" defaultValue="ai">
                    <option value="ai">ai</option>
                    <option value="human">human</option>
                    <option value="service">service</option>
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="endpoint">
                    Endpoint (optional)
                  </label>
                  <input id="endpoint" name="endpoint" className="input" />
                </div>
                <div>
                  <label className="field-label" htmlFor="authSecretRef">
                    Secret reference (env var name)
                  </label>
                  <input id="authSecretRef" name="authSecretRef" className="input" placeholder="DEEPSEEK_API_KEY" />
                </div>
                <div>
                  <label className="field-label" htmlFor="contact">
                    Contact / owner
                  </label>
                  <input id="contact" name="contact" className="input" />
                </div>
              </div>
            </ActionForm>
          </div>
        </Panel>

        <Panel title="Execution adapters" subtitle="The only code paths allowed to perform task work.">
          <div className="grid gap-2 p-4">
            <div className="note note-ok">
              <span className="mono">{localAdapter.id}</span> — {localAdapter.description}
              <span className="mono block text-[0.6875rem]">
                canPreflight {String(localAdapter.capabilities.canPreflight)} · canComposePayload{" "}
                {String(localAdapter.capabilities.canComposePayload)} · canSubmitExternally{" "}
                {String(localAdapter.capabilities.canSubmitExternally)} · requiresNetwork{" "}
                {String(localAdapter.capabilities.requiresNetwork)} · requiresCredentials{" "}
                {String(localAdapter.capabilities.requiresCredentials)}
              </span>
            </div>
            <div className="note note-fail">
              <span className="mono">google-forms</span> — fails closed. It refuses to submit unless the deployment
              explicitly records a verified submission capability and injects an authorized transport; without both it
              returns <span className="mono">needs_review</span>.
            </div>
          </div>
        </Panel>
      </div>

      <Panel title={`Agents (${agents.length})`} subtitle="Capabilities are granted explicitly and can be revoked.">
        {agents.length === 0 ? (
          <EmptyState>No agents registered. Register the deterministic local adapter to exercise the workflow first.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Provider</th>
                  <th>Kind</th>
                  <th>Active</th>
                  <th>Secret ref</th>
                  <th>Capabilities</th>
                  <th className="num">Tasks</th>
                  <th>Grant capability</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const capabilities = listCapabilities(db, agent.id).filter((row) => row.revoked_at === null);
                  return (
                    <tr key={agent.id}>
                      <td>{agent.name}</td>
                      <td className="mono">{agent.provider}</td>
                      <td className="text-[0.75rem]">{agent.kind}</td>
                      <td>
                        <Chip tone={agent.is_active === 1 ? "verified" : "blocked"}>
                          {agent.is_active === 1 ? "active" : "inactive"}
                        </Chip>
                      </td>
                      <td className="mono text-[0.6875rem]">{agent.auth_secret_ref ?? "—"}</td>
                      <td>
                        <ul className="grid gap-0.5">
                          {capabilities.length === 0 ? (
                            <li className="text-[0.75rem] text-[#55606d]">none</li>
                          ) : (
                            capabilities.map((capability) => (
                              <li key={capability.id} className="flex items-center gap-1 text-[0.75rem]">
                                <Chip tone={capability.capability === "submit_external_response" ? "partial" : "neutral"}>
                                  {capability.capability}
                                </Chip>
                                <ActionForm
                                  action={revokeCapabilityAction}
                                  submitLabel="revoke"
                                  quiet
                                  hidden={{ capabilityId: capability.id, agentId: agent.id }}
                                  className="inline"
                                >
                                  <span />
                                </ActionForm>
                              </li>
                            ))
                          )}
                        </ul>
                      </td>
                      <td className="num">{agent.task_count}</td>
                      <td>
                        <ActionForm
                          action={grantCapabilityAction}
                          submitLabel="Grant"
                          quiet
                          hidden={{ agentId: agent.id }}
                          className="grid gap-1"
                        >
                          <select name="capability" className="select" defaultValue="preflight_only">
                            {CAPABILITIES.map((capability) => (
                              <option key={capability} value={capability}>
                                {capability}
                              </option>
                            ))}
                          </select>
                          <input name="maxSubmissionsPerDay" className="input" placeholder="max/day (optional)" />
                        </ActionForm>
                      </td>
                      <td>
                        <ActionForm
                          action={toggleAgentAction}
                          submitLabel={agent.is_active === 1 ? "Deactivate" : "Activate"}
                          quiet
                          hidden={{ agentId: agent.id, active: agent.is_active === 1 ? "false" : "true" }}
                          className="inline"
                        >
                          <span />
                        </ActionForm>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Create task" subtitle="Composed from the stored field map and the participant's documented answers.">
        <div className="p-4">
          {studies.length === 0 || formVersions.length === 0 || participants.length === 0 ? (
            <EmptyState>
              A task needs a study, a captured form version and a participant. Study: {studies.length}, form versions:{" "}
              {formVersions.length}, participants: {participants.length}.
            </EmptyState>
          ) : (
            <ActionForm action={createTaskAction} submitLabel="Create task contract">
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="field-label" htmlFor="studyId">
                    Study
                  </label>
                  <select id="studyId" name="studyId" className="select" required>
                    {studies.map((study) => (
                      <option key={study.id} value={study.id}>
                        {study.code}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="participantId">
                    Participant
                  </label>
                  <select id="participantId" name="participantId" className="select" required>
                    {participants.map((participant) => (
                      <option key={participant.id} value={participant.id}>
                        {participant.pseudonym} · consent {participant.consent_status ?? "none"}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="externalFormVersionId">
                    Form version
                  </label>
                  <select id="externalFormVersionId" name="externalFormVersionId" className="select" required>
                    {formVersions.map(({ form, version }) => (
                      <option key={version.id} value={version.id}>
                        {form.title} — {version.version_label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="taskKind">
                    Task kind
                  </label>
                  <select id="taskKind" name="taskKind" className="select" defaultValue="preflight_mapping">
                    {TASK_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="assignedAgentId">
                    Assigned agent (optional)
                  </label>
                  <select id="assignedAgentId" name="assignedAgentId" className="select">
                    <option value="">unassigned</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </ActionForm>
          )}
        </div>
      </Panel>

      <Panel title={`Task queue (${tasks.length})`} subtitle="Approve, queue, run, retry or cancel. Retries respect the attempt budget and the idempotency key.">
        {tasks.length === 0 ? (
          <EmptyState>No tasks yet. Create a task contract above.</EmptyState>
        ) : (
          <div className="grid gap-0">
            {tasks.map((task) => {
              const attempts = listAttempts(db, task.id);
              const evidence = listEvidence(db, task.id);
              const externalSubmission = task.kind === "submit_external_response";
              return (
                <div key={task.id} className="border-b border-[#eef1f4] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-[0.8125rem] font-semibold">
                        {task.kind}{" "}
                        <span className="mono text-[0.75rem] text-[#55606d]">
                          {task.study_code} · {task.pseudonym}
                        </span>
                      </p>
                      <p className="mono mt-0.5 text-[0.6875rem] text-[#55606d]">
                        task {task.id} · idempotency {task.idempotency_key.slice(0, 20)}… · contract{" "}
                        {task.contract_sha256.slice(0, 12)}…
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Chip tone={stateTone(task.state)}>{task.state}</Chip>
                      {task.requires_approval === 1 ? <Chip tone="info">approval required</Chip> : null}
                      {externalSubmission ? <Chip tone="partial">external submission</Chip> : null}
                      <span className="mono text-[0.6875rem] text-[#55606d]">
                        attempts {task.attempt_count}/{task.max_attempts}
                      </span>
                    </div>
                  </div>

                  <div className="mt-2 grid gap-2 lg:grid-cols-[1fr_1fr]">
                    <div className="grid gap-1 text-[0.75rem]">
                      <p>
                        created {formatDateTime(task.created_at)} · expires {formatDateTime(task.expires_at)} ·
                        approved {formatDateTime(task.approved_at)}
                      </p>
                      {task.approval_note ? <p className="text-[#55606d]">approval note: {task.approval_note}</p> : null}
                      {task.last_error ? <p className="text-[#98211f]">last error: {task.last_error}</p> : null}
                      <p className="text-[#55606d]">
                        {attempts.length} attempt(s) · {evidence.length} evidence record(s)
                      </p>
                    </div>
                    <div className="flex flex-wrap items-start gap-1">
                      {task.state === "draft" || task.state === "validated" ? (
                        <ActionForm action={validateTaskAction} submitLabel="Validate" quiet hidden={{ taskId: task.id }} className="inline">
                          <span />
                        </ActionForm>
                      ) : null}
                      {task.requires_approval === 1 && (task.state === "validated" || task.state === "draft") ? (
                        <ActionForm
                          action={approveTaskAction}
                          submitLabel="Approve"
                          quiet
                          hidden={{ taskId: task.id }}
                          className="flex items-center gap-1"
                        >
                          <input name="note" className="input" placeholder="approval note (required)" required />
                        </ActionForm>
                      ) : null}
                      {task.state === "approved" ? (
                        <ActionForm action={queueTaskAction} submitLabel="Queue" quiet hidden={{ taskId: task.id }} className="inline">
                          <span />
                        </ActionForm>
                      ) : null}
                      {task.state === "queued" || task.state === "approved" ? (
                        <ActionForm
                          action={runTaskAction}
                          submitLabel="Run (local deterministic adapter)"
                          quiet
                          hidden={{ taskId: task.id, adapterId: "local-deterministic" }}
                          className="inline"
                        >
                          <span />
                        </ActionForm>
                      ) : null}
                      {task.state === "failed" || task.state === "needs_review" ? (
                        <>
                          <ActionForm action={retryTaskAction} submitLabel="Retry" quiet hidden={{ taskId: task.id }} className="inline">
                            <span />
                          </ActionForm>
                          <ActionForm
                            action={cancelTaskAction}
                            submitLabel="Cancel"
                            quiet
                            hidden={{ taskId: task.id, reason: "closed after review" }}
                            className="inline"
                          >
                            <span />
                          </ActionForm>
                        </>
                      ) : null}
                      <Link href={`/agents/tasks/${task.id}`} className="btn-quiet no-underline">
                        open detail
                      </Link>
                    </div>
                  </div>

                  {attempts.length > 0 ? (
                    <table className="data-table mt-2">
                      <thead>
                        <tr>
                          <th className="num">#</th>
                          <th>Adapter</th>
                          <th>Started</th>
                          <th>Finished</th>
                          <th>Error</th>
                          <th>Retryable</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attempts.map((attempt) => (
                          <tr key={attempt.id}>
                            <td className="num">{attempt.attempt_number}</td>
                            <td className="mono">{attempt.adapter}</td>
                            <td className="mono">{formatDateTime(attempt.started_at)}</td>
                            <td className="mono">{formatDateTime(attempt.finished_at)}</td>
                            <td className="text-[0.75rem] text-[#98211f]">{attempt.error_message ?? "—"}</td>
                            <td>{attempt.retryable === null ? "—" : attempt.retryable === 1 ? "yes" : "no"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
