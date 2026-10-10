import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPacket, emptyWorkspace, parseSource, preparationProblems, restoreWorkspace, selectedRows, validFormUrl, type Workspace } from "../../lib/domain/workbench.ts";

function fixture(): Workspace {
  return { ...emptyWorkspace(), dataset: parseSource("fixture.csv", 'id,age,answer\nfixture-1,17,0\nfixture-2,22,"same, literal"\nfixture-3,31,\n'), checksum: "a".repeat(64), reference: "Disposable fixture", purpose: "Fixture transfer", formUrl: "https://docs.google.com/forms/d/e/fixture/viewform", idColumn: 0, fields: [{ question: "Exact question", column: 2, required: true }] };
}
test("browser preparation preserves literal values and original CSV line locators", () => {
  const dataset = parseSource("fixture.csv", '\uFEFFid;answer\r\n\r\nfixture-1;"first\nsecond"\r\nfixture-2;"a; b"\r\n');
  assert.deepEqual(dataset.rows, [{ line: 3, values: ["fixture-1", "first\nsecond"] }, { line: 5, values: ["fixture-2", "a; b"] }]);
  assert.throws(() => parseSource("bad.csv", 'id,answer\na,"unfinished'), /кавычки/);
  assert.throws(() => parseSource("bad.csv", "id,answer\na,1,2"), /Строки/);
  assert.throws(() => parseSource("bad.csv", "id,id\na,b"), /уникальны/);
});
test("filtering explains classification without changing answers, and missing required answers prevent export", () => {
  const workspace = fixture();
  workspace.rules = [{ column: 1, op: "gte", value: "18", label: "Adults" }];
  assert.equal(selectedRows(workspace).length, 2);
  assert.throws(() => buildPacket(workspace), /обязательных ответов/);
  workspace.rules.push({ column: 2, op: "present", value: "", label: "Complete answer" });
  const packet = buildPacket(workspace);
  assert.equal(packet.respondents.length, 1);
  assert.deepEqual(packet.respondents[0], { participant_ref: "fixture-2", source_row: 3, classifications: ["Adults", "Complete answer"], answers: [{ question: "Exact question", required: true, value: "same, literal", source: { column: "answer", row: 3, sha256: "a".repeat(64) } }] });
  assert.equal(packet.execution.external_submission, false);
  assert.equal(workspace.dataset!.rows[0]!.values[2], "0");
});
test("zero and false are real answers, while optional missing values remain null", () => {
  const workspace = { ...fixture(), dataset: parseSource("fixture.json", JSON.stringify([{ id: "fixture-1", answer: 0 }, { id: "fixture-2", answer: false }, { id: "fixture-3", answer: null }])), fields: [{ question: "Exact question", column: 1, required: false }] };
  assert.deepEqual(buildPacket(workspace).respondents.map((r) => r.answers[0]!.value), [0, false, null]);
  workspace.fields[0]!.required = true;
  assert.throws(() => buildPacket(workspace), /обязательных ответов/);
});
test("duplicate participant IDs and invalid mapping indexes block preparation", () => {
  const workspace = fixture();
  workspace.dataset!.rows[1]!.values[0] = "fixture-1";
  assert.ok(preparationProblems(workspace).some((x) => x.includes("повторяющиеся ID")));
  workspace.fields[0]!.column = 999;
  assert.throws(() => buildPacket(workspace), /Не сопоставлен/);
});
test("restored projects validate structure and preserve configuration and values", () => {
  const workspace = fixture();
  assert.deepEqual(restoreWorkspace(JSON.stringify(workspace)), workspace);
  assert.throws(() => restoreWorkspace(JSON.stringify({ ...workspace, rules: [{ column: 100, op: "gte", value: "18", label: "invalid" }] })), /критерии/);
  assert.throws(() => restoreWorkspace(JSON.stringify({ ...workspace, dataset: { ...workspace.dataset, rows: [{ line: 2, values: [{ unsafe: true }] }] } })), /Строки/);
});
test("Google Forms links are restricted and modeled origins cannot become actual-answer imports", () => {
  assert.equal(validFormUrl("https://forms.gle/fixture"), true);
  for (const url of ["javascript:alert(1)", "https://docs.google.com.evil.test/forms/abc", "http://docs.google.com/forms/abc", "https://user@forms.gle/abc"]) assert.equal(validFormUrl(url), false);
  assert.throws(() => parseSource("fixture.json", JSON.stringify({ data_origin: "modeled", records: [{ id: "fixture-1" }] })), /модельные/i);
  assert.throws(() => parseSource("fixture.json", JSON.stringify([{ id: "fixture-1", data_origin: "modeled" }])), /Модельные/);
});
