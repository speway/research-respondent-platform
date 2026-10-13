import { z } from "zod";
const id = z.string().uuid();
const text = z.string().trim().min(1).max(1000);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine(v => !["participant_id", "data_origin", "constructor", "prototype", "source_response_id", "source_receipt_sha256", "consent_version"].includes(v));
export const quorumQuestionSchema = z.discriminatedUnion("kind", [
  z.object({ id: key, label: text, kind: z.literal("scale"), low: z.number().int().min(-100).max(100), high: z.number().int().min(-100).max(100), required: z.boolean().default(true) }).strict().refine(q => q.high > q.low && q.high - q.low <= 20),
  z.object({ id: key, label: text, kind: z.literal("choice"), options: z.array(z.object({ code: key, label: text }).strict()).min(2).max(20), required: z.boolean().default(true) }).strict().refine(q => new Set(q.options.map(o => o.code)).size === q.options.length),
  z.object({ id: key, label: text, kind: z.literal("text"), maxLength: z.number().int().min(1).max(2000).default(1000), required: z.boolean().default(true) }).strict(),
]);
export const quorumQuestionsSchema = z.array(quorumQuestionSchema).min(1).max(50).refine(q => new Set(q.map(x => x.id)).size === q.length, "ID вопросов должны различаться.");
export type QuorumQuestion = z.output<typeof quorumQuestionSchema>;
export const quorumStudySchema = z.object({ title: text, purpose: text, reference: text, reviewRules: z.string().trim().min(20).max(1000), consentText: z.string().trim().min(20).max(2000), durationMinutes: z.number().int().min(1).max(120), eligibleGroups: z.array(z.string().trim().min(1).max(100)).max(20).default([]), target: z.number().int().min(1).max(100), reward: z.number().int().min(1).max(10), questions: quorumQuestionsSchema }).strict();
export type QuorumStudySpec = z.output<typeof quorumStudySchema>;
export const quorumProfileSchema = z.object({ narrative: z.string().trim().min(50).max(6000), reference: text, consentModeling: z.literal(true), excludesHoldoutAnswers: z.literal(true) }).strict();
export type QuorumProfile = z.output<typeof quorumProfileSchema>;
export const quorumExperimentSchema = z.object({ title: text, hypothesis: text, holdoutReference: text, modelId: text, promptVersion: text, settings: text, retestDays: z.number().int().min(1).max(30).default(14), participantIds: z.array(id).min(1).max(100), questions: quorumQuestionsSchema, holdoutConfirmed: z.literal(true) }).strict().refine(e => new Set(e.participantIds).size === e.participantIds.length);
export type QuorumExperimentSpec = z.output<typeof quorumExperimentSchema>;
export const quorumAnswersSchema = z.record(key, z.union([z.number().finite(), z.string().max(2000), z.null()]));
export type QuorumAnswers = z.output<typeof quorumAnswersSchema>;
export function validateQuorumAnswers(questions: QuorumQuestion[], input: unknown): QuorumAnswers {
  const answers = quorumAnswersSchema.parse(input), ids = new Set(questions.map(q => q.id));
  if (Object.keys(answers).some(k => !ids.has(k))) throw new TypeError("Лишний ID ответа.");
  for (const q of questions) {
    const v = answers[q.id];
    if (v === undefined || v === null) { if (q.required) throw new TypeError(`Нет обязательного ответа: ${q.id}`); continue; }
    if (q.kind === "scale" && (typeof v !== "number" || !Number.isInteger(v) || v < q.low || v > q.high)) throw new TypeError(`Ответ вне шкалы: ${q.id}`);
    if (q.kind === "choice" && (typeof v !== "string" || !q.options.some(o => o.code === v))) throw new TypeError(`Неизвестный вариант: ${q.id}`);
    if (q.kind === "text" && (typeof v !== "string" || !v.trim() || v.length > q.maxLength)) throw new TypeError(`Проверьте текст: ${q.id}`);
  }
  return answers;
}
export const quorumStudentCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("study"), requestId: id, study: quorumStudySchema }).strict(),
  z.object({ command: z.literal("submit"), studyId: id, answers: quorumAnswersSchema, consent: z.literal(true), humanAttestation: z.literal(true) }).strict(),
  z.object({ command: z.literal("close_study"), studyId: id }).strict(),
  z.object({ command: z.literal("withdraw_response"), responseId: id }).strict(),
  z.object({ command: z.literal("appeal"), responseId: id, reason: text }).strict(),
  z.object({ command: z.literal("profile"), profile: quorumProfileSchema }).strict(),
  z.object({ command: z.literal("withdraw_profile") }).strict(),
  z.object({ command: z.literal("consent_experiment"), experimentId: id, consent: z.literal(true) }).strict(),
  z.object({ command: z.literal("human"), experimentId: id, phase: z.enum(["first", "retest"]), answers: quorumAnswersSchema, consent: z.literal(true), humanAttestation: z.literal(true) }).strict(),
]);
export const quorumAdminCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("invite"), login: z.string().trim().regex(/^[a-z0-9_-]{3,40}$/), label: z.string().trim().min(1).max(100), group: z.string().trim().min(1).max(100), starterCredits: z.number().int().min(0).max(20).default(5) }).strict(),
  z.object({ command: z.literal("disable"), participantId: id }).strict(),
  z.object({ command: z.literal("review_study"), studyId: id, accepted: z.boolean(), reason: text }).strict(),
  z.object({ command: z.literal("close_study"), studyId: id }).strict(),
  z.object({ command: z.literal("review_response"), responseId: id, accepted: z.boolean(), reason: text }).strict(),
  z.object({ command: z.literal("experiment"), requestId: id, experiment: quorumExperimentSchema }).strict(),
  z.object({ command: z.literal("agent_key"), experimentId: id, participantId: id, arm: z.enum(["personal", "baseline"]) }).strict(),
  z.object({ command: z.literal("revoke_key"), keyId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export const quorumPredictionSchema = z.object({ answers: quorumAnswersSchema, modelId: text, promptVersion: text, settings: text }).strict();
export type QuorumPrediction = z.output<typeof quorumPredictionSchema>;
export interface PairMetrics { totalQuestions: number; scoredItems: number; missingPairs: number; textItems: number; exactRate: number | null; normalizedError: number | null; scaleMAE: number | null }
export function compareQuorumAnswers(questions: QuorumQuestion[], a: QuorumAnswers, b: QuorumAnswers): PairMetrics {
  validateQuorumAnswers(questions, a); validateQuorumAnswers(questions, b);
  let exact = 0, error = 0, scoredItems = 0, missingPairs = 0, textItems = 0, scaleError = 0, scales = 0;
  for (const q of questions) {
    const x = a[q.id], y = b[q.id];
    if (x === undefined || y === undefined || x === null || y === null) { missingPairs++; continue; }
    if (q.kind === "text") { textItems++; continue; }
    scoredItems++; if (x === y) exact++;
    if (q.kind === "scale") { const difference = Math.abs(Number(x) - Number(y)); scaleError += difference; scales++; error += difference / (q.high - q.low); }
    else error += x === y ? 0 : 1;
  }
  return { totalQuestions: questions.length, scoredItems, missingPairs, textItems, exactRate: scoredItems ? exact / scoredItems : null, normalizedError: scoredItems ? error / scoredItems : null, scaleMAE: scales ? scaleError / scales : null };
}
/** Resample participants, not questionnaire cells; intervals describe this pilot only. */
export function participantBootstrap(values: number[]) {
  if (values.length < 2) return null;
  let seed = 20261013; const samples: number[] = [];
  for (let run = 0; run < 1000; run++) { let sum = 0; for (let i = 0; i < values.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; sum += values[Math.floor(seed / 4294967296 * values.length)]!; } samples.push(sum / values.length); }
  samples.sort((a, b) => a - b); return { low: samples[24]!, high: samples[974]!, method: "participant_percentile_bootstrap", resamples: 1000, seed: 20261013 };
}

export const quorumHostedCommandSchema = z.object({ command: z.literal("run_prediction"), experimentId: id, participantId: id, arm: z.enum(["personal", "baseline"]), confirmModelProcessing: z.literal(true) }).strict();
