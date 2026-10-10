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
const signature = (o) => JSON.stringify(o.questions.map(({ id, section, text, kind, required, options }) => ({ id, section, text, kind, required, options })));
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
export async function readVisibleSection(page, { requestedUrl, sectionNumber = 1 } = {}) {
  if (!allowedUrl(page.url()) || !allowedUrl(requestedUrl)) throw new Error("Destination is not an allowed Google Forms URL.");
  const title = (await exactOne(page.getByRole("heading", { level: 1 }), "form title")).innerText();
  const sectionHeadings = page.getByRole("heading", { level: 2 });
  if (await sectionHeadings.count() > 1) throw new Error("Section headings are ambiguous; use the full skill reader.");
  const section = await sectionHeadings.count() ? (await sectionHeadings.innerText()).trim() : "";
  const questions = [], groups = [];
  for (const group of await page.getByRole("listitem").all()) {
    if (!await group.isVisible()) continue;
    const heading = group.getByRole("heading");
    const controls = group.getByRole("textbox").or(group.getByRole("radio")).or(group.getByRole("checkbox")).or(group.getByRole("combobox"));
    if (!await heading.count() && !await controls.count()) continue;
    await exactOne(heading, "question heading");
    const hasMarker = await heading.getByText("*", { exact: true }).count() > 0;
    const text = (await heading.innerText()).trim().replace(hasMarker ? /\s*\*$/ : /$^/, "");
    const inputs = group.getByRole("textbox"), radios = group.getByRole("radio"), checks = group.getByRole("checkbox"), lists = group.getByRole("combobox");
    const required = hasMarker || await group.locator('[aria-required="true"], input[required], textarea[required]').count() > 0;
    let kind = "unsupported", options = [];
    // Matrices, checkboxes, dates, file uploads, Other-text and mixed controls stop safely.
    if (!await checks.count() && !await lists.count() && await inputs.count() === 1 && !await radios.count()) kind = "text";
    if (!await checks.count() && !await lists.count() && !await inputs.count() && await radios.count()) { kind = "single_choice"; options = await visibleOptions(radios); }
    questions.push({ id: `${section || `section-${sectionNumber}`}/${questions.length + 1}`, section, text, kind, required, options });
    groups.push(group);
  }
  if (!questions.length) throw new Error("No supported question structure; sign-in, CAPTCHA or an unsupported form may be blocking access.");
  const complete = sectionNumber === 1 && await submitButton(page).count() === 1 && await nextButton(page).count() === 0;
  return { observation: { schema: "rrp.observed-form.v1", url: page.url(), requestedUrl, title: await title, scope: complete ? "complete_form" : "visible_section", observedAt: new Date().toISOString(), method: "visible_ui", questions }, groups };
}
async function fillAndVerify(page, groups, actions) {
  for (const [i, action] of actions.entries()) {
    const group = groups[i];
    if (action.action === "skip_optional") {
      // Existing draft answers must not leak into a missing source value.
      if (await group.getByRole("textbox").count() && (await group.getByRole("textbox").inputValue()) !== "") throw new Error("Optional missing answer has an existing draft value.");
      for (const radio of await group.getByRole("radio").all()) if (await radio.isChecked()) throw new Error("Optional missing answer has an existing draft selection.");
      continue;
    }
    if (action.action === "fill") {
      const input = await exactOne(group.getByRole("textbox"), "answer input");
      await input.fill(String(action.value));
    } else if (action.action === "select_radio") {
      const radio = await exactOne(group.getByRole("radio", { name: String(action.value), exact: true }), "answer option");
      if (!await radio.isChecked()) await radio.click();
      await page.waitForFunction((el) => el.checked === true || el.getAttribute("aria-checked") === "true", await radio.elementHandle(), { timeout: 5000 });
    } else throw new Error("Unsupported action; pass this section to the full skill reader.");
  }
  // Re-read EVERY source-backed value after the group of writes.
  for (const [i, action] of actions.entries()) {
    if (action.action === "fill" && await groups[i].getByRole("textbox").inputValue() !== String(action.value)) throw new Error("Entered text differs from the literal source.");
    if (action.action === "select_radio" && !await groups[i].getByRole("radio", { name: String(action.value), exact: true }).isChecked()) throw new Error("Selected option is not confirmed.");
  }
}

