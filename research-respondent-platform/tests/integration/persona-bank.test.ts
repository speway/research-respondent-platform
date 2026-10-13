import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { PersonaBank } from "../../lib/services/persona-bank.ts";
import { runCloudPersonaJob, type PersonaSandboxFactory } from "../../lib/services/persona-worker.ts";
import { runModeledPrediction } from "../../lib/domain/persona-prediction.ts";
import { Cabinet } from "../../lib/services/cabinet.ts";
import { SimulationLab } from "../../lib/services/simulation-lab.ts";
import type { PersonaJob, PersonaCohort } from "../../lib/domain/personas.ts";
import { quorumFixture } from "../helpers/quorum-fixture.ts";
const parameters={count:4,seed:42,age_min:18,age_max:30,topic:"education",conditions:{stress:50,support:50,fatigue:30}};
const generation:PersonaJob={protocol_version:"1",request_id:"fixture",data_origin:"modeled",operation:"generate",parameters:parameters as never};
function worker(job:PersonaJob){const r=spawnSync("python3",["tools/psychological-personas/scripts/worker.py"],{input:JSON.stringify(job),encoding:"utf8",env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},timeout:15000,maxBuffer:3*1024*1024});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function fixture(){const f=quorumFixture();const owner=f.config.accounts[0]!;return {...f,owner,bank:new PersonaBank(f.config,f.store,f.now)};}
it("real Python -> durable envelope -> JS roundtrip -> adaptation retains ID, seed, core and prior episodes",async()=>{
  const f=fixture(),id=randomUUID();const job=await f.bank.reserve(f.owner,{requestId:id,name:"Initial",operation:"generate",parameters});
  let launches=0;await f.bank.dispatch(job,async()=>{launches++;return "wrun_fixture";});await f.bank.execute(f.owner.id,id,async input=>worker(input));
  const first=await new PersonaBank(f.config,f.store,f.now).envelope(f.owner,id);
  assert.equal((await f.bank.view(f.owner.id,id)).status,"completed");
  const adaptedId=randomUUID(),scenario={topic:"ai-decisions",conditions:{stress:85,support:30,fatigue:70}};
  const next=await f.bank.reserve(f.owner,{requestId:adaptedId,name:"Adaptation",operation:"adapt",parameters:scenario,cohortId:id});
  await f.bank.dispatch(next,async()=>"wrun_adapt");await f.bank.execute(f.owner.id,adaptedId,async input=>worker(input));
  const adapted=await f.bank.envelope(f.owner,adaptedId);assert.deepEqual(adapted.asset.parent,{id,sha256:first.asset.sha256});
  first.cohort.personas.forEach((p,i)=>{const a=adapted.cohort.personas[i]!;assert.equal(a.id,p.id);assert.equal(a.person_seed,p.person_seed);assert.equal(a.model_version,p.model_version);assert.equal(a.core_fingerprint,p.core_fingerprint);assert.deepEqual(a.core,p.core);assert.deepEqual(a.episodes.slice(0,1),p.episodes);assert.equal(a.episodes.length,2);});
  assert.ok(first.cohort.personas.some(p=>BigInt(p.person_seed)>BigInt(Number.MAX_SAFE_INTEGER)));
  assert.deepEqual(await f.bank.envelope(f.owner,id),first);
  await f.bank.dispatch(job,async()=>{launches++;return "unexpected";});assert.equal(launches,1);
});
it("import is immutable, account/environment scoped and cannot enter observed sources or Quorum",async()=>{
  const f=fixture(),cohort=worker(generation).cohort as PersonaCohort,id=randomUUID();
  const saved=await f.bank.import(f.owner,id,"Import",cohort);assert.deepEqual(await f.bank.import(f.owner,id,"Import",cohort),saved);
  await assert.rejects(f.bank.import(f.owner,id,"Different",cohort),{status:409});
  await assert.rejects(new PersonaBank({...f.config,namespace:"preview"},f.store,f.now).envelope(f.owner,id),{status:404});
  const cabinet=new Cabinet(f.config,f.store,f.now);
  await assert.rejects(cabinet.upload(f.owner,{kind:"source",name:"personas.json",reference:"fixture",rights:"fixture",base64:Buffer.from(JSON.stringify(cohort)).toString("base64")}),{status:400});
  await assert.rejects(f.q.studentCommand(randomUUID(),{command:"profile",profile:cohort}));
  assert.equal((await cabinet.catalog(f.owner)).assets.length,0);
  const changed=structuredClone(cohort);changed.personas[0]!.core.bfi2_facets!.sociability!+=1;
  await assert.rejects(f.bank.import(f.owner,randomUUID(),"Tampered",changed));
});
it("one bounded cloud dispatch wins concurrently; same request cannot change parameters or rerun Python",async()=>{
  const f=fixture(),id=randomUUID(),input={requestId:id,name:"Concurrency",operation:"generate" as const,parameters};
  const reserved=await Promise.all(Array.from({length:8},()=>f.bank.reserve(f.owner,input)));assert.ok(reserved.every(j=>j.id===id));
  let launches=0;await Promise.all(reserved.map(job=>f.bank.dispatch(job,async()=>{launches++;return "wrun_one";})));assert.equal(launches,1);
  await assert.rejects(f.bank.reserve(f.owner,{...input,parameters:{...parameters,seed:99}}),{status:409});
  let runs=0;const results=await Promise.allSettled(Array.from({length:4},()=>f.bank.execute(f.owner.id,id,async input=>{runs++;return worker(input);})));assert.equal(runs,1);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
});
it("cancel, expiry, malformed response and changed password stop results; unknown dispatch is never retried",async()=>{
  for(const stop of ["cancel","expiry","password","invalid"]){const f=fixture(),id=randomUUID(),job=await f.bank.reserve(f.owner,{requestId:id,name:stop,operation:"generate",parameters});await f.bank.dispatch(job,async()=>"wrun_fixture");
    await assert.rejects(f.bank.execute(f.owner.id,id,async input=>{if(stop==="cancel")await f.bank.cancel(f.owner,id);if(stop==="expiry")f.advance(31*60000);if(stop==="password")f.owner.password={...f.owner.password,hash:"changed"};return stop==="invalid"?{}:worker(input);}));assert.equal((await f.bank.catalog(f.owner)).length,0);
  }
  const f=fixture(),id=randomUUID(),job=await f.bank.reserve(f.owner,{requestId:id,name:"Unknown",operation:"generate",parameters});let attempts=0;
  await assert.rejects(f.bank.dispatch(job,async()=>{attempts++;throw new Error("lost registration");}));
  assert.equal((await f.bank.view(f.owner.id,id)).status,"execution_uncertain");await f.bank.dispatch(job,async()=>{attempts++;return "retry";});assert.equal(attempts,1);
});
it("global daily cloud budget is not bypassed by new request IDs",async()=>{
  const f=fixture();let count=0;for(let i=0;i<5;i++){const job=await f.bank.reserve(f.owner,{requestId:randomUUID(),name:"Budget",operation:"generate",parameters});await f.bank.dispatch(job,async()=>{count++;return "wrun_fixture";});}
  const blocked=await f.bank.reserve(f.owner,{requestId:randomUUID(),name:"Blocked",operation:"generate",parameters});await assert.rejects(f.bank.dispatch(blocked,async()=>{count++;return "unexpected";}),{status:429});assert.equal(count,5);
});
it("separate grants read one complete envelope; source/lab/Quorum scopes, expiry and revocation are enforced",async()=>{
  const f=fixture(),id=randomUUID(),cohort=worker(generation).cohort;await f.bank.import(f.owner,id,"Grant",cohort);const key=await f.bank.key(f.owner,id),bundle=await f.bank.forAgent(key.token);assert.deepEqual(bundle.envelope.cohort,cohort);assert.equal(bundle.permissions.mayStartOrSubmit,false);
  await assert.rejects(new Cabinet(f.config,f.store,f.now).forAgent(key.token),{status:401});await assert.rejects(new SimulationLab(f.config,f.store,f.now).forAgent(key.token),{status:401});await assert.rejects(f.q.agentTask(key.token));
  await f.bank.revoke(f.owner,key.keyId);await assert.rejects(f.bank.forAgent(key.token),{status:401});
  const expired=await f.bank.key(f.owner,id);f.advance(86400001);await assert.rejects(f.bank.forAgent(expired.token),{status:401});
});
it("prediction adapter keeps original envelope and exact question codes; baseline callback gets no profile",async()=>{
  const f=fixture(),id=randomUUID(),saved=await f.bank.import(f.owner,id,"Prediction",worker(generation).cohort);
  const protocol={modelId:"fixture",promptVersion:"fixture",settings:"fixed",questions:[{id:"Q1",label:"Question",kind:"scale",low:1,high:5,required:true}]};
  for(const arm of ["personal","baseline"] as const){let calls=0;const receipt=await runModeledPrediction(saved,saved.cohort.personas[0]!.id,protocol,arm,async input=>{calls++;const task=input as Record<string,unknown>;assert.equal("persona" in task,arm==="personal");assert.equal("originalEnvelope" in task,false);return {Q1:3};});assert.equal(calls,1);assert.deepEqual(receipt.originalEnvelope,saved);assert.equal(receipt.observedParticipants,0);}
  await assert.rejects(runModeledPrediction(saved,saved.cohort.personas[0]!.id,protocol,"personal",async()=>({Q1:9})));
});
it("actual pinned Python runs through Sandbox adapter with no network, bounded files and finally cleanup",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"rrp-personas-"));let stopped=0;
  const factory:PersonaSandboxFactory=async options=>{assert.equal(options.networkPolicy,"deny-all");assert.equal(options.persistent,false);assert.equal(options.timeout,90000);return {
    async writeFiles(files){for(const f of files){const p=join(dir,f.path.replace("/vercel/sandbox/",""));await mkdir(join(p,".."),{recursive:true});let content=f.content;if(f.path.endsWith("entry.py"))content=Buffer.from(content.toString("utf8").replaceAll("/vercel/sandbox/",`${dir}/`));await writeFile(p,content);}},
    async runCommand(options){assert.equal(options.cmd,"python3");const r=spawnSync("python3",[join(dir,"entry.py")],{encoding:"utf8",timeout:15000,env:{...process.env,...options.env}});assert.ifError(r.error);assert.equal(r.stderr,"");return {exitCode:r.status};},
    async readFileToBuffer(){return readFile(join(dir,"output.json"));},async stop(){stopped++;}
  };};
  try{const result=await runCloudPersonaJob(generation,async()=>{},factory);assert.deepEqual(result,worker(generation));assert.equal(stopped,1);
    let checks=0;await assert.rejects(runCloudPersonaJob(generation,async()=>{checks++;if(checks===2)throw new Error("cancelled");},factory));assert.equal(stopped,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});
