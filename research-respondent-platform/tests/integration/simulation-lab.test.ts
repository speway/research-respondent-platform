/** Isolated generated fixtures, never published respondent records. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { Cabinet, cabinetConfiguration } from "../../lib/services/cabinet.ts";
import { SimulationLab } from "../../lib/services/simulation-lab.ts";
import { hashPassword } from "../../lib/services/password.ts";
import type { CabinetStore } from "../../lib/services/cabinet-store.ts";
function fixture() {
  const config = cabinetConfiguration({RRP_CABINET_STORE_ID:"store_fixture",RRP_CABINET_ACCOUNTS:JSON.stringify([ {id:"owner",login:"owner",label:"Owner",password:hashPassword("fixture-lab-password")}, {id:"team",login:"team",label:"Team",password:hashPassword("fixture-team-password")} ])})!;
  let now = Date.parse("2026-10-13T00:00:00Z"), seq = 0;
  const records = new Map<string,{body:string;etag:string}>(), store: CabinetStore = {async read(p){return records.get(p) ?? null;}, async write(p,v,e){const previous=records.get(p);if(e ? previous?.etag!==e : !!previous) throw new BlobPreconditionFailedError(); records.set(p,{body:JSON.stringify(v),etag:String(++seq)});},async paths(p){return [...records.keys()].filter(k=>k.startsWith(p));}};
  return {config,store,owner:config.accounts[0]!,team:config.accounts[1]!,lab:new SimulationLab(config,store,()=>now),cabinet:new Cabinet(config,store,()=>now),advance:(ms:number)=>{now+=ms;}};
}
it("simulation persists, stays account-scoped and cannot become an empirical project",async()=>{
  const f=fixture(), {asset,cohort}=await f.lab.generate(f.owner,{seed:"persist"});
  assert.deepEqual((await new SimulationLab(f.config,f.store).cohort(f.owner,asset.id)).cohort,cohort);
  await assert.rejects(f.lab.cohort(f.team,asset.id),{status:404});
  await assert.rejects(f.cabinet.upload(f.owner,{kind:"source",name:"simulation.json",reference:"test",rights:"test",base64:Buffer.from(JSON.stringify(cohort)).toString("base64")}),{status:400});
  await assert.rejects(f.cabinet.createProject(f.owner,{name:"Test",sourceId:asset.id,questionnaireIds:[],formUrl:"https://docs.google.com/forms/d/e/fixture/viewform",purpose:"test",idHeader:"id",criteria:[]}),/фактических/);
  assert.equal((await f.cabinet.catalog(f.owner)).projects.length,0);
});
it("lab grants cannot access empirical bank or submit; revocation and expiry take effect",async()=>{
  const f=fixture(), {asset}=await f.lab.generate(f.owner,{seed:"grant"}), key=await f.lab.key(f.owner,asset.id);
  const bundle=await f.lab.forAgent(key.token);assert.equal(bundle.permissions.mayStartOrSubmit,false);assert.equal(bundle.asset.id,asset.id);
  await assert.rejects(f.cabinet.forAgent(key.token),{status:401}); await assert.rejects(f.lab.revoke(f.team,key.keyId),{status:404});
  await f.lab.revoke(f.owner,key.keyId);await assert.rejects(f.lab.forAgent(key.token),{status:401});
  const next=await f.lab.key(f.owner,asset.id);f.advance(86400001);await assert.rejects(f.lab.forAgent(next.token),{status:401});
});
it("actual-source analysis checks named columns, reports exclusions and leaves stored bytes unchanged",async()=>{
  const f=fixture(),asset=await f.cabinet.upload(f.owner,{kind:"source",name:"scale.csv",reference:"isolated fixture",rights:"test",base64:Buffer.from("participant_id,a,b\nTEST-A,1,5\nTEST-B,2,4\nTEST-C,3,3\nTEST-D,,2\nTEST-E,9,1\n").toString("base64")}), before=await f.cabinet.asset(f.owner,asset.id);
  const r=await f.lab.measure(f.owner,{sourceId:asset.id,scales:[{name:"Scale",columns:["a","b"],reverseColumns:["b"],low:1,high:5}]});
  assert.equal(r.reports[0]!.alpha,1);assert.equal(r.reports[0]!.missingRows,1);assert.equal(r.reports[0]!.invalidRows,1);assert.equal(r.sourceModified,false);
  assert.deepEqual(await f.cabinet.asset(f.owner,asset.id),before);
  await assert.rejects(f.lab.measure(f.owner,{sourceId:asset.id,scales:[{name:"Bad",columns:["a","unknown"],low:1,high:5}]}),{status:400});assert.equal((await f.cabinet.catalog(f.owner)).assets.length,1);
});
