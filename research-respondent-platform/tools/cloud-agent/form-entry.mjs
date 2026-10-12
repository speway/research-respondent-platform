/** Trusted ephemeral worker. Source text is data; no sign-in, hidden payload or direct submission. */
import { readFile, writeFile, rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { chromium } from "playwright";
import { runFormTask } from "./runner.mjs";
import { formRequestAllowed } from "./form-policy.mjs";

const directory = "/vercel/sandbox";
const input = JSON.parse(await readFile(`${directory}/input.json`, "utf8"));
const atomic = async (name, value) => {
  const path = `${directory}/${name}.json`;
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 }); await rename(`${path}.tmp`, path);
};
let sectionsVerified = 0, questionsVerified = 0;
const journal = {
  async claim(key) {
    await writeFile(`${directory}/claim.json`, JSON.stringify({ key }), { mode: 0o600, flag: "wx" });
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      try { const result = JSON.parse(await readFile(`${directory}/decision.json`, "utf8"));
        if (result.key !== key || typeof result.allowed !== "boolean") throw new Error("Invalid durable journal decision.");
        return result.allowed;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await setTimeout(250);
    }
    throw new Error("Durable journal unavailable; no submit.");
  },
  async finish(_key, receipt) { await writeFile(`${directory}/receipt.json`, JSON.stringify(receipt), { mode: 0o600, flag: "wx" }); },
};
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (formRequestAllowed({ url: request.url(), method: request.method(), navigation: request.isNavigationRequest(),
      postData: request.postData() ?? "", formUrl: input.task.formUrl, mayFill: !!input.grant,
      workbenchOrigin: input.workbenchOrigin })) return route.continue();
    return route.abort("blockedbyclient");
  });
  const workbenchPage = await context.newPage(), formPage = await context.newPage();
  await workbenchPage.goto(`${input.workbenchOrigin}/workbench`);
  const result = await runFormTask({ workbenchPage, formPage, task: input.task,
    participantRef: input.participantRef, grant: input.grant, journal,
    onProgress: async (event) => {
      if (event.status === "verified_section") { sectionsVerified = event.sectionNumber; questionsVerified += event.questions; }
      await atomic("progress", { status: event.status, sectionNumber: event.sectionNumber, sectionsVerified, questionsVerified });
    } });
  // The preparation plan includes answers; never write it to provider logs or job status.
  await atomic("result", { status: result.status, externalSubmission: result.externalSubmission,
    sectionsVerified: result.sectionsVerified ?? sectionsVerified, questionsVerified,
    ...(result.sectionNumber ? { sectionNumber: result.sectionNumber } : {}),
    problems: (result.problems ?? []).slice(0, 20), ...(result.evidence ? { evidence: result.evidence } : {}),
    observedAt: result.observedAt ?? new Date().toISOString() });
  process.stdout.write("Form worker completed; result kept private.\n");
} catch {
  // Fail closed without printing answer-dependent exceptions or screenshots.
  await atomic("result", { status: "blocked", externalSubmission: false, sectionsVerified, questionsVerified,
    problems: ["Исполнитель остановился: вход, CAPTCHA, неподдерживаемый элемент, журнал или изменение формы. Автоматического повтора нет."],
    observedAt: new Date().toISOString() });
  process.stdout.write("Form worker stopped; no automatic retry.\n");
} finally { await browser.close(); }
