/** Portable Playwright page adapter. Caller supplies an officially authorized browser.
 * No browser startup, credential entry, hidden form metadata or HTTP submission here.
 */
/* global document, window */
import { createHash } from "node:crypto";
import { URL } from "node:url";

const allowedUrl = (raw) => {
  try { const u = new URL(raw); return u.protocol === "https:" && !u.username && !u.password && (u.hostname === "forms.gle" || (u.hostname === "docs.google.com" && u.pathname.startsWith("/forms/"))); } catch { return false; }
};
const nextButton = (page) => page.getByRole("button", { name: /^(Next|Далее)$/ });
const submitButton = (page) => page.getByRole("button", { name: /^(Submit|Отправить)$/ });
const recorded = (page) => page.getByText(/^(Your response has been recorded\.?|Ответ записан\.?|Ваш ответ записан\.?)$/);
const signature = (o) => JSON.stringify({ title: o.title, questions: o.questions });
async function exactOne(locator, label) {
  if (await locator.count() !== 1 || !await locator.isVisible()) throw new Error(`Unsupported or ambiguous visible UI: ${label}.`);
  return locator;
}
async function visibleOptions(locator) {
  const labels = [];
  for (const option of await locator.all()) {
    if (!await option.isVisible()) continue;
    const name = await option.getAttribute("aria-label") ?? (await option.innerText()).trim();
    if (!name) throw new Error("An option has no readable exact label.");
    labels.push(name);
  }
  return labels;
}
async function visibleControls(group, role) {
  const result = [];
  for (const el of await group.getByRole(role).all()) if (await el.isVisible()) result.push(el);
  return result;
}
async function dropdownOptions(list) {
  if (await list.evaluate((el) => el.tagName === "SELECT")) {
    return list.locator("option").evaluateAll((els) => els.filter((el) => !el.disabled && el.value !== "").map((el) => el.textContent.trim()));
  }
  await list.click();
  try { return await visibleOptions(list.getByRole("option")); }
  finally { await list.press("Escape"); }
}
export async function readVisibleSection(page, { requestedUrl, sectionNumber = 1 } = {}) {
  if (!allowedUrl(page.url()) || !allowedUrl(requestedUrl)) throw new Error("Destination is not an allowed Google Forms URL.");
  const title = (await (await exactOne(page.getByRole("heading", { level: 1 }), "form title")).innerText()).trim();
  const sectionHeadings = page.getByRole("heading", { level: 2 });
  if (await sectionHeadings.count() > 1) throw new Error("Section headings are ambiguous; use the full skill reader.");
  const section = await sectionHeadings.count() ? (await sectionHeadings.innerText()).trim() : "";
  const questions = [], groups = [];
  for (const group of await page.getByRole("listitem").all()) {
    if (!await group.isVisible()) continue;
    const heading = group.getByRole("heading", { level: 3 });
    const controls = group.locator('input:not([type="hidden"]),textarea,select,[role="radio"],[role="checkbox"],[role="combobox"],[role="listbox"]');
    if (!await heading.count() && !await controls.count()) continue; // section heading / instructions
    await exactOne(heading, "question heading");
    const hasMarker = await heading.getByText("*", { exact: true }).count() > 0;
    const text = (await heading.innerText()).trim().replace(hasMarker ? /\s*\*$/ : /$^/, "");
    const required = hasMarker || await group.locator('[aria-required="true"], input[required], textarea[required]').count() > 0;
    const parentId = `${section || `section-${sectionNumber}`}/${questions.length + 1}`;
    // Only explicit accessible row boundaries may partition a matrix. Never flatten radios.
    let rows = await visibleControls(group, "radiogroup");
    const tableRows = await visibleControls(group, "row");
    if (tableRows.some((row) => row)) {
      const answerRows = [];
      for (const row of tableRows) if (await row.getByRole("radio").or(row.getByRole("checkbox")).count()) answerRows.push(row);
      if (answerRows.length) rows = answerRows;
    }
    const matrix = rows.length > 1 || (rows.length === 1 && await rows[0].getByRole("rowheader").count() === 1);
    if (matrix) {
      const names = [];
      for (const [index, row] of rows.entries()) {
        let name = await row.getAttribute("aria-label");
        if (!name && await row.getByRole("rowheader").count() === 1) name = (await row.getByRole("rowheader").innerText()).trim();
        if (!name || names.includes(name)) throw new Error("Matrix row labels are missing or duplicated.");
        names.push(name);
        const radios = await visibleControls(row, "radio"), checks = await visibleControls(row, "checkbox");
        const kind = radios.length && !checks.length ? "single_choice" : checks.length && !radios.length ? "multiple_choice" : "unsupported";
        const options = kind === "unsupported" ? [] : await visibleOptions(row.getByRole(kind === "single_choice" ? "radio" : "checkbox"));
        questions.push({ id: `${parentId}/row-${index + 1}`, section, text: `${text} / ${name}`, kind, required, options, matrix: { id: parentId, title: text, row: name } });
        groups.push(row);
      }
      continue;
    }
    const inputs = group.getByRole("textbox"), numbers = group.getByRole("spinbutton"), radios = group.getByRole("radio"), checks = group.getByRole("checkbox");
    const lists = group.getByRole("combobox").or(group.getByRole("listbox"));
    let kind = "unsupported", options = [], bounds = {};
    if (!await checks.count() && !await lists.count() && !await radios.count() && await inputs.count() + await numbers.count() === 1) {
      const input = inputs.or(numbers);
      const type = await input.getAttribute("type");
      kind = type === "number" ? "number" : await input.evaluate((el) => el.tagName === "TEXTAREA") ? "paragraph" : "text";
      if (kind === "number") for (const bound of ["min", "max"]) {
        const raw = await input.getAttribute(bound);
        if (raw !== null && raw.trim() && Number.isFinite(Number(raw))) bounds[bound] = Number(raw);
      }
    }
    // A known labeled radio remains usable alongside Google's unlabelled Other + textbox.
    // Unnamed Other is never selected/inferred; a source value outside options blocks.
    if (!await checks.count() && !await lists.count() && await radios.count() && await inputs.count() <= 1) {
      const labeled = [];
      for (const radio of await radios.all()) if (await radio.isVisible()) {
        const label = await radio.getAttribute("aria-label") ?? (await radio.innerText()).trim();
        if (label) labeled.push(label);
        else if (!await inputs.count()) throw new Error("An option has no readable exact label.");
      }
      if (labeled.length) { kind = "single_choice"; options = labeled; }
    }
    if (await checks.count() && !await radios.count() && !await inputs.count() && !await lists.count()) { kind = "multiple_choice"; options = await visibleOptions(checks); }
    if (await lists.count() === 1 && !await inputs.count() && !await numbers.count() && !await radios.count() && !await checks.count()) { kind = "dropdown"; options = await dropdownOptions(lists); }
    questions.push({ id: parentId, section, text, kind, required, options, ...bounds }); groups.push(group);
  }
  if (!questions.length) {
    const controls = page.locator('input:not([type="hidden"]),textarea,select,[role="radio"],[role="checkbox"],[role="combobox"],[role="listbox"]');
    for (const control of await controls.all()) if (await control.isVisible()) throw new Error("Unrecognized question controls; do not skip this page.");
    await exactOne(nextButton(page), "introductory Next button");
    if (await submitButton(page).count()) throw new Error("Empty final form is not an introduction.");
    return { introduction: true, key: JSON.stringify([title, section, await page.getByRole("list").allTextContents()]), groups: [] };
  }
  const complete = sectionNumber === 1 && await submitButton(page).count() === 1 && await nextButton(page).count() === 0;
  return { observation: { schema: "rrp.observed-form.v1", url: page.url(), requestedUrl, title, scope: complete ? "complete_form" : "visible_section", observedAt: new Date().toISOString(), method: "visible_ui", questions }, groups };
}
const answerInput = (group) => group.getByRole("textbox").or(group.getByRole("spinbutton"));
async function draftIsEmpty(group) {
  for (const input of await answerInput(group).all()) if (await input.inputValue() !== "") return false;
  for (const item of await group.getByRole("radio").or(group.getByRole("checkbox")).all()) if (await item.isChecked()) return false;
  for (const list of await group.getByRole("combobox").or(group.getByRole("listbox")).all()) {
    if (await list.evaluate((el) => el.tagName === "SELECT" ? el.value !== "" : !!el.querySelector('[role="option"][aria-selected="true"]:not([data-placeholder])'))) return false;
  }
  return true;
}
async function fillAndVerify(page, groups, actions) {
  for (const [i, action] of actions.entries()) {
    const group = groups[i];
    if (action.action === "skip_optional") {
      if (!await draftIsEmpty(group)) throw new Error("Optional missing answer has an existing draft value or selection.");
      continue;
    }
    if (action.action === "fill") {
      await (await exactOne(answerInput(group), "answer input")).fill(String(action.value));
    } else if (action.action === "select_radio") {
      // An Other draft must not silently survive selecting a finite option.
      for (const input of await answerInput(group).all()) if (await input.inputValue() !== "") throw new Error("An Other draft exists; inspect it before filling.");
      const radio = await exactOne(group.getByRole("radio", { name: String(action.value), exact: true }), "answer option");
      if (!await radio.isChecked()) await radio.click();
      await page.waitForFunction((el) => el.checked === true || el.getAttribute("aria-checked") === "true", await radio.elementHandle(), { timeout: 5000 });
    } else if (action.action === "select_checkboxes") {
      for (const check of await group.getByRole("checkbox").all()) {
        const label = await check.getAttribute("aria-label") ?? (await check.innerText()).trim();
        const shouldCheck = action.selectedOptions.includes(label);
        if (await check.isChecked() !== shouldCheck) await check.click();
        await page.waitForFunction(({ el, checked }) => (el.checked === true || el.getAttribute("aria-checked") === "true") === checked, { el: await check.elementHandle(), checked: shouldCheck }, { timeout: 5000 });
      }
    } else if (action.action === "select_option") {
      const list = await exactOne(group.getByRole("combobox").or(group.getByRole("listbox")), "dropdown");
      if (await list.evaluate((el) => el.tagName === "SELECT")) await list.selectOption({ label: String(action.value) });
      else {
        await list.click();
        await (await exactOne(list.getByRole("option", { name: String(action.value), exact: true }), "dropdown option")).click();
      }
    } else throw new Error("Unsupported action; pass this section to the full skill reader.");
  }
  for (const [i, action] of actions.entries()) {
    const group = groups[i];
    if (action.action === "skip_optional" && !await draftIsEmpty(group)) throw new Error("Missing source value acquired a draft selection.");
    if (action.action === "fill" && await answerInput(group).inputValue() !== String(action.value)) throw new Error("Entered text differs from the literal source.");
    if (action.action === "select_radio") {
      const selected = [];
      for (const item of await group.getByRole("radio").all()) if (await item.isChecked()) selected.push(await item.getAttribute("aria-label") ?? (await item.innerText()).trim());
      if (JSON.stringify(selected) !== JSON.stringify([String(action.value)])) throw new Error("Selected option is not confirmed exclusively.");
    }
    if (action.action === "select_checkboxes") {
      const selected = [];
      for (const item of await group.getByRole("checkbox").all()) if (await item.isChecked()) selected.push(await item.getAttribute("aria-label") ?? (await item.innerText()).trim());
      if (JSON.stringify(selected.sort()) !== JSON.stringify([...action.selectedOptions].sort())) throw new Error("Checkbox selections differ from the exact source set.");
    }
    if (action.action === "select_option") {
      const list = group.getByRole("combobox").or(group.getByRole("listbox"));
      const selected = await list.evaluate((el) => el.tagName === "SELECT" ? Array.from(el.selectedOptions).map((o) => o.textContent.trim()) : Array.from(el.querySelectorAll('[role="option"][aria-selected="true"]')).map((o) => o.getAttribute("aria-label") ?? o.textContent.trim()));
      if (JSON.stringify(selected) !== JSON.stringify([String(action.value)])) throw new Error("Dropdown selection is not confirmed.");
    }
  }
}
async function advance(page) {
  const oldHeadings = await page.locator('[role="heading"],h1,h2,h3').allTextContents();
  await (await exactOne(nextButton(page), "Next button")).click();
  try {
    await page.waitForFunction((old) => JSON.stringify(Array.from(document.querySelectorAll('[role="heading"],h1,h2,h3')).map((el) => el.textContent)) !== JSON.stringify(old), oldHeadings, { timeout: 5000 });
  } catch { throw new Error("Next did not reveal a different section. Inspect validation; do not retry blindly."); }
}

