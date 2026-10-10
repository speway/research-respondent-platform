/** Runs only inside an approved Sandbox. No source records, sign-in or answer writes. */
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";
import { auditFirstSection } from "./runner.mjs";
import { readOnlyRequestAllowed, isReadOnlyFormUrl } from "./read-only-policy.mjs";
if (!isReadOnlyFormUrl(process.argv[2])) throw new Error("Audit requires an unfilled Google Forms link.");
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (readOnlyRequestAllowed({ url: request.url(), method: request.method(), navigation: request.isNavigationRequest(), postData: request.postData() ?? "" })) return route.continue();
    return route.abort("blockedbyclient");
  });
  const result = await auditFirstSection({ formPage: page, formUrl: process.argv[2] });
  await writeFile("/vercel/sandbox/observation.json", JSON.stringify(result), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: result.status, sectionNumber: result.sectionNumber,
    questionCount: result.observation.questions.length, externalSubmission: result.externalSubmission }) + "\n");
} finally { await browser.close(); }
