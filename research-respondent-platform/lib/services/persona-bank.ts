/** Full persona envelopes live outside observed sources and Quorum participant records. */
import { BlobPreconditionFailedError } from "@vercel/blob";
import { z } from "zod";
import { validatePersonaCohort, validatePersonaJob, runPersonaJob, type PersonaJob, type PersonaTransport } from "../domain/personas.ts";
import { PERSONA_BANK_LIMITS as limits, type PersonaAsset, type PersonaEnvelope, type PersonaBankJob, type PersonaJobView, type PersonaReadKey } from "../domain/persona-bank.ts";
import { CabinetError, cabinetConfiguration, type CabinetAccount } from "./cabinet.ts";
import { privateCabinetStore, reserveCabinetAttempt, type CabinetStore } from "./cabinet-store.ts";
import { createSessionToken, sha256 } from "./password.ts";
type Config = NonNullable<ReturnType<typeof cabinetConfiguration>>;
interface Grant { accountId: string; fingerprint: string; cohortId: string; expires: number }
export function personaWorkerEnabled(env: Record<string, string | undefined> = process.env) { return env.VERCEL === "1" && env.RRP_PERSONA_WORKER === "1"; }
export class PersonaBank {
  private prefix: string;
  private config: Config; private store: CabinetStore; private now: () => number;
  constructor(config: Config, store: CabinetStore = privateCabinetStore(config.storeId), now = Date.now) { this.config=config;this.store=store;this.now=now;this.prefix = `rrp/modeled_personas/v1/${config.namespace}/`; }
  private root(accountId: string) {
    if (!this.config.accounts.some(a => a.id === accountId)) throw new CabinetError(404, "Кабинет не найден.");
    return `${this.prefix}accounts/${accountId}/`;
  }
  private path(accountId: string, id: string, record: string) { z.string().uuid().parse(id); return `${this.root(accountId)}jobs/${id}/${record}.json`; }
  private async read<T>(path: string): Promise<T | null> { const r = await this.store.read(path); return r ? JSON.parse(r.body) as T : null; }
  private async save(path: string, value: unknown) {
    if (Buffer.byteLength(JSON.stringify(value)) > 3 * 1024 * 1024) throw new CabinetError(413, "Разделите набор персон.");
    await this.store.write(path, value);
    if (sha256(JSON.stringify(await this.read(path))) !== sha256(JSON.stringify(value))) throw new Error("Persona storage readback failed.");
  }
  private account(job: PersonaBankJob) { return this.config.accounts.find(a => a.id === job.accountId && sha256(JSON.stringify(a.password)) === job.fingerprint); }
  private check(cohort: unknown) {
    if (Buffer.byteLength(JSON.stringify(cohort)) > limits.bytes) throw new CabinetError(413, "Набор персон превышает 2 МБ.");
    validatePersonaCohort(cohort);
    if (cohort.personas.length > limits.personas) throw new CabinetError(400, "До 100 персон в одной версии.");
    return cohort;
  }
  async envelope(account: CabinetAccount, id: string) {
    z.string().uuid().parse(id);
    const saved = await this.read<PersonaEnvelope>(`${this.root(account.id)}cohorts/${id}.json`);
    if (!saved) throw new CabinetError(404, "Версия персон не найдена в этом кабинете.");
    this.check(saved.cohort);
    if (saved.schema !== "rrp.modeled-personas.v1" || saved.asset.id !== id || saved.asset.kind !== "modeled_persona" || saved.asset.data_origin !== "modeled" || saved.asset.sha256 !== sha256(JSON.stringify(saved.cohort)) || saved.asset.count !== saved.cohort.personas.length || saved.asset.modelVersion !== saved.cohort.model_version) throw new Error("Persona envelope integrity failed.");
    return saved;
  }
  async catalog(account: CabinetAccount) {
    const paths = await this.store.paths(`${this.root(account.id)}index/`);
    const assets = await Promise.all(paths.map(p => this.read<PersonaAsset>(p)));
    return assets.filter(a=>a!==null).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async index(account: CabinetAccount, envelope: PersonaEnvelope) {
    const path=`${this.root(account.id)}index/${envelope.asset.id}.json`;
    if(!await this.read(path)) { try { await this.save(path,envelope.asset); } catch(error) { if(!(error instanceof BlobPreconditionFailedError)) throw error; } }
    if(JSON.stringify(await this.read(path))!==JSON.stringify(envelope.asset)) throw new Error("Persona index integrity failed.");
    return envelope;
  }
  private async capacity(account: CabinetAccount) { if ((await this.catalog(account)).length >= limits.versions) throw new CabinetError(409, "Лимит 100 версий персон. Экспортируйте банк перед расширением."); }
  private async persist(account: CabinetAccount, id: string, name: string, cohort: unknown, parent: PersonaAsset["parent"]) {
    const value = this.check(cohort), path = `${this.root(account.id)}cohorts/${z.string().uuid().parse(id)}.json`;
    const prior = await this.read<PersonaEnvelope>(path), hash = sha256(JSON.stringify(value));
    if (prior) {
      if (prior.asset.sha256 !== hash || prior.asset.name !== name || JSON.stringify(prior.asset.parent) !== JSON.stringify(parent)) throw new CabinetError(409, "ID уже связан с другой версией персон.");
      return this.index(account,await this.envelope(account, id));
    }
    await this.capacity(account);
    if(!await reserveCabinetAttempt(this.store,`${this.root(account.id)}version-budget.json`,limits.versions)) throw new CabinetError(409,"Лимит версий или одновременное сохранение. Обновите каталог.");
    const envelope: PersonaEnvelope = { schema: "rrp.modeled-personas.v1", cohort: value, asset: { id, name, kind: "modeled_persona", createdAt: new Date(this.now()).toISOString(), sha256: hash, count: value.personas.length, modelVersion: value.model_version, data_origin: "modeled", parent } };
    try { await this.save(path, envelope); }
    catch (error) { if (!(error instanceof BlobPreconditionFailedError)) throw error;
      const winner = await this.envelope(account, id);
      if (winner.asset.sha256 !== hash || winner.asset.name !== name || JSON.stringify(winner.asset.parent) !== JSON.stringify(parent)) throw new CabinetError(409, "Конфликт версии персон."); }
    return this.index(account,await this.envelope(account, id));
  }
  async import(account: CabinetAccount, id: string, name: string, cohort: unknown) { return this.persist(account, id, name, cohort, null); }
  async reserve(account: CabinetAccount, input: { requestId: string; name: string; operation: "generate" | "adapt"; parameters: unknown; cohortId?: string }) {
    const parent = input.operation === "adapt" ? await this.envelope(account, input.cohortId!) : null;
    const job: PersonaJob = { protocol_version: "1", request_id: input.requestId, data_origin: "modeled", ...(input.operation === "generate" ? { operation: "generate", parameters: input.parameters as never } : { operation: "adapt", parameters: input.parameters as never, cohort: parent!.cohort }) };
    validatePersonaJob(job);
    if ((job.operation === "generate" ? job.parameters.count : job.cohort.personas.length) > limits.personas) throw new CabinetError(400, "До 100 персон на запуск.");
    const path = this.path(account.id, input.requestId, "job"), requestHash = sha256(JSON.stringify(input));
    const prior = await this.read<PersonaBankJob>(path);
    if (prior) { if (prior.requestHash !== requestHash) throw new CabinetError(409, "ID запроса занят другим запуском."); return prior; }
    if ((await this.store.paths(`${this.root(account.id)}jobs/`)).filter(p => p.endsWith("/job.json")).length >= 100) throw new CabinetError(409, "Лимит 100 запусков.");
    await this.capacity(account);
    const record: PersonaBankJob = { id: input.requestId, accountId: account.id, fingerprint: sha256(JSON.stringify(account.password)), requestHash, name: input.name, operation: input.operation, parameters: job.parameters, parent: parent ? { id: parent.asset.id, sha256: parent.asset.sha256 } : null, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 30 * 60000).toISOString() };
    try { await this.save(path, record); } catch (error) { if (!(error instanceof BlobPreconditionFailedError)) throw error; const winner = await this.job(account.id, input.requestId); if (winner.requestHash !== requestHash) throw new CabinetError(409, "Конфликт запуска."); return winner; }
    return record;
  }
  async job(accountId: string, id: string) { const job = await this.read<PersonaBankJob>(this.path(accountId, id, "job")); if (!job || job.id !== id || job.accountId !== accountId) throw new CabinetError(404, "Запуск не найден."); return job; }
  async cancelled(job: PersonaBankJob) { return !!await this.read(this.path(job.accountId, job.id, "cancel")); }
  async allowed(job: PersonaBankJob) { if (!this.account(job) || Date.parse(job.expiresAt) <= this.now() || await this.cancelled(job)) throw new CabinetError(403, "Запуск отменён, истёк или полномочия изменились."); }
  async dispatch(job: PersonaBankJob, launch: (accountId: string, id: string) => Promise<string>) {
    await this.allowed(job);
    try { await this.save(this.path(job.accountId, job.id, "dispatch"), { at: this.now() }); }
    catch (error) { if (error instanceof BlobPreconditionFailedError) return this.view(job.accountId, job.id); throw error; }
    try {
      if (!await reserveCabinetAttempt(this.store, `${this.prefix}daily/${Math.floor(this.now()/86400000)}.json`, limits.dailyRuns)) throw new CabinetError(429, "Лимит пяти запусков Python в сутки.");
      const runId = await launch(job.accountId, job.id);
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(runId)) throw new Error("Invalid Workflow run ID.");
      await this.save(this.path(job.accountId, job.id, "run"), { runId });
    } catch (error) { if (error instanceof CabinetError) await this.fail(job); throw error; }
    return this.view(job.accountId, job.id);
  }
  async execute(accountId: string, id: string, transport: PersonaTransport) {
    const record = await this.job(accountId, id); await this.allowed(record);
    // Create-only lease precedes VM allocation: Workflow replay cannot allocate twice.
    await this.save(this.path(accountId, id, "started"), { at: this.now() });
    const account = this.account(record)!;
    try {
      const parent = record.parent ? await this.envelope(account, record.parent.id) : null;
      if (parent && parent.asset.sha256 !== record.parent!.sha256) throw new Error("Persona parent changed.");
      const job: PersonaJob = { protocol_version: "1", request_id: id, data_origin: "modeled", ...(record.operation === "generate" ? { operation: "generate", parameters: record.parameters as never } : { operation: "adapt", cohort: parent!.cohort, parameters: record.parameters as never }) };
      const result = await runPersonaJob(job, transport);
      await this.allowed(record);
      await this.persist(account, id, record.name, result.cohort, record.parent);
      return this.view(accountId, id);
    } catch (error) { await this.fail(record); throw error; }
  }
  async fail(job: PersonaBankJob) { const path = this.path(job.accountId, job.id, "failure"); if (!await this.read(path)) await this.save(path, { status: await this.cancelled(job) ? "cancelled" : "failed" }); }
  async cancel(account: CabinetAccount, id: string) { const job = await this.job(account.id,id); const view = await this.view(account.id,id); if (view.status === "completed") return view; if (!await this.cancelled(job)) { try { await this.save(this.path(account.id,id,"cancel"), { at: this.now() }); } catch (e) { if (!(e instanceof BlobPreconditionFailedError)) throw e; } } return this.view(account.id,id); }
  async view(accountId: string, id: string): Promise<PersonaJobView> {
    const job = await this.job(accountId,id);
    const [asset, failure, cancel, started, run, dispatch] = await Promise.all([this.read(`${this.root(accountId)}index/${id}.json`), this.read<{status:"failed"|"cancelled"}>(this.path(accountId,id,"failure")), this.cancelled(job), this.read(this.path(accountId,id,"started")), this.read(this.path(accountId,id,"run")), this.read(this.path(accountId,id,"dispatch"))]);
    const expired = Date.parse(job.expiresAt) <= this.now();
    return { id, name: job.name, createdAt: job.createdAt, expiresAt: job.expiresAt, status: asset ? "completed" : failure?.status ?? (cancel ? "cancelled" : expired ? dispatch ? "execution_uncertain" : "failed" : started ? "running" : run ? "queued" : dispatch ? "execution_uncertain" : "reserved"), retryAllowed: false, ...(asset ? {assetId:id} : {}) };
  }
  async jobs(account: CabinetAccount) { const paths = await this.store.paths(`${this.root(account.id)}jobs/`); return Promise.all(paths.filter(p => p.endsWith("/job.json")).map(p => this.view(account.id,p.split("/").at(-2)!))); }
  async grants(account: CabinetAccount): Promise<PersonaReadKey[]> { const paths = await this.store.paths(`${this.root(account.id)}keys/`); return Promise.all(paths.map(async p => { const record = (await this.read<Omit<PersonaReadKey,"revoked">>(p))!; return {...record, revoked: !!await this.read(`${this.prefix}revoked/${record.keyId}.json`)}; })); }
  async key(account: CabinetAccount, cohortId: string) {
    await this.envelope(account,cohortId);
    if ((await this.grants(account)).filter(k => !k.revoked && Date.parse(k.expiresAt) > this.now()).length >= 20) throw new CabinetError(409,"Отзовите лишние ключи персон.");
    const {token,tokenHash} = createSessionToken(), expires = this.now()+86400000;
    const meta = {keyId:tokenHash, cohortId, expiresAt:new Date(expires).toISOString()};
    await this.save(`${this.prefix}grants/${tokenHash}.json`, {accountId:account.id, fingerprint:sha256(JSON.stringify(account.password)), cohortId, expires} satisfies Grant);
    await this.save(`${this.root(account.id)}keys/${tokenHash}.json`,meta); return {token,...meta};
  }
  async revoke(account: CabinetAccount, keyId: string) { z.string().regex(/^[a-f0-9]{64}$/).parse(keyId); const grant = await this.read<Grant>(`${this.prefix}grants/${keyId}.json`); if (!grant || grant.accountId !== account.id) throw new CabinetError(404,"Ключ не найден."); if (!await this.read(`${this.prefix}revoked/${keyId}.json`)) await this.save(`${this.prefix}revoked/${keyId}.json`,{at:this.now()}); }
  async forAgent(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CabinetError(401,"Нужен ключ персон.");
    const hash = sha256(token), grant = await this.read<Grant>(`${this.prefix}grants/${hash}.json`), account = grant ? this.config.accounts.find(a=>a.id===grant.accountId && sha256(JSON.stringify(a.password))===grant.fingerprint) : null;
    if (!grant || !account || grant.expires<=this.now() || await this.read(`${this.prefix}revoked/${hash}.json`)) throw new CabinetError(401,"Ключ персон недействителен.");
    return {schema:"rrp.persona-bundle.v1", envelope:await this.envelope(account,grant.cohortId), permissions:{readModeledPersonas:true,mayImportAsObserved:false,mayStartOrSubmit:false},guide:"/agent-personas.md"};
  }
}
export function configuredPersonaBank() { const config = cabinetConfiguration(process.env); if (!config) throw new CabinetError(503,"Кабинет не настроен."); return new PersonaBank(config); }
