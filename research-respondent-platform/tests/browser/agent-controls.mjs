/** Isolated DOM fixtures only, served to actual Chromium; never empirical responses. */
/* global window, document */
import assert from "node:assert/strict";
import process from "node:process";
import { log } from "node:console";
import { createHash } from "node:crypto";
import { runFormTask, auditFirstSection } from "../../tools/browser-agent/runner.mjs";
import { removeTempDb, requireNextBuild, startTestServer } from "../helpers/server.ts";
assert.equal(requireNextBuild(), false);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const server = await startTestServer({ env: { VERCEL: "1", VERCEL_ENV: "preview" } });
const url = "https://docs.google.com/forms/d/e/isolated-controls-fixture/viewform";
const html = String.raw`<!doctype html><html><h1>Isolated controls fixture</h1><main><div role="list"><div role="listitem"><h2>Introduction</h2><p>Information only</p></div></div><button id="next">Next</button></main><script>
window.submits=0;
const main = document.querySelector('main');
const controls = '<h2>Block</h2><div role="list">' +
'<div role="listitem"><h3>Radio matrix <span>*</span></h3><div role="radiogroup" aria-label="Row A"><label><input type="radio" name="rowA" aria-label="Yes">Yes</label><label><input type="radio" name="rowA" aria-label="No">No</label></div><div role="radiogroup" aria-label="Row B"><label><input type="radio" name="rowB" aria-label="Yes">Yes</label><label><input type="radio" name="rowB" aria-label="No">No</label></div></div>' +
'<div role="listitem"><h3>Checkbox matrix <span>*</span></h3><div role="table"><div role="row"><span role="rowheader">Row C</span><input type="checkbox" aria-label="A, B" checked><input type="checkbox" aria-label="C"></div><div role="row"><span role="rowheader">Row D</span><input type="checkbox" aria-label="A, B"><input type="checkbox" aria-label="C" checked></div></div></div>' +
'<div role="listitem"><h3>Native list <span>*</span></h3><select aria-label="Native list" required><option value="">Choose</option><option value="a">Exact</option><option value="b">Other</option></select></div>' +
'<div role="listitem"><h3>Google list <span>*</span></h3><div role="listbox" tabindex="0" aria-label="Google list" onclick="this.classList.add(\'open\')" onkeydown="if(event.key===\'Escape\')this.classList.remove(\'open\')"><span>Choose</span><div class="options"><div role="option" aria-selected="false" onclick="event.stopPropagation();for(const el of this.parentElement.children)el.setAttribute(\'aria-selected\',\'false\');this.setAttribute(\'aria-selected\',\'true\');this.closest(\'[role=listbox]\').classList.remove(\'open\')">Literal</div><div role="option" aria-selected="false">Other</div></div></div></div>' +
'<div role="listitem"><h3>Number <span>*</span></h3><input type="number" min="18" max="99" aria-label="Number" required></div>' +
'<div role="listitem"><h3>Finite choice <span>*</span></h3><input type="radio" name="finite" aria-label="Yes"><input type="radio" name="finite"><input aria-label="Other answer"></div>' +
'</div><button id="submit" onclick="window.submits++">Submit</button>';
document.querySelector('#next').onclick = () => main.innerHTML = controls;
</script><style>.options{display:none}.open .options{display:block}</style></html>`;
let browser;
try {
 browser = await chromium.launch({ headless:true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath:process.env.BROWSER_EXECUTABLE_PATH } : {}), args:["--no-sandbox","--disable-dev-shm-usage"] });
 const context = await browser.newContext(); const panel = await context.newPage(), form = await context.newPage();
 const errors = []; panel.on("pageerror", (e) => errors.push(e.message)); form.on("pageerror", (e) => errors.push(e.message));
 await form.route(url, (route) => route.fulfill({ contentType:"text/html", body:html })); await panel.goto(`${server.baseUrl}/workbench`);
 const observed = await auditFirstSection({ formPage:form, formUrl:url });
 assert.equal(observed.sectionNumber,2);
 assert.deepEqual(observed.observation.questions.map((q) => q.kind), ["single_choice","single_choice","multiple_choice","multiple_choice","dropdown","dropdown","number","single_choice"]);
 assert.deepEqual(observed.observation.questions[0].matrix, { id:"Block/1", title:"Radio matrix", row:"Row A" });
 assert.deepEqual(observed.observation.questions[4].options,["Exact","Other"]); assert.equal(observed.observation.questions[6].min,18);
 assert.equal(await form.getByRole("spinbutton").inputValue(), ""); assert.equal(await form.evaluate(() => window.submits),0);
 const values = { participant_id:"fixture-1", "Block / Radio matrix / Row A":"Yes", "Block / Radio matrix / Row B":"No", "Block / Checkbox matrix / Row C":'["C"]', "Block / Checkbox matrix / Row D":'["A, B","C"]', "Block / Native list":"Exact", "Block / Google list":"Literal", "Block / Number":22, "Block / Finite choice":"Yes" };
 const text = JSON.stringify([values]); const task = {schema:"rrp.agent-task.v1", source:{name:"controls.json",text}, reference:"Isolated fixture", purpose:"DOM controls verification", formUrl:url};
 const grant = {formUrl:url,participantRef:"fixture-1",sourceSha256:createHash("sha256").update(text).digest("hex"),evidenceReference:"Fixture fill only",mayFill:true,maySubmit:false,maxSubmissions:1,expiresAt:new Date(Date.now()+60000).toISOString()};
 const result = await runFormTask({workbenchPage:panel,formPage:form,task,participantRef:"fixture-1",grant});
 assert.equal(result.status,"filled_not_submitted"); assert.equal(await form.evaluate(() => window.submits),0);
 assert.equal(await form.getByRole("radiogroup",{name:"Row A"}).getByRole("radio",{name:"Yes"}).isChecked(),true);
 assert.equal(await form.getByRole("radiogroup",{name:"Row B"}).getByRole("radio",{name:"No"}).isChecked(),true);
 assert.equal(await form.getByRole("row").filter({hasText:"Row C"}).getByRole("checkbox",{name:"A, B",exact:true}).isChecked(),false);
 assert.equal(await form.getByRole("combobox").inputValue(),"a"); assert.equal(await form.getByRole("spinbutton").inputValue(),"22");
 const command = (input) => panel.evaluate((c) => window.respondentWorkbench.execute(c),input);
 const before = await command({command:"status"});
 const reused = await runFormTask({workbenchPage:panel,formPage:form,formUrl:url,participantRef:"fixture-1"}); assert.equal(reused.status,"prepared");
 const after = await command({command:"status"}); assert.equal(after.source.sha256,before.source.sha256);
 await assert.rejects(command({command:"target",expectedRevision:before.revision,formUrl:url}),/Устаревшая/);
 const foreign = await command({command:"target",expectedRevision:after.revision,formUrl:"https://forms.gle/different-fixture"}); assert.equal(foreign.status,"awaiting_form_observation");
 await panel.getByRole("button", {name:/Автоматизация/}).click();
 await panel.getByLabel("Новая ссылка Google Forms").fill(url);
 await panel.getByRole("button", {name:"Использовать эту базу",exact:true}).click();
 await panel.getByRole("status").filter({hasText:"Ссылка принята"}).waitFor();
 assert.equal((await command({command:"status"})).source.sha256,before.source.sha256);
 await panel.setViewportSize({width:390,height:844});
 assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
 if(process.env.BROWSER_SCREENSHOT_DIR) await panel.screenshot({path:process.env.BROWSER_SCREENSHOT_DIR+"/agent-link-controls.png",fullPage:true});
 // Context cannot silently change between introduction/read/preparation/verified fill.
 for (const phase of ["introduction","prepared_section","verified_section"]) {
  await assert.rejects(runFormTask({workbenchPage:panel,formPage:form,task,participantRef:"fixture-1",grant,onProgress:async (event) => {
   if(event.status===phase) { const state=await command({command:"status"}); await command({command:"load",expectedRevision:state.revision,task:{...task,source:{name:"changed.json",text:JSON.stringify([{...values,"Block / Number":33}])}}}); }
  }}),/Workbench changed/);
  assert.equal(await form.evaluate(() => window.submits),0);
 }
 const badText = JSON.stringify([{...values,"Block / Number":17}]);
 const blocked = await runFormTask({workbenchPage:panel,formPage:form,task:{...task,source:{name:"bad.json",text:badText}},participantRef:"fixture-1"}); assert.equal(blocked.status,"blocked"); assert.equal(await form.getByRole("spinbutton").inputValue(),"");
 // Missing optional checkbox values must not transmit a draft selection.
 const optionalHtml=html.replace('Checkbox matrix <span>*</span>','Checkbox matrix'); await form.route(url,(route)=>route.fulfill({contentType:"text/html",body:optionalHtml}));
 const missingText=JSON.stringify([{...values,"Block / Checkbox matrix / Row C":null}]); const missingTask={...task,source:{name:"missing.json",text:missingText}};
 await assert.rejects(runFormTask({workbenchPage:panel,formPage:form,task:missingTask,participantRef:"fixture-1",grant:{...grant,sourceSha256:createHash("sha256").update(missingText).digest("hex")}}),/existing draft/);
 // Unknown file controls must never be mistaken for an intro page and skipped.
 await form.route(url,(route)=>route.fulfill({contentType:"text/html",body:'<h1>Fixture</h1><input type="file"><button>Next</button>'}));
 await assert.rejects(auditFirstSection({formPage:form,formUrl:url}),/Unrecognized question controls/);
 assert.deepEqual(errors,[]); assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM participant").get().count,0);
 log("PASS: actual Chromium intro audit, row-scoped radio/checkbox matrices, exact multi-select/draft denial, native and Google-like dropdown, number bounds, finite choice with Other, link-only source reuse/stale-map invalidation; fixtures only, no submit.");
} finally { await browser?.close(); await server.stop(); removeTempDb(server.dbFile); }
