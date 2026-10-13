import assert from "node:assert/strict";
import { it } from "node:test";
import { compareQuorumAnswers, participantBootstrap, quorumQuestionsSchema, validateQuorumAnswers } from "../../lib/domain/quorum.ts";
it("comparison scores exact codes and normalized ordinal errors without alpha or response mutation", () => {
  const questions = quorumQuestionsSchema.parse([{ id:"a",label:"a",kind:"scale",low:0,high:4 },{ id:"b",label:"b",kind:"choice",options:[{code:"A",label:"First"},{code:"B",label:"Second"}] },{ id:"t",label:"text",kind:"text" }]);
  const a = {a:0,b:"A",t:"first text"}, b = {a:2,b:"B",t:"different text"}, before=JSON.stringify(a);
  const r=compareQuorumAnswers(questions,a,b);assert.equal(r.exactRate,0);assert.equal(r.normalizedError,.75);assert.equal(r.scaleMAE,2);assert.equal(r.textItems,1);assert.equal(JSON.stringify(a),before);
  assert.throws(()=>validateQuorumAnswers(questions,{...a,a:5}));assert.throws(()=>validateQuorumAnswers(questions,{...a,b:0}));assert.throws(()=>validateQuorumAnswers(questions,{...a,extra:1}));
});
it("optional missing values stay missing and text is not declared exact-match evidence",()=>{
  const q=quorumQuestionsSchema.parse([{id:"a",label:"a",kind:"scale",low:1,high:5,required:false},{id:"t",label:"t",kind:"text"}]);
  const r=compareQuorumAnswers(q,{a:null,t:"text"},{a:1,t:"text"});assert.equal(r.missingPairs,1);assert.equal(r.exactRate,null);assert.equal(r.normalizedError,null);assert.equal(r.textItems,1);
  assert.throws(()=>quorumQuestionsSchema.parse([{id:"a",label:"a",kind:"scale",low:1,high:5},{id:"a",label:"dup",kind:"scale",low:1,high:5}]));
});
it("uncertainty resamples participant values reproducibly, and one person has no interval",()=>{
  assert.equal(participantBootstrap([.4]),null);assert.deepEqual(participantBootstrap([0,.5,1]),participantBootstrap([0,.5,1]));
  const ci=participantBootstrap([.2,.2,.2])!;assert.ok(Math.abs(ci.low-.2)<1e-12);assert.ok(Math.abs(ci.high-.2)<1e-12);
});
