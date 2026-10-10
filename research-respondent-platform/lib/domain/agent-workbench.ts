import { z } from "zod";
import { buildPacket, emptyWorkspace, MAX_FILE_BYTES, parseSource, preparationProblems, restoreWorkspace, selectedRows, validFormUrl, type Cell, type Workspace } from "./workbench.ts";

const label = z.string().min(1).max(20000).refine((s) => !!s.trim(), "Пустое название.");
const formUrl = z.string().refine(validFormUrl, "Нужна HTTPS-ссылка Google Forms.");
const questionSchema = z.object({
  id: label, section: z.string().max(20000), text: label,
  kind: z.enum(["text", "paragraph", "number", "single_choice", "dropdown", "unsupported"]),
  required: z.boolean(), options: z.array(label).max(1000).default([]),
  min: z.number().finite().optional(), max: z.number().finite().optional(),
}).strict().superRefine((q, ctx) => {
  if (["single_choice", "dropdown"].includes(q.kind) && (!q.options.length || new Set(q.options).size !== q.options.length)) ctx.addIssue({ code: "custom", message: "Нужны уникальные буквальные варианты ответа." });
  if (q.min !== undefined && q.max !== undefined && q.min > q.max) ctx.addIssue({ code: "custom", message: "Минимум больше максимума." });
});
export const observationSchema = z.object({
  schema: z.literal("rrp.observed-form.v1"), url: formUrl, requestedUrl: formUrl.optional(),
  title: label, scope: z.enum(["visible_section", "complete_form"]),
  observedAt: z.iso.datetime(), method: z.literal("visible_ui"),
  questions: z.array(questionSchema).min(1).max(2000),
}).strict().superRefine((o, ctx) => {
  if (new Set(o.questions.map((q) => q.id)).size !== o.questions.length) ctx.addIssue({ code: "custom", message: "ID вопросов должны быть уникальны." });
});
export type FormObservation = z.infer<typeof observationSchema>;
export type ObservedQuestion = FormObservation["questions"][number];
const taskSchema = z.object({
  schema: z.literal("rrp.agent-task.v1"), source: z.object({ name: label, text: z.string() }).strict(),
  reference: label, purpose: label, formUrl, idHeader: label.optional(),
  match: z.enum(["all", "any"]).default("all"),
  criteria: z.array(z.object({ header: label, op: z.enum(["eq", "ne", "contains", "gte", "lte", "present", "missing"]), value: z.string(), label: z.string() }).strict()).max(100).default([]),
}).strict();
export type AgentTask = z.input<typeof taskSchema>;
export const normalizeLabel = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
export function questionLabel(q: ObservedQuestion) { return q.section ? `${q.section} / ${q.text}` : q.text; }
export function automaticMappings(headers: string[], observation: FormObservation) {
  return observation.questions.map((q) => {
    // Do not strip punctuation, negation, numbers or answer codes. No fuzzy auto-accept.
    const keys = [q.id, questionLabel(q)];
    const repeated = observation.questions.filter((x) => normalizeLabel(x.text) === normalizeLabel(q.text)).length > 1;
    if (!repeated && observation.scope === "complete_form") keys.push(q.text);
    const candidates = headers.flatMap((h, column) => keys.some((key) => normalizeLabel(key) === normalizeLabel(h)) ? [column] : []);
    return { question: questionLabel(q), column: candidates.length === 1 ? candidates[0]! : null, required: q.required,
      questionId: q.id, candidates, reason: candidates.length === 1 ? "unique_exact_label" : candidates.length ? "ambiguous" : "no_exact_source" };
  });
}
export async function workspaceFromTask(input: unknown): Promise<Workspace> {
  const task = taskSchema.parse(input);
  const bytes = new TextEncoder().encode(task.source.text);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("База превышает 5 МБ.");
  const dataset = parseSource(task.source.name, task.source.text);
  const ids = dataset.headers.flatMap((h, i) => (task.idHeader ? h === task.idHeader : ["participant_id", "respondent_id", "id", "id участника"].includes(normalizeLabel(h))) ? [i] : []);
  if (ids.length !== 1) throw new Error("Неоднозначный ID: передайте точный idHeader.");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const workspace: Workspace = { ...emptyWorkspace(), dataset, checksum: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""), reference: task.reference, purpose: task.purpose, formUrl: task.formUrl, idColumn: ids[0]!, match: task.match,
    rules: task.criteria.map((rule) => {
      const column = dataset.headers.indexOf(rule.header);
      if (column < 0) throw new Error(`Нет столбца критерия: ${rule.header}.`);
      if (!["present", "missing"].includes(rule.op) && !rule.value.trim()) throw new Error("Пустое значение критерия.");
      return { column, op: rule.op, value: rule.value, label: rule.label };
    }),
  };
  // Reuse the same structural checks as saved projects, instead of a second importer.
  return restoreWorkspace(JSON.stringify(workspace));
}
export function applyObservation(workspace: Workspace, input: unknown) {
  if (!workspace.dataset) throw new Error("Сначала передайте базу.");
  const observation = observationSchema.parse(input);
  if (observation.url !== workspace.formUrl && observation.requestedUrl !== workspace.formUrl) throw new Error("Наблюдение относится к другой форме.");
  const mappings = automaticMappings(workspace.dataset.headers, observation);
  return { workspace: { ...workspace, fields: mappings.map(({ question, column, required }) => ({ question, column, required })) }, observation, mappings };
}
const absent = (v: Cell | undefined) => v === null || v === undefined || (typeof v === "string" && !v.trim());
export function agentProblems(workspace: Workspace, observation: FormObservation | null): string[] {
  if (!observation) return [...preparationProblems(workspace), "Агент ещё не прочитал видимые вопросы формы."];
  const applied = applyObservation(workspace, observation);
  if (JSON.stringify(workspace.fields) !== JSON.stringify(applied.workspace.fields)) return ["Карта изменена после наблюдения. Прочитайте и сопоставьте форму заново."];
  const problems = preparationProblems(workspace);
  for (const [i, q] of observation.questions.entries()) {
    if (q.kind === "unsupported") problems.push(`${questionLabel(q)}: нужен агент с поддержкой этого элемента.`);
    const column = workspace.fields[i]?.column;
    if (column === null || column === undefined) continue;
    for (const row of selectedRows(workspace)) {
      const value = row.values[column];
      if (absent(value)) continue;
      if (["single_choice", "dropdown"].includes(q.kind) && !q.options.includes(String(value))) problems.push(`Строка ${row.line}, ${questionLabel(q)}: ответ не совпадает с вариантом формы.`);
      if (q.kind === "number" && (typeof value === "boolean" || !Number.isFinite(Number(value)) || (q.min !== undefined && Number(value) < q.min) || (q.max !== undefined && Number(value) > q.max))) problems.push(`Строка ${row.line}, ${questionLabel(q)}: число вне правил формы.`);
    }
  }
  return [...new Set(problems)];
}
export function buildAgentPlan(workspace: Workspace, observation: FormObservation | null) {
  const problems = agentProblems(workspace, observation);
  if (problems.length || !observation) throw new Error(problems.join("\n"));
  return { schema: "rrp.browser-agent-plan.v1", status: "prepared", scope: observation.scope,
    observation, packet: buildPacket(workspace),
    execution: { externalSubmission: false, verifyEveryField: true, reobserveEverySection: true, retrySubmission: false, authorization: "explicit_recipient_and_participants", successEvidence: "visible_response_recorded" },
    respondents: selectedRows(workspace).map((row) => ({ participantRef: String(row.values[workspace.idColumn!]),
      actions: observation.questions.map((q, i) => ({ questionId: q.id, section: q.section, question: q.text, kind: q.kind,
        action: absent(row.values[workspace.fields[i]!.column!]) ? "skip_optional" : q.kind === "single_choice" ? "select_radio" : q.kind === "dropdown" ? "select_option" : "fill",
        value: row.values[workspace.fields[i]!.column!] ?? null,
        source: { row: row.line, column: workspace.dataset!.headers[workspace.fields[i]!.column!], sha256: workspace.checksum } })),
    })),
  };
}