/** Prepares by default. Fill/submit grants bind recipient, ONE participant and source hash.
 * journal.claim must atomically reserve a durable key; uncertainty never auto-retries.
 */
async function executeFormTask({ workbenchPage, formPage, task = null, formUrl = null, participantRef, grant = null, journal = null, onProgress = () => {} }) {
  if (grant) grant = Object.freeze({ ...grant });
  const command = (input) => workbenchPage.evaluate((c) => window.respondentWorkbench.execute(c), input);
  await workbenchPage.waitForFunction(() => window.respondentWorkbench?.protocol === "rrp.workbench-agent.v1");
  let status = await command({ command: "status" });
  if (task && formUrl) throw new Error("Provide a task or a link using the configured source, not both.");
  status = task ? await command({ command: "load", expectedRevision: status.revision, task }) : await command({ command: "target", expectedRevision: status.revision, formUrl });
  const recipient = status.formUrl;
  const sourceSha256 = status.source.sha256;
  let expectedRevision = status.revision;
  const assertContext = async () => {
    const current = await command({ command: "status" });
    if (current.revision !== expectedRevision || current.source?.sha256 !== sourceSha256 || current.formUrl !== recipient) throw new Error("Workbench changed during execution; stop before the next write or navigation.");
    return current;
  };
  // Validate declared permission before even opening the recipient tab.
  if (grant && (!allowedUrl(recipient) || grant.formUrl !== recipient || grant.participantRef !== participantRef || grant.sourceSha256 !== status.source.sha256 || !grant.evidenceReference?.trim() || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now() || grant.mayFill !== true || typeof grant.maySubmit !== "boolean" || grant.maxSubmissions !== 1)) throw new Error("Fill grant is missing, expired, or outside recipient/participant/source scope.");
  if (grant?.maySubmit && (!journal || typeof journal.claim !== "function" || typeof journal.finish !== "function")) throw new Error("Submission requires an atomic durable receipt journal.");
  await formPage.goto(recipient);
  const seen = new Set();
  for (let sectionNumber = 1; sectionNumber <= 100; sectionNumber++) {
    const read = await readVisibleSection(formPage, { requestedUrl: recipient, sectionNumber });
    status = await assertContext();
    if (read.introduction) {
      if (seen.has(read.key)) throw new Error("Repeated introduction; stop navigation.");
      seen.add(read.key);
      await onProgress({ status: "introduction", sectionNumber });
      await assertContext();
      await advance(formPage); continue;
    }
    const { observation, groups } = read;
    const key = signature(observation);
    if (seen.has(key)) throw new Error("Repeated section; no blind navigation retry.");
    seen.add(key);
    status = await command({ command: "observe", expectedRevision: status.revision, observation });
    expectedRevision = status.revision;
    if (status.status !== "ready") return { status: "blocked", sectionNumber, problems: status.problems, externalSubmission: false };
    const plan = await command({ command: "plan", expectedRevision: status.revision });
    const respondent = plan.respondents.find((r) => r.participantRef === participantRef);
    if (!respondent) throw new Error("Explicit participant does not belong to the selected source records.");
    await onProgress({ status: "prepared_section", sectionNumber, questions: respondent.actions.length });
    await assertContext();
    if (!grant) return { status: "prepared", sectionNumber, plan, externalSubmission: false };
    if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Grant expired while processing; stop before the next write.");
    if ((await command({ command: "status" })).revision !== status.revision) throw new Error("Workbench changed before fill; recompute from the current source.");
    if (signature((await readVisibleSection(formPage, { requestedUrl: recipient, sectionNumber })).observation) !== key) throw new Error("Form changed before fill; reobserve its visible questions.");
    await fillAndVerify(formPage, groups, respondent.actions);
    if ((await command({ command: "status" })).revision !== status.revision) throw new Error("Workbench changed during fill; stop before navigation or submission.");
    await onProgress({ status: "verified_section", sectionNumber, questions: respondent.actions.length });
    await assertContext();
    const next = nextButton(formPage);
    if (await next.count()) {
      await advance(formPage);
      continue;
    }
    await exactOne(submitButton(formPage), "Submit button");
    if (!grant.maySubmit) return { status: "filled_not_submitted", sectionsVerified: sectionNumber, externalSubmission: false };
    if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Grant expired before submission.");
    // A question/description containing confirmation words is not a submission receipt.
    for (const marker of await recorded(formPage).all()) if (await marker.isVisible()) throw new Error("Confirmation text already present before submission; inspect the form.");
    const receiptKey = createHash("sha256").update(JSON.stringify([recipient, participantRef, status.source.sha256])).digest("hex");
    if (!await journal.claim(receiptKey)) throw new Error("Submission already reserved. Verify its receipt; never resubmit automatically.");
    // The reservation survives a crash and is never cleared to permit an automatic retry.
    try {
      await submitButton(formPage).click();
      await recorded(formPage).waitFor({ state: "visible", timeout: 10000 });
      if (await submitButton(formPage).count()) throw new Error("Confirmation is ambiguous while submission controls remain.");
      const receipt = { status: "response_recorded", externalSubmission: true, sectionsVerified: sectionNumber, observedAt: new Date().toISOString(), evidence: "visible_response_recorded" };
      await journal.finish(receiptKey, receipt);
      return receipt;
    } catch {
      const receipt = { status: "submission_uncertain", externalSubmission: "unknown", observedAt: new Date().toISOString(), retryAllowed: false };
      await journal.finish(receiptKey, receipt);
      return receipt;
    }
  }
  throw new Error("Section budget exhausted.");
}

