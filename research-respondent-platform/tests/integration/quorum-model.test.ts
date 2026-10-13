import assert from "node:assert/strict";
import { it } from "node:test";
import { quorumModelStatus, runQuorumPrediction, QUORUM_PROMPT_VERSION, QUORUM_MODEL_SETTINGS } from "../../lib/services/quorum-model.ts";
import { quorumFixture, addPerson, addExperiment } from "../helpers/quorum-fixture.ts";
function env(f: ReturnType<typeof quorumFixture>) { return { VERCEL:"1",VERCEL_ENV:"production",RRP_CABINET_STORE_ID:f.config.storeId,RRP_CABINET_ACCOUNTS:JSON.stringify(f.config.accounts),RRP_QUORUM_AI:"1",VERCEL_OIDC_TOKEN:"fixture-token-never-external" }; }
it("hosted inference is default-off and refuses unauthorized callers without network",async()=>{
  assert.equal(quorumModelStatus({}).enabled,false);const f=quorumFixture("production");
  await assert.rejects(runQuorumPrediction("team",{},env(f)),{status:403});await assert.rejects(runQuorumPrediction("owner",{},{}),{status:503});
});
it("one bounded Gateway call commits a provenance receipt; baseline receives no profile and no extra noise",async()=>{
  const f=quorumFixture("production"),p=await addPerson(f,"person-a"),id=await addExperiment(f,[p.id],{promptVersion:QUORUM_PROMPT_VERSION,settings:QUORUM_MODEL_SETTINGS});let calls=0;
  const transport: typeof fetch=async (url,options)=>{
    if(String(url).endsWith("/models")) return Response.json({data:[{id:"fixture/model"}]});
    calls++;const body=JSON.parse(options!.body as string);assert.equal(body.temperature,0);assert.equal(body.max_tokens,4096);const payload=JSON.parse(body.messages[1].content);
    assert.equal("profile" in payload,calls===1);assert.equal("human" in payload,false);assert.equal("retest" in payload,false);
    return Response.json({id:`fixture-generation-${calls}`,model:"fixture/model",choices:[{finish_reason:"stop",message:{content:'{"answers":{"q1":3,"q2":"A"}}'}}],usage:{prompt_tokens:10,completion_tokens:5}});
  };
  const invoke=(arm:string)=>runQuorumPrediction("owner",{command:"run_prediction",experimentId:id,participantId:p.id,arm,confirmModelProcessing:true},env(f),{store:f.store,fetch:transport,now:f.now});
  await invoke("personal");await invoke("baseline");assert.equal(calls,2);await assert.rejects(invoke("personal"),{status:409});assert.equal(calls,2);
  await f.q.studentCommand(p.id,{command:"human",experimentId:id,phase:"first",answers:{q1:3,q2:"A"},consent:true,humanAttestation:true});
  const r=await f.q.report("owner",id);assert.equal(r.perParticipant[0]!.execution!.generationId,"fixture-generation-1");assert.equal(r.perParticipant[0]!.personal.exactRate,1);
  const admin=await f.q.admin("owner");assert.equal(admin.modelAttempts.length,2);assert.ok(admin.grants.every(g=>g.revoked));
});
it("failed or unknown inference is recorded and cannot silently generate another candidate",async()=>{
  const f=quorumFixture("production"),p=await addPerson(f,"person-a"),id=await addExperiment(f,[p.id],{promptVersion:QUORUM_PROMPT_VERSION,settings:QUORUM_MODEL_SETTINGS});let calls=0;
  const transport: typeof fetch=async url=>{if(String(url).endsWith("/models")) return Response.json({data:[{id:"fixture/model"}]});calls++;return Response.json({error:"fixture exhausted budget"},{status:402});};
  const invoke=()=>runQuorumPrediction("owner",{command:"run_prediction",experimentId:id,participantId:p.id,arm:"personal",confirmModelProcessing:true},env(f),{store:f.store,fetch:transport,now:f.now});
  await assert.rejects(invoke(),{status:402});await assert.rejects(invoke(),{status:409});assert.equal(calls,1);
  assert.equal((await f.q.admin("owner")).modelAttempts[0]!.status,"failed_or_unknown");assert.equal((await f.q.report("owner",id)).actualN,0);
});
