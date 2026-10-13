import { Cabinet, CabinetError, cabinetConfiguration, type CabinetAccount } from "./cabinet.ts";
import { privateCabinetStore, reserveCabinetAttempt, type CabinetStore } from "./cabinet-store.ts";
import { createSessionToken, sha256 } from "./password.ts";
import { generateSimulation, reliability, reliabilityRequestSchema, simulationConfigSchema, validateSimulation } from "../domain/simulation-lab.ts";
import { parseSource } from "../domain/workbench.ts";
type Config = NonNullable<ReturnType<typeof cabinetConfiguration>>;
interface Grant { accountId: string; fingerprint: string; assetId: string; expires: number }
export interface LabKey { keyId: string; assetId: string; expiresAt: string; revoked: boolean }
export class SimulationLab {
  private cabinet: Cabinet; private prefix: string; private config: Config; private store: CabinetStore; private now: () => number;
  constructor(config: Config, store: CabinetStore = privateCabinetStore(config.storeId), now = Date.now) { this.config = config; this.store = store; this.now = now; this.cabinet = new Cabinet(config, store, now); this.prefix = `rrp/simulation-lab/v1/${config.namespace}/`; }
  private root(account: CabinetAccount) { return `${this.prefix}accounts/${account.id}/`; }
  private async read<T>(path: string): Promise<T | null> { const r = await this.store.read(path); return r ? JSON.parse(r.body) as T : null; }
  async generate(account: CabinetAccount, input: unknown) {
    const config = simulationConfigSchema.parse(input);
    if (!await reserveCabinetAttempt(this.store, `${this.root(account)}daily/${Math.floor(this.now() / 86400000)}.json`, 20)) throw new CabinetError(429, "Лимит 20 генераций в сутки на кабинет.");
    const cohort = generateSimulation(config), text = JSON.stringify(cohort);
    const asset = await this.cabinet.upload(account, { kind: "simulation", name: `simulation-${sha256(text).slice(0, 12)}.json`, reference: "demo-battery-1: математическая демонстрация, ключи не сверены", rights: "Моделируемые данные для проверки программы", base64: Buffer.from(text).toString("base64") });
    return { asset, cohort };
  }
  async cohort(account: CabinetAccount, assetId: string) { const { meta, body } = await this.cabinet.asset(account, assetId); if (meta.kind !== "simulation") throw new CabinetError(400, "Нужен тестовый набор."); return { asset: meta, cohort: validateSimulation(JSON.parse(Buffer.from(body.base64, "base64").toString("utf8"))) }; }
  async measure(account: CabinetAccount, input: unknown) {
    const request = reliabilityRequestSchema.parse(input), { meta, body } = await this.cabinet.asset(account, request.sourceId);
    if (meta.kind !== "source") throw new CabinetError(400, "Нужна база фактических ответов.");
    const data = parseSource(meta.name, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(body.base64, "base64")));
    if (request.scales.some(s => s.columns.some(c => !data.headers.includes(c)))) throw new CabinetError(400, "В базе нет указанного столбца.");
    const rows = data.rows.map(row => Object.fromEntries(data.headers.map((h, i) => [h, row.values[i]])));
    return { schema: "rrp.reliability-report.v1", sourceSha256: meta.sha256, sourceModified: false, missingPolicy: "complete_cases", reports: request.scales.map(s => reliability(rows, s)) };
  }
  async grants(account: CabinetAccount): Promise<LabKey[]> {
    const paths = await this.store.paths(`${this.root(account)}keys/`), records = await Promise.all(paths.map(async p => { const r = await this.read<Omit<LabKey, "revoked">>(p); return r ? { ...r, revoked: !!await this.read(`${this.prefix}revoked/${r.keyId}.json`) } : null; }));
    return records.filter(r => r !== null);
  }
  async key(account: CabinetAccount, assetId: string) {
    await this.cohort(account, assetId);
    if ((await this.grants(account)).filter(g => !g.revoked && Date.parse(g.expiresAt) > this.now()).length >= 20) throw new CabinetError(409, "Отзовите лишние ключи лаборатории.");
    const { token, tokenHash } = createSessionToken(), expires = this.now() + 86400000;
    const meta = { keyId: tokenHash, assetId, expiresAt: new Date(expires).toISOString() };
    await this.store.write(`${this.prefix}grants/${tokenHash}.json`, { accountId: account.id, fingerprint: sha256(JSON.stringify(account.password)), assetId, expires } satisfies Grant);
    await this.store.write(`${this.root(account)}keys/${tokenHash}.json`, meta);
    return { token, ...meta };
  }
  async revoke(account: CabinetAccount, keyId: string) {
    if (!/^[a-f0-9]{64}$/.test(keyId)) throw new CabinetError(400, "Некорректный ключ.");
    const grant = await this.read<Grant>(`${this.prefix}grants/${keyId}.json`);
    if (!grant || grant.accountId !== account.id) throw new CabinetError(404, "Ключ не найден в этом кабинете.");
    if (!await this.read(`${this.prefix}revoked/${keyId}.json`)) await this.store.write(`${this.prefix}revoked/${keyId}.json`, { at: this.now() });
  }
  async forAgent(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CabinetError(401, "Нужен ключ лаборатории.");
    const hash = sha256(token), grant = await this.read<Grant>(`${this.prefix}grants/${hash}.json`), account = grant ? this.config.accounts.find(a => a.id === grant.accountId && sha256(JSON.stringify(a.password)) === grant.fingerprint) : null;
    if (!grant || !account || grant.expires <= this.now() || await this.read(`${this.prefix}revoked/${hash}.json`)) throw new CabinetError(401, "Ключ лаборатории недействителен.");
    return { schema: "rrp.lab-bundle.v1", ...await this.cohort(account, grant.assetId), permissions: { readSimulation: true, mayImportAsObserved: false, mayStartOrSubmit: false }, guide: "/agent-simulation-lab.md", instructions: "Моделируемый тестовый набор. Сохранить seed, версию, условный отбор и происхождение. Не подменять фактические ответы. Ключ только для чтения этого набора; разрешение отправки он не даёт." };
  }
}
export function configuredSimulationLab() { const config = cabinetConfiguration(process.env); if (!config) throw new CabinetError(503, "Кабинет не настроен."); return new SimulationLab(config); }