const activeTabs = new WeakSet();
export async function runFormTask(options) {
  if (options.workbenchPage === options.formPage) throw new Error("Workbench and destination require separate tabs.");
  if (activeTabs.has(options.workbenchPage) || activeTabs.has(options.formPage)) throw new Error("A browser task is already active on these tabs.");
  activeTabs.add(options.workbenchPage); activeTabs.add(options.formPage);
  try { return await executeFormTask(options); }
  finally { activeTabs.delete(options.workbenchPage); activeTabs.delete(options.formPage); }
}

/** Read only: traverse information pages, stop at the first questions. No source required. */
export async function auditFirstSection({ formPage, formUrl, onProgress = () => {} }) {
  if (!allowedUrl(formUrl)) throw new Error("Destination is not an allowed Google Forms URL.");
  await formPage.goto(formUrl);
  const seen = new Set();
  for (let sectionNumber = 1; sectionNumber <= 100; sectionNumber++) {
    const read = await readVisibleSection(formPage, { requestedUrl: formUrl, sectionNumber });
    if (!read.introduction) return { status: "observed", sectionNumber, observation: read.observation, externalSubmission: false };
    if (seen.has(read.key)) throw new Error("Repeated introduction; stop navigation.");
    seen.add(read.key); onProgress({ status: "introduction", sectionNumber });
    await advance(formPage);
  }
  throw new Error("Section budget exhausted.");
}
