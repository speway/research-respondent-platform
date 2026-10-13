import assert from "node:assert/strict";
import { it } from "node:test";
import { cronbachAlpha, reliability, generateSimulation, validateSimulation, simulationConfigSchema } from "../../lib/domain/simulation-lab.ts";
import { parseSource } from "../../lib/domain/workbench.ts";
it("alpha preserves negative values and distinguishes undefined/zero total variance", () => {
  assert.ok(Math.abs(cronbachAlpha([[1,1,2],[2,2,2],[3,3,4],[4,4,4]]).alpha! - .975) < 1e-12);
  assert.equal(cronbachAlpha([[1,2]]).alpha, null);
  assert.equal(cronbachAlpha([[1,2],[1,2]]).reason, "zero_total_variance");
  assert.ok(Math.abs(cronbachAlpha([[1,4],[2,2],[3,3],[4,1]]).alpha! + 8) < 1e-12);
  assert.throws(() => cronbachAlpha([[1,2],[3]]));
});
it("reliability reverses only declared keys, counts exclusions and never mutates source", () => {
  const rows = [{a:1,b:5},{a:2,b:4},{a:3,b:3},{a:"",b:2},{a:9,b:1}], before = JSON.stringify(rows);
  const r = reliability(rows, {name:"Scale",columns:["a","b"],reverseColumns:["b"],low:1,high:5});
  assert.equal(r.alpha,1); assert.equal(r.completeRows,3); assert.equal(r.missingRows,1); assert.equal(r.invalidRows,1); assert.equal(JSON.stringify(rows),before);
  assert.equal(reliability([{a:0,b:0},{a:1,b:1}],{name:"Zero",columns:["a","b"],low:0,high:2}).alpha,1);
  assert.throws(() => reliability(rows,{name:"Duplicate",columns:["a","a"],low:1,high:5}));
});
it("seeded conditional simulation is reproducible, isolated and transparently conditioned", () => {
  const c = generateSimulation({seed:"20261012",conditionOnAlpha:true});
  assert.deepEqual(c,generateSimulation(c.config)); assert.equal(c.attempts,88); assert.equal(c.targetReached,true);
  assert.ok(c.reports.every(r => r.alpha! >= .5 && r.alpha! <= .7)); assert.equal(Object.keys(c.rows[0]!.answers).length,68);
  assert.deepEqual(validateSimulation(c),c); assert.throws(() => parseSource("simulation.json",JSON.stringify(c)));
});
it("exhaustion is a failed target, and forged seed/report/provenance are rejected", () => {
  const c = generateSimulation({seed:"exhaust",conditionOnAlpha:true,minAlpha:1,maxAlpha:1,maxAttempts:1}); assert.equal(c.targetReached,false);
  assert.throws(() => validateSimulation({...c,targetReached:true})); assert.throws(() => validateSimulation({...c,reports:c.reports.map(r => ({...r,alpha:.6}))}));
  assert.throws(() => validateSimulation({...c,data_origin:"observed"})); assert.throws(() => simulationConfigSchema.parse({seed:"a",count:251}));
  const un = generateSimulation({seed:"unconditional"}); assert.equal(un.attempts,1); assert.equal(un.targetReached,null);
});
