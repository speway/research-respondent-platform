/** Private durable jobs. Workflow payloads carry IDs only, never answers or credentials. */
import { randomUUID } from "node:crypto";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { automationRequestSchema, automationResultSchema, automationProgressSchema, formIdentity, type AutomationJob, type AutomationResult, type AutomationView } from "../domain/form-automation.ts";
import { Cabinet, CabinetError, cabinetConfiguration, type CabinetAccount } from "./cabinet.ts";
import { privateCabinetStore, reserveCabinetAttempt, type CabinetStore } from "./cabinet-store.ts";
import { sha256 } from "./password.ts";
import { workspaceFromTask } from "../domain/agent-workbench.ts";
import { selectedRows } from "../domain/workbench.ts";

export const AUTOMATION_LIMITS = { maxDailyRuns: 3, maxJobs: 100, sandboxMs: 300000, vcpus: 1 } as const;
type Config = NonNullable<ReturnType<typeof cabinetConfiguration>>;
export function automationFlags(env: Record<string, string | undefined> = process.env) { return { enabled: env.RRP_FORM_AUTOMATION === "1" && env.VERCEL === "1", writes: env.RRP_FORM_AUTOMATION_WRITE === "1" && env.VERCEL_ENV === "production" }; }
export class FormAutomation {
  private config: Config; private store: CabinetStore; private cabinet: Cabinet; private now: () => number;
  private prefix: string;
  constructor(config: Config, store = privateCabinetStore(config.storeId), now = Date.now) {
    this.config = config; this.store = store; this.cabinet = new Cabinet(config, store, now); this.now = now;
    this.prefix = `rrp/form-automation/v1/${config.namespace}/`;
  }
  private root(accountId: string) { return `${this.prefix}accounts/${accountId}/`; }
  private path(accountId: string, id: string, name: string) { return `${this.root(accountId)}jobs/${id}/${name}.json`; }
  private async read<T>(path: string): Promise<T | null> { const r = await this.store.read(path); return r ? JSON.parse(r.body) as T : null; }
  private async save(path: string, value: unknown) {
    await this.store.write(path, value);
    const stored = await this.read(path); if (sha256(JSON.stringify(stored)) !== sha256(JSON.stringify(value))) throw new Error("Automation persistence unverified.");
  }
  private validAccount(job: AutomationJob) {
    return this.config.accounts.find((a) => a.id === job.accountId && sha256(JSON.stringify(a.password)) === job.fingerprint);
  }
  async job(accountId: string, id: string) {
    if (!this.config.accounts.some((a) => a.id === accountId) || !/^[a-f0-9-]{36}$/.test(id)) throw new CabinetError(404, "Запуск не найден.");
    const job = await this.read<AutomationJob>(this.path(accountId, id, "job"));
    if (!job || job.accountId !== accountId || job.id !== id) throw new CabinetError(404, "Запуск не найден в этом кабинете.");
    return job;
  }
  async candidates(account: CabinetAccount, projectId: string) {
    const bundle = await this.cabinet.bundle(account, projectId);
    const workspace = await workspaceFromTask(bundle.task);
    return { project: bundle.project, sourceChecks: bundle.sourceChecks,
      participants: selectedRows(workspace).map((r) => String(r.values[workspace.idColumn!] ?? "")),
      evidenceFiles: (await this.cabinet.catalog(account)).assets.filter((a) => a.kind === "questionnaire").map(({ id, name }) => ({ id, name })) };
  }
  async reserve(account: CabinetAccount, input: unknown, writesEnabled: boolean) {
    const request = automationRequestSchema.parse(input); const requestHash = sha256(JSON.stringify(request));
    const reservedPath = `${this.root(account.id)}requests/${request.requestId}.json`;
    const prior = await this.read<{ id: string; requestHash: string }>(reservedPath);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new CabinetError(409, "Этот ID запроса уже относится к другому запуску.");
      return this.job(account.id, prior.id);
    }
    if (request.mode !== "prepare" && (!writesEnabled || this.config.namespace !== "production")) throw new CabinetError(403, "Облачный ввод ещё не включён для этого окружения.");
    const bundle = await this.cabinet.bundle(account, request.projectId);
    if (!bundle.sourceChecks.readyForFormObservation) throw new CabinetError(400, "Уточните отбор: в базе нет записей или ID пустые/повторные.");
    const identity = formIdentity(bundle.project.formUrl); const workspace = await workspaceFromTask(bundle.task);
    if (!selectedRows(workspace).some((r) => String(r.values[workspace.idColumn!]) === request.participantRef)) throw new CabinetError(400, "Участник не входит в отбор проекта.");
    const jobs = await this.store.paths(`${this.root(account.id)}jobs/`);
    if (jobs.filter((p) => p.endsWith("/job.json")).length >= AUTOMATION_LIMITS.maxJobs) throw new CabinetError(409, "Достигнут лимит 100 запусков кабинета.");
    let evidence: AutomationJob["evidence"];
    if (request.mode !== "prepare") {
      const file = await this.cabinet.asset(account, request.evidenceAssetId!);
      if (file.meta.kind !== "questionnaire") throw new CabinetError(400, "Прикрепите документ основания/согласия отдельно от базы ответов.");
      evidence = { id: file.meta.id, sha256: file.meta.sha256 };
    }
    const job: AutomationJob = { id: randomUUID(), accountId: account.id, fingerprint: sha256(JSON.stringify(account.password)),
      request, sourceSha256: bundle.source.sha256, formUrl: bundle.project.formUrl, formIdentity: identity,
      createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 30 * 60000).toISOString(), requestHash,
      projectName: bundle.project.name, ...(evidence ? { evidence } : {}) };
    // Reserve before publishing job/launch: failure must not create a second request.
    try { await this.save(reservedPath, { id: job.id, requestHash }); }
    catch (error) {
      if (error instanceof BlobPreconditionFailedError) {
        const winner = await this.read<{ id: string; requestHash: string }>(reservedPath);
        if (winner?.requestHash === requestHash) return this.job(account.id, winner.id);
      }
      throw error;
    }
    await this.save(this.path(account.id, job.id, "job"), job);
    return job;
  }
  async dispatch(job: AutomationJob, launch: (accountId: string, jobId: string) => Promise<string>) {
    const registered = await this.read<{ runId: string }>(this.path(job.accountId, job.id, "run"));
    if (registered) return this.view(job.accountId, job.id);
    const path = this.path(job.accountId, job.id, "dispatch");
    if (await this.read(path)) return this.view(job.accountId, job.id);
    if (Date.parse(job.expiresAt) <= this.now() || !this.validAccount(job) || await this.cancelled(job)) throw new CabinetError(403, "Полномочия запуска истекли, изменились или отозваны.");
    try { await this.save(path, { at: this.now() }); }
    catch (error) { if (error instanceof BlobPreconditionFailedError) return this.view(job.accountId, job.id); throw error; }
    if (!await reserveCabinetAttempt(this.store, `${this.prefix}daily/${Math.floor(this.now() / 86400000)}.json`, AUTOMATION_LIMITS.maxDailyRuns)) {
      await this.fail(job, "failed"); throw new CabinetError(429, "Дневной лимит: три облачных запуска по пять минут.");
    }
    // If registration/save is uncertain, dispatch remains reserved: no second Workflow.
    const runId = await launch(job.accountId, job.id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(runId)) throw new Error("Invalid workflow registration.");
    await this.save(this.path(job.accountId, job.id, "run"), { runId });
    return this.view(job.accountId, job.id);
  }
  async begin(accountId: string, jobId: string, writesEnabled: boolean) {
    const job = await this.job(accountId, jobId);
    if (!this.validAccount(job)) throw new CabinetError(403, "Полномочия запуска изменились.");
    if (Date.parse(job.expiresAt) <= this.now() || await this.cancelled(job)) throw new CabinetError(403, "Запуск истёк или отменён.");
    if (job.request.mode !== "prepare" && (!writesEnabled || this.config.namespace !== "production")) throw new CabinetError(403, "Облачный ввод отключён.");
    const account = this.validAccount(job)!; const bundle = await this.cabinet.bundle(account, job.request.projectId);
    if (bundle.source.sha256 !== job.sourceSha256 || bundle.project.formUrl !== job.formUrl || !bundle.sourceChecks.readyForFormObservation) throw new CabinetError(409, "Источник или получатель не совпадает с запуском.");
    if (job.evidence && (await this.cabinet.asset(account, job.evidence.id)).meta.sha256 !== job.evidence.sha256) throw new CabinetError(409, "Документ основания изменился.");
    const workspace = await workspaceFromTask(bundle.task);
    const row = selectedRows(workspace).find((r) => String(r.values[workspace.idColumn!]) === job.request.participantRef);
    if (!row) throw new CabinetError(409, "Участник больше не входит в отбор.");
    await this.save(this.path(accountId, jobId, "started"), { at: this.now() });
    return { job, task: { ...bundle.task, sourceRows: [row.line] }, grant: job.request.mode === "prepare" ? null : {
      formUrl: job.formUrl, participantRef: job.request.participantRef, sourceSha256: job.sourceSha256,
      evidenceReference: job.request.evidenceReference!, expiresAt: job.expiresAt,
      mayFill: true, maySubmit: job.request.mode === "submit", maxSubmissions: 1 } };
  }
  private receiptPath(job: AutomationJob) {
    // Account-independent, source-independent lock; harmless query variants cannot bypass it.
    return `${this.prefix}submissions/${sha256(JSON.stringify([job.formIdentity, job.request.participantRef]))}.json`;
  }
  async claimSubmission(job: AutomationJob, key: string) {
    if (job.request.mode !== "submit" || Date.parse(job.expiresAt) <= this.now() || await this.cancelled(job) || !this.validAccount(job)) return false;
    const expected = sha256(JSON.stringify([job.formUrl, job.request.participantRef, job.sourceSha256]));
    if (key !== expected) throw new Error("Receipt scope mismatch.");
    try { await this.save(this.receiptPath(job), { jobId: job.id, accountId: job.accountId, sourceSha256: job.sourceSha256, reservedAt: new Date(this.now()).toISOString() }); }
    catch (error) { if (error instanceof BlobPreconditionFailedError) return false; throw error; }
    await this.save(this.path(job.accountId, job.id, "submission"), { reserved: true });
    return true;
  }
  async finish(job: AutomationJob, input: unknown) {
    let result = automationResultSchema.parse(input);
    const claimed = !!await this.read(this.path(job.accountId, job.id, "submission"));
    if (claimed && result.externalSubmission === false) result = automationResultSchema.parse({ ...result,
      status: "submission_uncertain", externalSubmission: "unknown", problems: ["Отправка была разрешена журналом, но подтверждение не получено. Повтор запрещён."] });
    if ((result.externalSubmission !== false) && (job.request.mode !== "submit" || !claimed)) throw new Error("Submission receipt without durable claim.");
    if (result.status === "filled_not_submitted" && job.request.mode === "prepare") throw new Error("Read-only job cannot fill.");
    await this.save(this.path(job.accountId, job.id, "result"), result);
    return result;
  }
  async fail(job: AutomationJob, status: "failed" | "cancelled") {
    if (await this.read(this.path(job.accountId, job.id, "result"))) return;
    const uncertain = !!await this.read(this.path(job.accountId, job.id, "submission"));
    const path = this.path(job.accountId, job.id, "failure");
    if (!await this.read(path)) await this.save(path, { status: uncertain ? "execution_uncertain" : status, at: new Date(this.now()).toISOString() });
  }
  async cancelled(job: AutomationJob) { return !!await this.read(this.path(job.accountId, job.id, "cancel")); }
  async progress(job: AutomationJob, input: unknown) {
    const progress = automationProgressSchema.parse(input), path = this.path(job.accountId, job.id, "progress");
    const previous = await this.store.read(path);
    if (previous?.body === JSON.stringify(progress)) return;
    await this.store.write(path, progress, previous?.etag);
  }
  async cancel(account: CabinetAccount, id: string) {
    const job = await this.job(account.id, id); const current = await this.view(account.id, id);
    if (current.result || ["failed", "cancelled", "execution_uncertain"].includes(current.status)) return current;
    if (!await this.cancelled(job)) await this.save(this.path(account.id, id, "cancel"), { at: this.now() });
    return this.view(account.id, id);
  }
  async view(accountId: string, id: string): Promise<AutomationView> {
    const job = await this.job(accountId, id);
    const [run, started, result, failure, cancelled, dispatch, progress] = await Promise.all([
      this.read<{ runId: string }>(this.path(accountId, id, "run")), this.read(this.path(accountId, id, "started")),
      this.read<AutomationResult>(this.path(accountId, id, "result")), this.read<{ status: "failed" | "cancelled" | "execution_uncertain" }>(this.path(accountId, id, "failure")),
      this.cancelled(job), this.read(this.path(accountId, id, "dispatch")),
      this.read(this.path(accountId, id, "progress")),
    ]);
    return { id, projectId: job.request.projectId, projectName: job.projectName, participantRef: job.request.participantRef,
      mode: job.request.mode, createdAt: job.createdAt, expiresAt: job.expiresAt,
      status: result?.status ?? failure?.status ?? (cancelled ? "cancellation_requested" : started ? "running" : run ? "queued" : dispatch ? "execution_uncertain" : "reserved"),
      ...(run ? { runId: run.runId } : {}), ...(result ? { result: automationResultSchema.parse(result) } : {}),
      ...(progress ? { progress: automationProgressSchema.parse(progress) } : {}), retryAllowed: false };
  }
  async list(account: CabinetAccount, projectId?: string) {
    const paths = await this.store.paths(`${this.root(account.id)}jobs/`);
    const jobs = await Promise.all(paths.filter((p) => p.endsWith("/job.json")).map(async (p) => {
      const job = await this.read<AutomationJob>(p); return job && (!projectId || job.request.projectId === projectId) ? this.view(account.id, job.id) : null;
    }));
    return jobs.filter((j) => j !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async agentJobs(scope: { accountId: string; projectId: string }) {
    const account = this.config.accounts.find((a) => a.id === scope.accountId);
    if (!account) throw new CabinetError(401, "Ключ недействителен.");
    return this.list(account, scope.projectId);
  }
}
export function configuredAutomation() {
  const config = cabinetConfiguration(process.env);
  if (!config) throw new CabinetError(503, "Кабинет не подключён.");
  return new FormAutomation(config);
}
