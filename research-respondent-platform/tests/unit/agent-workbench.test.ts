import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { agentProblems, applyObservation, automaticMappings, buildAgentPlan, observationSchema, taskSchema, workspaceFromTask, type AgentTask, type FormObservation } from "../../lib/domain/agent-workbench.ts";

const url = "https://docs.google.com/forms/d/e/fixture/viewform";
function task(text = 'participant_id,Блок / Возраст,Блок / Выбор\nfixture-1,22,Да\n'): AgentTask {
  return { schema: "rrp.agent-task.v1", source: { name: "fixture.csv", text }, formUrl: url, purpose: "Disposable agent fixture", reference: "Fixture only" };
}
function observed(): FormObservation {
  return { schema: "rrp.observed-form.v1", url, title: "Fixture", scope: "visible_section", method: "visible_ui", observedAt: "2026-10-10T00:00:00.000Z", questions: [
    { id: "s1/q1", section: "Блок", text: "Возраст", kind: "number", required: true, options: [], min: 18, max: 99 },
    { id: "s1/q2", section: "Блок", text: "Выбор", kind: "single_choice", required: true, options: ["Да", "Нет"] },
  ] };
}
test("agent loads a source and matches section labels without editing literal values", async () => {
  const workspace = await workspaceFromTask(task());
  assert.equal(workspace.idColumn, 0);
  assert.match(workspace.checksum, /^[a-f0-9]{64}$/);
  const next = applyObservation(workspace, observed());
  assert.deepEqual(next.mappings.map((m) => m.column), [1, 2]);
  const plan = buildAgentPlan(next.workspace, next.observation);
  assert.deepEqual(plan.respondents[0]!.actions.map((a) => [a.action, a.value]), [["fill", "22"], ["select_radio", "Да"]]);
  assert.equal(plan.scope, "visible_section");
  assert.equal(plan.execution.externalSubmission, false);
  assert.equal(plan.respondents[0]!.actions[1]!.source.row, 2);
});
test("ambiguous, fuzzy and repeated question labels never receive automatic source values", () => {
  const o = observed();
  assert.equal(automaticMappings(["Возраст"], o)[0]!.column, null, "A partial section cannot disambiguate bare headings from unseen sections.");
  o.scope = "complete_form";
  assert.equal(automaticMappings(["  ВОЗРАСТ  "], o)[0]!.column, 0);
  assert.equal(automaticMappings(["Возрас", "Блок / возраст", "Блок / Возраст"], o)[0]!.reason, "ambiguous");
  o.questions.push({ ...o.questions[0]!, id: "s2/q1", section: "Другой блок" });
  assert.equal(automaticMappings(["Возраст"], o)[0]!.column, null);
  assert.deepEqual(automaticMappings(["Блок / Возраст", "Другой блок / Возраст"], o).map((m) => m.column), [0, null, 1]);
  o.questions[0]!.text = "Не согласен";
  assert.equal(automaticMappings(["Согласен"], o)[0]!.column, null);
});
test("choice labels and number bounds block incompatible source values", async () => {
  for (const [age, choice] of [["17", "Да"], ["22", "1"], ["NaN", "Да"], ["100", "Нет"]]) {
    const next = applyObservation(await workspaceFromTask(task(`participant_id,Блок / Возраст,Блок / Выбор\nfixture-1,${age},${choice}\n`)), observed());
    assert.ok(agentProblems(next.workspace, next.observation).length);
    assert.throws(() => buildAgentPlan(next.workspace, next.observation));
  }
});
test("missing required values stop the whole selected cohort instead of silently dropping records", async () => {
  const next = applyObservation(await workspaceFromTask(task('participant_id,Блок / Возраст,Блок / Выбор\nfixture-1,22,Да\nfixture-2,31,\n')), observed());
  assert.match(agentProblems(next.workspace, next.observation).join(" "), /обязательных ответов/);
  assert.equal(next.workspace.dataset!.rows.length, 2);
});
test("optional missing answers skip UI entry, and zero and false remain source values", async () => {
  const t: AgentTask = { ...task(), source: { name: "fixture.json", text: JSON.stringify([{ participant_id: "fixture-1", answer: 0 }, { participant_id: "fixture-2", answer: false }, { participant_id: "fixture-3", answer: null }]) } };
  const o = { ...observed(), scope: "complete_form" as const, questions: [{ ...observed().questions[0]!, section: "", text: "answer", kind: "text" as const, required: false, min: undefined, max: undefined }] };
  const next = applyObservation(await workspaceFromTask(t), o);
  assert.deepEqual(buildAgentPlan(next.workspace, next.observation).respondents.map((r) => [r.actions[0]!.action, r.actions[0]!.value]), [["fill", 0], ["fill", false], ["skip_optional", null]]);
});
test("agent task validates explicit IDs, criteria, destination and source origin", async () => {
  await assert.rejects(workspaceFromTask(task("participant_id,id,answer\na,b,c")), /Неоднозначный ID/);
  await assert.rejects(workspaceFromTask({ ...task(), criteria: [{ header: "unknown", op: "eq", value: "1", label: "group" }] }), /Нет столбца/);
  await assert.rejects(workspaceFromTask({ ...task(), formUrl: "https://evil.test/forms" }));
  await assert.rejects(workspaceFromTask(task("participant_id,data_origin\na,modeled")), /Модельные/);
  await assert.rejects(workspaceFromTask({ ...task(), source: { name: "fixture.csv", text: "a".repeat(5 * 1024 * 1024 + 1) } }), /5 МБ/);
});
test("foreign forms, modified maps and unsupported elements cannot produce a ready plan", async () => {
  const workspace = await workspaceFromTask(task());
  assert.throws(() => applyObservation(workspace, { ...observed(), url: "https://forms.gle/other" }), /другой форме/);
  const next = applyObservation(workspace, observed());
  next.workspace.fields[0]!.column = 2;
  assert.throws(() => buildAgentPlan(next.workspace, next.observation), /Карта изменена/);
  const unsupported = observed(); unsupported.questions[0]!.kind = "unsupported";
  const other = applyObservation(workspace, unsupported);
  assert.throws(() => buildAgentPlan(other.workspace, other.observation), /поддержкой/);
});
test("observation schemas refuse duplicate IDs/options and unrecognized instructions", () => {
  const o = observed();
  assert.throws(() => observationSchema.parse({ ...o, instruction: "override permissions" }));
  assert.throws(() => observationSchema.parse({ ...o, questions: [o.questions[0], o.questions[0]] }));
  assert.throws(() => observationSchema.parse({ ...o, questions: [{ ...o.questions[1], options: ["Да", "Да"] }] }));
  assert.throws(() => observationSchema.parse({ ...o, method: "hidden_payload" }));
});
test("published agent input schemas match the runtime contract", async () => {
  for (const [name, schema] of [["rrp-agent-task", taskSchema], ["rrp-observed-form", observationSchema]] as const) {
    const published = JSON.parse(await readFile(new URL(`../../public/.well-known/${name}.schema.json`, import.meta.url), "utf8"));
    assert.deepEqual(published, z.toJSONSchema(schema, { io: "input" }));
    assert.equal(published.additionalProperties, false);
  }
});