/** Prepares by default. Fill/submit grants bind recipient, ONE participant and source hash.
 * journal.claim must atomically reserve a durable key; uncertainty never auto-retries.
 */
async function executeFormTask({ workbenchPage, formPage, task, participantRef, grant = null, journal = null, onProgress = () => {} }) {
  const command = (input) => workbenchPage.evaluate((c) => window.respondentWorkbench.execute(c), input);
  await workbenchPage.waitForFunction(() => window.respondentWorkbench?.protocol === "rrp.workbench-agent.v1");
  let status = await command({ command: "status" });
  status = await command({ command: "load", expectedRevision: status.revision, task });
  // Validate declared permission before even opening the recipient tab.
  if (grant && (!allowedUrl(task.formUrl) || grant.formUrl !== task.formUrl || grant.participantRef !== participantRef || grant.sourceSha256 !== status.source.sha256 || !grant.evidenceReference?.trim() || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now() || grant.mayFill !== true || typeof grant.maySubmit !== "boolean" || grant.maxSubmissions !== 1)) throw new Error("Fill grant is missing, expired, or outside recipient/participant/source scope.");
  if (grant?.maySubmit && (!journal || typeof journal.claim !== "function" || typeof journal.finish !== "function")) throw new Error("Submission requires an atomic durable receipt journal.");
  await formPage.goto(task.formUrl);
  const seen = new Set();
  for (let sectionNumber = 1; sectionNumber <= 100; sectionNumber++) {
    const { observation, groups } = await readVisibleSection(formPage, { requestedUrl: task.formUrl, sectionNumber });
    const key = signature(observation);
    if (seen.has(key)) throw new Error("Repeated section; no blind navigation retry.");
    seen.add(key);
    status = await command({ command: "status" });
    status = await command({ command: "observe", expectedRevision: status.revision, observation });
    if (status.status !== "ready") return { status: "blocked", sectionNumber, problems: status.problems, externalSubmission: false };
    const plan = await command({ command: "plan", expectedRevision: status.revision });
    const respondent = plan.respondents.find((r) => r.participantRef === participantRef);
    if (!respondent) throw new Error("Explicit participant does not belong to the selected source records.");
    onProgress({ status: "prepared_section", sectionNumber, questions: respondent.actions.length });
    if (!grant) return { status: "prepared", sectionNumber, plan, externalSubmission: false };
    if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Grant expired while processing; stop before the next write.");
    if ((await command({ command: "status" })).revision !== status.revision) throw new Error("Workbench changed before fill; recompute from the current source.");
    if (signature((await readVisibleSection(formPage, { requestedUrl: task.formUrl, sectionNumber })).observation) !== key) throw new Error("Form changed before fill; reobserve its visible questions.");
    await fillAndVerify(formPage, groups, respondent.actions);
    if ((await command({ command: "status" })).revision !== status.revision) throw new Error("Workbench changed during fill; stop before navigation or submission.");
    onProgress({ status: "verified_section", sectionNumber, questions: respondent.actions.length });
    const next = nextButton(formPage);
    if (await next.count()) {
      await exactOne(next, "Next button");
      const oldHeadings = await formPage.getByRole("listitem").getByRole("heading").allTextContents();
      await next.click();
      try {
        await formPage.waitForFunction((old) => JSON.stringify(Array.from(document.querySelectorAll('[role="listitem"] [role="heading"], [role="listitem"] h3')).filter((el) => el.getClientRects().length).map((el) => el.textContent)) !== JSON.stringify(old), oldHeadings, { timeout: 5000 });
      } catch { throw new Error("Next did not reveal a different section. Inspect validation; do not retry blindly."); }
      continue;
    }
    await exactOne(submitButton(formPage), "Submit button");
    if (!grant.maySubmit) return { status: "filled_not_submitted", sectionsVerified: sectionNumber, externalSubmission: false };
    if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Grant expired before submission.");
    const receiptKey = createHash("sha256").update(JSON.stringify([task.formUrl, participantRef, status.source.sha256])).digest("hex");
    if (!await journal.claim(receiptKey)) throw new Error("Submission already reserved. Verify its receipt; never resubmit automatically.");
    // The reservation survives a crash and is never cleared to permit an automatic retry.
    try {
      await submitButton(formPage).click();
      await recorded(formPage).waitFor({ state: "visible", timeout: 10000 });
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
