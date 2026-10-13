import assert from "node:assert/strict";
import { it } from "node:test";
import { readQuorumTask, runQuorumAgent } from "../../tools/quorum-agent/client.mjs";
import { addPerson, addExperiment, quorumFixture, scopedKey, fixturePrediction } from "../helpers/quorum-fixture.ts";
it("JS agent client reads a real scoped fixture, invokes one predictor and commits one forecast",async()=>{
  const f=quorumFixture(),p=await addPerson(f,"person-a"),id=await addExperiment(f,[p.id]),key=await scopedKey(f,id,p.id,"personal");let calls=0,posts=0;
  const transport: typeof fetch=async (_url,options)=>{assert.equal(options!.redirect,"error");if(options!.method==="POST"){posts++;return Response.json(await f.q.predict(key.token,JSON.parse(options!.body as string)));}return Response.json(await f.q.agentTask(key.token));};
  const result=await runQuorumAgent({site:"https://quorum.example.test",token:key.token,transport,predict:async task=>{calls++;assert.ok(task.profile);return fixturePrediction({q1:3,q2:"A"});}});
  assert.ok("predictionSha256" in result && result.predictionSha256);assert.equal(calls,1);assert.equal(posts,1);
  await runQuorumAgent({site:"https://quorum.example.test",token:key.token,transport,predict:async()=>{calls++;throw new Error("must not repeat");}});assert.equal(calls,1);assert.equal(posts,1);
  await assert.rejects(readQuorumTask({site:"https://quorum.example.test/?token=bad",token:key.token,transport}));
});
it("JS client refuses baseline profile leaks and never retries a failed write",async()=>{
  const token="x".repeat(43);await assert.rejects(readQuorumTask({site:"https://quorum.example.test",token,transport:async()=>Response.json({schema:"quorum.agent-task.v1",arm:"baseline",profile:{},questions:[],permissions:{readHumanAnswers:false,readOtherArm:false,externalSubmission:false}})}),/over-scoped/);
  let posts=0;await assert.rejects(runQuorumAgent({site:"https://quorum.example.test",token,predict:async()=>fixturePrediction({q1:2,q2:"A"}),transport:async (_u,o)=>{if(o!.method==="POST"){posts++;return Response.json({},{status:503});}return Response.json({schema:"quorum.agent-task.v1",arm:"baseline",questions:[],permissions:{readHumanAnswers:false,readOtherArm:false,externalSubmission:false}});}}),/503/);assert.equal(posts,1);
});
