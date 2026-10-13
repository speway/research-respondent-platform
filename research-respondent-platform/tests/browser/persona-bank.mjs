/** Actual Chromium + real Python + isolated persistence; no paid/provider writes. */
/* global document, window */
import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { PersonaBank } from "../../lib/services/persona-bank.ts";
import { Cabinet } from "../../lib/services/cabinet.ts";
import { quorumFixture } from "../helpers/quorum-fixture.ts";
import { removeTempDb, startTestServer } from "../helpers/server.ts";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??"playwright");
const f=quorumFixture(),owner=f.config.accounts[0],bank=new PersonaBank(f.config,f.store,f.now),cabinet=new Cabinet(f.config,f.store,f.now);
const env={RRP_CABINET_STORE_ID:f.config.storeId,RRP_CABINET_ACCOUNTS:JSON.stringify(f.config.accounts),VERCEL:"1",VERCEL_ENV:"preview"};
const server=await startTestServer({env});let browser;
function worker(input){const r=spawnSync("python3",["tools/psychological-personas/scripts/worker.py"],{input:JSON.stringify(input),encoding:"utf8",env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH}:{}),args:["--no-sandbox","--disable-dev-shm-usage"]});
  const page=await browser.newPage({viewport:{width:1300,height:1000}}),errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/api/cabinet/**",async route=>{
    const request=route.request(),url=new URL(request.url());let body,status=200;
    try{
      if(url.pathname.endsWith("/session"))body={account:{id:owner.id,label:owner.label}};
      else if(url.pathname.endsWith("/personas")){
        if(request.method()==="GET")body=url.searchParams.has("cohort")?await bank.envelope(owner,url.searchParams.get("cohort")):{assets:await bank.catalog(owner),jobs:await bank.jobs(owner),grants:await bank.grants(owner),workerEnabled:true};
        else {assert.equal(request.headers().origin,server.baseUrl);const v=request.postDataJSON();
          if(v.command==="import")body=await bank.import(owner,v.requestId,v.name,v.cohort);
          else if(v.command==="agent_key")body=await bank.key(owner,v.cohortId);
          else if(v.command==="revoke_key"){await bank.revoke(owner,v.keyId);body={revoked:true};}
          else if(v.command==="cancel")body=await bank.cancel(owner,v.jobId);
          else{assert.equal(v.confirmCloudRun,true);const job=await bank.reserve(owner,{requestId:v.requestId,name:v.name,operation:v.command,parameters:v.parameters,...(v.command==="adapt"?{cohortId:v.cohortId}:{})});body=await bank.dispatch(job,async(a,id)=>{await bank.execute(a,id,async input=>worker(input));return "wrun_browser_fixture";});status=202;}
        }
      }else if(url.pathname.endsWith("/catalog"))body=await cabinet.catalog(owner);
      else if(url.pathname.endsWith("/quorum"))body=await f.q.admin(owner.id);
      else if(url.pathname.endsWith("/lab"))body={grants:[]};
      else if(url.pathname.endsWith("/automation"))body={flags:{enabled:false,writes:false},jobs:[]};
      else throw new Error("Unexpected fixture endpoint");
    }catch(e){status=e.status??400;body={error:e.message};}
    await route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
  });
  process.stdout.write("Persona UI: open\n");await page.goto(`${server.baseUrl}/cabinet`);const panel=page.getByRole("region",{name:"Банк психологических персон"});await panel.getByRole("heading",{name:"Психологические персоны",exact:true}).waitFor();
  process.stdout.write("Persona UI: generate\n");const generate=panel.getByRole("heading",{name:"Создать или адаптировать"}).locator("..");
  await generate.getByLabel("Название версии").fill("Browser personas");await generate.getByLabel("Количество",{exact:true}).fill("4");await generate.getByRole("checkbox").check();await generate.getByRole("button",{name:"Запустить Python worker"}).click();
  await panel.locator("strong").filter({hasText:"Browser personas"}).waitFor();let assets=await bank.catalog(owner);assert.equal(assets.length,1);const first=await bank.envelope(owner,assets[0].id);
  process.stdout.write("Persona UI: reload/adapt\n");await page.reload();await generate.getByLabel("Операция").selectOption("adapt");await generate.getByLabel("Исходный набор").selectOption(first.asset.id);await generate.getByLabel("Название версии").fill("New gaming situation");await generate.getByLabel("Тема").selectOption("gaming");await generate.getByLabel("Стресс",{exact:true}).fill("85");await generate.getByRole("checkbox").check();await generate.getByRole("button",{name:"Запустить Python worker"}).click();
  await panel.locator("strong").filter({hasText:"New gaming situation"}).waitFor();assets=await bank.catalog(owner);assert.equal(assets.length,2);const adapted=await bank.envelope(owner,assets.find(a=>a.name==="New gaming situation").id);assert.deepEqual(adapted.cohort.personas.map(p=>p.core),first.cohort.personas.map(p=>p.core));assert.equal(adapted.cohort.personas[0].episodes.length,2);
  process.stdout.write("Persona UI: grant\n");await panel.getByRole("button",{name:"Передать персон агенту"}).first().click();await panel.getByLabel("Инструкция и ключ персон для агента").waitFor();const prompt=await panel.getByLabel("Инструкция и ключ персон для агента").inputValue();const token=prompt.match(/Bearer ([A-Za-z0-9_-]{43})/)[1];const bundle=await bank.forAgent(token);assert.equal(bundle.envelope.cohort.data_origin,"modeled");await panel.getByRole("button",{name:"Отозвать ключ персон"}).click();await assert.rejects(bank.forAgent(token));
  const upload=panel.getByRole("heading",{name:"Загрузить готовых персон"}).locator("..");await upload.getByLabel("Название набора").fill("Imported envelope");await upload.getByLabel("JSON персон до 2 МБ").setInputFiles({name:"personas.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(first))});await upload.getByRole("button",{name:"Сохранить персон",exact:true}).click();await panel.locator("strong").filter({hasText:"Imported envelope"}).waitFor();assert.equal((await bank.catalog(owner)).length,3);assert.equal((await cabinet.catalog(owner)).assets.length,0);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);assert.deepEqual(errors,[]);
  process.stdout.write("Persona browser flow passed: generate/reload/adapt/seed-core/grant/revoke/import/mobile. Isolated worker/store.\n");
}finally{if(browser)await browser.close();await server.stop();removeTempDb(server.dbFile);}
