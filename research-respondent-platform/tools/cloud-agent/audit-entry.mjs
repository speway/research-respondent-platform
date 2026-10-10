/** Runs only inside an approved Sandbox. No source records, sign-in or answer writes. */
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";
import { auditFirstSection } from "./runner.mjs";
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const request = route.request();
    // Google may POST an empty intro navigation. All other writes are refused.
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    if (request.method() === "POST" && request.isNavigationRequest() && /\/forms\/.*\/formResponse(?:\?|$)/.test(request.url()) && !/(?:^|&)entry\./.test(request.postData() ?? "")) return route.continue();
    return route.abort("blockedbyclient");
  });
  const result = await auditFirstSection({ formPage: page, formUrl: process.argv[2] });
  await writeFile("/vercel/sandbox/observation.json", JSON.stringify(result), { mode: 0o600 });
} finally { await browser.close(); }
