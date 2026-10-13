import { z } from "zod";
export const simulationConfigSchema = z.object({ seed: z.string().trim().min(1).max(100), count: z.number().int().min(10).max(250).default(50), conditionOnAlpha: z.boolean().default(false), minAlpha: z.number().min(-5).max(1).default(.5), maxAlpha: z.number().min(-5).max(1).default(.7), maxAttempts: z.number().int().min(1).max(500).default(250) }).strict().refine(c => c.minAlpha <= c.maxAlpha, "Некорректный диапазон альфы.");
export const reliabilityScaleSchema = z.object({ name: z.string().trim().min(1).max(200), columns: z.array(z.string().min(1).max(1000)).min(2).max(2000), reverseColumns: z.array(z.string().min(1).max(1000)).max(2000).default([]), low: z.number().finite(), high: z.number().finite() }).strict().refine(s => s.high > s.low && Number.isFinite(s.low + s.high) && new Set(s.columns).size === s.columns.length && new Set(s.reverseColumns).size === s.reverseColumns.length && s.reverseColumns.every(c => s.columns.includes(c)), "Проверьте диапазон и ключи шкалы.");
export type ReliabilityScale = z.output<typeof reliabilityScaleSchema>;
export const reliabilityRequestSchema = z.object({ sourceId: z.string().uuid(), scales: z.array(reliabilityScaleSchema).min(1).max(50) }).strict();
export const simulationCommandSchema = z.discriminatedUnion("command", [z.object({ command: z.literal("generate"), config: simulationConfigSchema }).strict(), z.object({ command: z.literal("reliability"), request: reliabilityRequestSchema }).strict(), z.object({ command: z.literal("agent_key"), assetId: z.string().uuid() }).strict(), z.object({ command: z.literal("revoke_key"), keyId: z.string().regex(/^[a-f0-9]{64}$/) }).strict()]);
const reportSchema = z.object({ name: z.string(), alpha: z.number().finite().nullable(), reason: z.enum(["insufficient_rows", "zero_total_variance"]).nullable(), items: z.number().int().nonnegative(), inputRows: z.number().int().nonnegative(), completeRows: z.number().int().nonnegative(), missingRows: z.number().int().nonnegative(), invalidRows: z.number().int().nonnegative(), constantColumns: z.array(z.string()), reverseColumns: z.array(z.string()), missingPolicy: z.literal("complete_cases") }).strict();
export type ReliabilityReport = z.output<typeof reportSchema>;
export function cronbachAlpha(matrix: number[][]) {
  const n = matrix.length, k = matrix[0]?.length ?? 0;
  if (matrix.some(row => row.length !== k || row.some(v => !Number.isFinite(v)))) throw new TypeError("Нужна прямоугольная числовая матрица.");
  if (n < 2 || k < 2) return { alpha: null, reason: "insufficient_rows" as const, constantIndexes: [] as number[] };
  const variance = (values: number[]) => { const mean = values.reduce((a, b) => a + b, 0) / n; return values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1); };
  const vars = Array.from({ length: k }, (_, i) => variance(matrix.map(row => row[i]!))), total = variance(matrix.map(row => row.reduce((a, b) => a + b, 0))), constantIndexes = vars.flatMap((v, i) => v === 0 ? [i] : []);
  if (!Number.isFinite(total) || vars.some(v => !Number.isFinite(v))) throw new TypeError("Переполнение расчёта.");
  if (total === 0) return { alpha: null, reason: "zero_total_variance" as const, constantIndexes };
  const alpha = k / (k - 1) * (1 - vars.reduce((a, b) => a + b, 0) / total);
  if (!Number.isFinite(alpha)) throw new TypeError("Переполнение расчёта.");
  return { alpha, reason: null, constantIndexes };
}
export function reliability(rows: Array<Record<string, unknown>>, input: unknown): ReliabilityReport {
  const s = reliabilityScaleSchema.parse(input), reverse = new Set(s.reverseColumns), matrix: number[][] = []; let missingRows = 0, invalidRows = 0;
  for (const row of rows) { let missing = false, invalid = false; const values = s.columns.map(c => { const raw = row[c]; if (raw === null || raw === undefined || typeof raw === "string" && raw.trim() === "") { missing = true; return 0; }
    const v = typeof raw === "number" ? raw : typeof raw === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v < s.low || v > s.high) invalid = true;
    return reverse.has(c) ? s.low + s.high - v : v; });
    if (invalid) invalidRows++; else if (missing) missingRows++; else matrix.push(values);
  }
  const result = cronbachAlpha(matrix);
  return { name: s.name, alpha: result.alpha, reason: result.reason, items: s.columns.length, inputRows: rows.length, completeRows: matrix.length, missingRows, invalidRows, constantColumns: result.constantIndexes.map(i => s.columns[i]!), reverseColumns: s.reverseColumns, missingPolicy: "complete_cases" };
}
const columns = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}_${i + 1}`);
export const DEMO_SCALES: ReliabilityScale[] = [
  { name: "Демо СОКОЛ 1", columns: columns("demo_sokol1", 14), reverseColumns: [], low: 1, high: 5 },
  { name: "Демо СОКОЛ 2", columns: columns("demo_sokol2", 15), reverseColumns: [], low: 1, high: 5 },
  { name: "Демо СОКОЛ 3", columns: columns("demo_sokol3", 10), reverseColumns: [], low: 1, high: 5 },
  { name: "Демо OCS ACS", columns: columns("demo_acs", 6), reverseColumns: ["demo_acs_3", "demo_acs_4", "demo_acs_5"], low: 1, high: 7 },
  { name: "Демо OCS CCS", columns: columns("demo_ccs", 6), reverseColumns: [], low: 1, high: 7 },
  { name: "Демо OCS NCS", columns: columns("demo_ncs", 6), reverseColumns: ["demo_ncs_1"], low: 1, high: 7 },
];
const means = [3.3, 3.4, 3.5, 4.2, 4, 4.1] as const;
const rowSchema = z.object({ id: z.string().regex(/^SIM-\d{4}$/), data_origin: z.literal("modeled"), demographics: z.object({ age: z.number().int().min(22).max(58), gender: z.enum(["female", "male"]), industryCode: z.string().regex(/^industry_[1-9]$/), totalTenureYears: z.number().int().min(0).max(40), currentTenureYears: z.number().int().min(0).max(40), positionCode: z.string().regex(/^position_[1-4]$/) }).strict().refine(d => d.currentTenureYears <= d.totalTenureYears && d.totalTenureYears <= d.age - 18), answers: z.record(z.string(), z.union([z.number().int(), z.enum(["A", "B", "C", "D"])])) }).strict();
const parameters = { sokolLoading: .36, commitmentLoading: .46, generalSd: .65, sokolFactorResidualSd: .55, commitmentFactorResidualSd: .65, continuationFactorSd: .85, cultureDominantProbability: .65, cultureSecondaryProbability: .2, itemMeans: means };
export const simulationCohortSchema = z.object({ schema: z.literal("rrp.simulation-cohort.v1"), data_origin: z.literal("modeled"), generatorVersion: z.literal("demo-battery-1"), purpose: z.literal("isolated_software_simulation"), config: simulationConfigSchema, attempts: z.number().int().min(1).max(500), targetReached: z.boolean().nullable(), rows: z.array(rowSchema).min(10).max(250), reports: z.array(reportSchema).length(6), scaleDefinitions: z.array(reliabilityScaleSchema).length(6), modelParameters: z.object({ sokolLoading: z.literal(.36), commitmentLoading: z.literal(.46), generalSd: z.literal(.65), sokolFactorResidualSd: z.literal(.55), commitmentFactorResidualSd: z.literal(.65), continuationFactorSd: z.literal(.85), cultureDominantProbability: z.literal(.65), cultureSecondaryProbability: z.literal(.2), itemMeans: z.tuple(means.map(v => z.literal(v)) as [z.ZodLiteral<3.3>, z.ZodLiteral<3.4>, z.ZodLiteral<3.5>, z.ZodLiteral<4.2>, z.ZodLiteral<4>, z.ZodLiteral<4.1>]) }).strict(), limitations: z.array(z.string().min(1).max(1000)).min(1).max(20) }).strict().refine(c => c.rows.length === c.config.count && new Set(c.rows.map(r => r.id)).size === c.rows.length && c.attempts <= c.config.maxAttempts && c.rows.every(r => Object.keys(r.answers).length === 68 && DEMO_SCALES.every(s => s.columns.every(k => typeof r.answers[k] === "number" && Number(r.answers[k]) >= s.low && Number(r.answers[k]) <= s.high)) && columns("demo_culture", 11).every(k => ["A", "B", "C", "D"].includes(String(r.answers[k])))), "Несогласованный тестовый набор.");
export type SimulationCohort = z.output<typeof simulationCohortSchema>;
function rng(seed: string) { let n = 2166136261; for (const c of seed) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0; return () => { n = (n + 0x6d2b79f5) >>> 0; let t = Math.imul(n ^ n >>> 15, 1 | n); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function generateSimulation(input: unknown): SimulationCohort {
  const config = simulationConfigSchema.parse(input), random = rng(config.seed), int = (a: number, b: number) => a + Math.floor(random() * (b - a + 1)), normal = (sd = 1) => Math.sqrt(-2 * Math.log(Math.max(random(), Number.MIN_VALUE))) * Math.cos(2 * Math.PI * random()) * sd;
  let rows: SimulationCohort["rows"] = [], reports: ReliabilityReport[] = [], attempts = 0, targetReached: boolean | null = config.conditionOnAlpha ? false : null;
  do { attempts++; rows = Array.from({ length: config.count }, (_, i) => {
    const p = random(), age = p < .15 ? int(22, 25) : p < .6 ? int(26, 35) : p < .9 ? int(36, 48) : int(49, 58), totalTenureYears = int(0, age - 18), currentTenureYears = int(0, totalTenureYears), g = normal(.65), gc = normal(.65), factors = [g + normal(.55), g + normal(.55), g + normal(.55), gc + normal(.65), normal(.85), gc + normal(.65)], answers: Record<string, number | "A" | "B" | "C" | "D"> = {};
    DEMO_SCALES.forEach((s, index) => { const load = index < 3 ? .36 : .46, spread = index < 3 ? 1 : 1.35; for (const key of s.columns) { let v = Math.min(s.high, Math.max(s.low, Math.round(means[index]! + spread * (load * factors[index]! + Math.sqrt(1 - load ** 2) * normal())))); if (s.reverseColumns.includes(key)) v = s.low + s.high - v; answers[key] = v; } });
    const dominant = int(0, 3), secondary = (dominant + int(1, 2)) % 4; for (const key of columns("demo_culture", 11)) { const q = random(); answers[key] = (["A", "B", "C", "D"] as const)[q < .65 ? dominant : q < .85 ? secondary : int(0, 3)]!; }
    return { id: `SIM-${String(i + 1).padStart(4, "0")}`, data_origin: "modeled" as const, demographics: { age, totalTenureYears, currentTenureYears, gender: random() < .5 ? "female" as const : "male" as const, industryCode: `industry_${int(1, 9)}`, positionCode: `position_${int(1, 4)}` }, answers };
  }); reports = DEMO_SCALES.map(s => reliability(rows.map(r => r.answers), s));
    if (config.conditionOnAlpha) targetReached = reports.every(r => r.alpha !== null && r.alpha >= config.minAlpha && r.alpha <= config.maxAlpha);
  } while (config.conditionOnAlpha && !targetReached && attempts < config.maxAttempts);
  return simulationCohortSchema.parse({ schema: "rrp.simulation-cohort.v1", data_origin: "modeled", generatorVersion: "demo-battery-1", purpose: "isolated_software_simulation", config, attempts, targetReached, rows, reports, scaleDefinitions: DEMO_SCALES, modelParameters: parameters, limitations: ["Демонстрационные ключи не сверены с авторскими версиями методик.", "Альфа характеризует этот генератор, а не реальную популяцию или валидность методики.", "Отбор по альфе допустим только как явно указанная условная симуляция.", "Культура — номинальные категории; для неё альфа не рассчитывается. Коды не являются DOM-индексами."] });
}
export function validateSimulation(input: unknown) {
  const cohort = simulationCohortSchema.parse(input), expected = generateSimulation(cohort.config);
  if (JSON.stringify(cohort.reports) !== JSON.stringify(expected.reports) || cohort.attempts !== expected.attempts || cohort.targetReached !== expected.targetReached || JSON.stringify(cohort.scaleDefinitions) !== JSON.stringify(expected.scaleDefinitions) || cohort.rows.some((r, i) => { const e = expected.rows[i]!; return r.id !== e.id || JSON.stringify(r.demographics) !== JSON.stringify(e.demographics) || Object.keys(e.answers).some(k => r.answers[k] !== e.answers[k]); })) throw new TypeError("Набор не соответствует seed, версии и отчёту генератора.");
  return cohort;
}
