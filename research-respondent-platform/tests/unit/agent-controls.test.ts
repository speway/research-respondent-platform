import assert from "node:assert/strict";
import { test } from "node:test";
import { applyObservation, buildAgentPlan, observationSchema, selectedOptions, workspaceForTarget, workspaceFromTask, type FormObservation } from "../../lib/domain/agent-workbench.ts";
import { emptyWorkspace } from "../../lib/domain/workbench.ts";
const url = "https://forms.gle/fixture";
const task = { schema: "rrp.agent-task.v1", source: { name: "fixture.json", text: JSON.stringify([{ participant_id: "fixture-1", "Block / Matrix / Row 1": "Yes", "Block / Matrix / Row 2": '["A, B","C"]', "Block / List": "Exact" }]) }, reference: "Fixture only", purpose: "Isolated controls test", formUrl: url };
const observation: FormObservation = { schema: "rrp.observed-form.v1", url, title: "Fixture", method: "visible_ui", observedAt: "2026-10-10T00:00:00Z", scope: "visible_section", questions: [
  { id: "m/row1", section: "Block", text: "Matrix / Row 1", kind: "single_choice", options: ["Yes", "No"], required: true, matrix: { id: "m", title: "Matrix", row: "Row 1" } },
  { id: "m/row2", section: "Block", text: "Matrix / Row 2", kind: "multiple_choice", options: ["A, B", "C"], required: true, matrix: { id: "m", title: "Matrix", row: "Row 2" } },
  { id: "q3", section: "Block", text: "List", kind: "dropdown", options: ["Exact", "Other"], required: true },
] };
test("matrix rows preserve their source cells and exact checkbox sets including commas", async () => {
  const next = applyObservation(await workspaceFromTask(task), observation);
  const plan = buildAgentPlan(next.workspace, next.observation);
  assert.deepEqual(plan.respondents[0]!.actions.map((a) => a.action), ["select_radio", "select_checkboxes", "select_option"]);
  assert.equal(plan.respondents[0]!.actions[1]!.value, '["A, B","C"]');
  assert.deepEqual(plan.respondents[0]!.actions[1]!.selectedOptions, ["A, B", "C"]);
  assert.equal(plan.respondents[0]!.actions[1]!.source.column, "Block / Matrix / Row 2");
});
test("multi-selection rejects shorthand, duplicate, empty, unknown and malformed values", async () => {
  for (const value of ['A, B,C', '["C","C"]', '[]', '["C",1]', '["unknown"]', '[']) {
    const t = { ...task, source: { name: "fixture.json", text: JSON.stringify([{ participant_id: "fixture-1", "Block / Matrix / Row 1": "Yes", "Block / Matrix / Row 2": value, "Block / List": "Exact" }]) } };
    const next = applyObservation(await workspaceFromTask(t), observation);
    assert.throws(() => buildAgentPlan(next.workspace, next.observation), /JSON-массив/);
  }
  assert.equal(selectedOptions(false), null);
  assert.throws(() => observationSchema.parse({ ...observation, questions: [{ ...observation.questions[0], kind: "text" }] }));
});
test("a new link reuses the source and criteria but never its previous form map", async () => {
  const workspace = await workspaceFromTask(task);
  workspace.rules = [{ column: 1, op: "eq", value: "Yes", label: "Measured criterion" }];
  const next = applyObservation(workspace, observation);
  const target = workspaceForTarget(next.workspace, "https://forms.gle/next-fixture");
  assert.equal(target.dataset, workspace.dataset);
  assert.equal(target.rules, workspace.rules);
  assert.equal(target.checksum, workspace.checksum);
  assert.equal(target.purpose, workspace.purpose);
  assert.deepEqual(target.fields, []);
  assert.throws(() => workspaceForTarget(emptyWorkspace(), url), /настройте базу/);
  assert.throws(() => workspaceForTarget(workspace, "https://evil.test"));
  assert.throws(() => applyObservation(target, observation), /другой форме/);
});
