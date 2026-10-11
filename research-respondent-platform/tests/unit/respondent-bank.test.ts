/** Isolated software fixtures; never participant records or live form answers. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { bankJson, bankSpecSchema, planBank } from "../../lib/domain/respondent-bank.ts";
import { parseSource } from "../../lib/domain/workbench.ts";
const spec = bankSpecSchema.parse({ mode: "merge", leftId: "11111111-1111-4111-8111-111111111111", rightId: "22222222-2222-4222-8222-222222222222",
  leftIdHeader: "participant_id", rightIdHeader: "participant_id", name: "Software fixture", reference: "isolated", rights: "test-only" });
const csv = (text: string) => parseSource("fixture.csv", text);

it("bank merge preserves zero, adds observed cells and retains exact row origins", () => {
  const left = csv("participant_id,answer,comment\nTEST-A,0,\nTEST-B,,literal\n");
  const right = csv('participant_id,answer,comment,group\nTEST-A,0,,one\nTEST-B,2,literal,two\nTEST-C,3,"comma, quote """,three\n');
  const plan = planBank(spec, left, right);
  assert.equal(plan.summary.conflicts, 0); assert.equal(plan.summary.addedRecords, 1);
  assert.equal(plan.summary.matchedRecords, 2); assert.equal(plan.summary.filledCells, 3);
  assert.deepEqual(plan.rows[0], ["TEST-A", "0", null, "one"]);
  assert.deepEqual(plan.origins[1], [{ source: "left", line: 3 }, { source: "right", line: 3 }]);
  const result = parseSource("result.json", bankJson(plan));
  assert.equal(result.rows[2]!.values[2], 'comma, quote "');
  assert.equal(left.rows[1]!.values[1], null); // no mutation of the source
});
it("conflicting nonempty answers block the plan and are never overwritten", () => {
  const plan = planBank(spec, csv("participant_id,answer\nTEST-A,2\n"), csv("participant_id,answer\nTEST-A,3\n"));
  assert.equal(plan.summary.conflicts, 1); assert.equal(plan.rows[0]![1], "2");
  assert.equal(plan.summary.issues[0]!.code, "conflicting_value");
});
it("exact duplicate rows collapse but conflicting duplicate keys require a session key", () => {
  const repeated = csv("participant_id,response_id,answer\nTEST-A,one,2\nTEST-A,one,2\nTEST-A,two,3\n");
  const other = csv("participant_id,response_id,answer\nTEST-B,three,4\n");
  const blocked = planBank(spec, repeated, other); assert.ok(blocked.summary.conflicts);
  const plan = planBank({ ...spec, additionalKeyHeaders: ["response_id"] }, repeated, other);
  assert.equal(plan.summary.conflicts, 0); assert.equal(plan.summary.duplicatesRemoved, 1);
  assert.equal(plan.rows.length, 3); assert.equal(plan.origins[0]!.length, 2);
});
it("profile join is exact, preserves unmatched answers and does not add unassessed profiles", () => {
  const answers = csv("participant_id,response_id,answer\nTEST-A,one,0\nTEST-A,two,2\nTEST-Z,three,4\n");
  const profiles = csv("respondent_id,group\nTEST-A,one\nTEST-B,two\n");
  const plan = planBank({ ...spec, mode: "join", rightIdHeader: "respondent_id", additionalKeyHeaders: ["response_id"] }, answers, profiles);
  assert.equal(plan.summary.conflicts, 0); assert.equal(plan.summary.matchedRecords, 2);
  assert.equal(plan.summary.unmatchedRecords, 1); assert.equal(plan.summary.unusedProfiles, 1);
  assert.deepEqual(plan.rows[2], ["TEST-Z", "three", "4", null]);
  assert.equal(plan.headers.includes("respondent_id"), false);
});
it("empty keys, whitespace ID changes and ambiguous profiles are refused", () => {
  const plan = planBank(spec, csv("participant_id,answer\n,1\n TEST-A,2\n"), csv("participant_id,answer\nTEST-B,3\n"));
  assert.equal(plan.summary.conflicts, 2);
  const ambiguous = planBank({ ...spec, mode: "join" }, csv("participant_id,answer\nTEST-A,1\n"), csv("participant_id,group\nTEST-A,one\nTEST-A,two\n"));
  assert.equal(ambiguous.summary.issues[0]!.code, "duplicate_key");
});
it("tuple keys and leading zeros do not conflate different participants or sessions", () => {
  const plan = planBank({ ...spec, additionalKeyHeaders: ["response_id"] }, csv('participant_id,response_id,answer\n01,"a,b",2\n1,a,3\n'), csv('participant_id,response_id,answer\n"01,a",b,4\n'));
  assert.equal(plan.rows.length, 3); assert.equal(plan.summary.conflicts, 0);
});
it("unknown key headers and combined output limits fail before persistence", () => {
  assert.throws(() => planBank({ ...spec, additionalKeyHeaders: ["missing"] }, csv("participant_id\nTEST-A\n"), csv("participant_id\nTEST-B\n")), /отсутствует/);
  const half = (prefix: string) => parseSource("fixture.json", JSON.stringify(Array.from({ length: 2501 }, (_, i) => ({ participant_id: `${prefix}-${i}` }))));
  assert.throws(() => planBank(spec, half("left"), half("right")), /5000/);
});
it("typed JSON cells and hostile-looking header names remain literal data", () => {
  const left = parseSource("fixture.json", '[{"participant_id":"TEST-A","__proto__":"literal","answer":false}]');
  const right = parseSource("fixture.json", '[{"participant_id":"TEST-B","constructor":"text","answer":0}]');
  const result = parseSource("result.json", bankJson(planBank(spec, left, right)));
  assert.equal(result.rows[0]!.values[result.headers.indexOf("__proto__")], "literal");
  assert.equal(result.rows[0]!.values[result.headers.indexOf("answer")], false);
  assert.equal(result.rows[1]!.values[result.headers.indexOf("answer")], 0);
  assert.equal(Object.hasOwn({}, "literal"), false);
});
