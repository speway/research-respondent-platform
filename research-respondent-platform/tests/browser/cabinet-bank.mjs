/** Real browser UI with an isolated, in-memory cabinet service transport.
 * No provider writes, participant records or external forms. */
/* global document, window */
import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { log } from "node:console";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { Cabinet, cabinetConfiguration } from "../../lib/services/cabinet.ts";
import { hashPassword } from "../../lib/services/password.ts";
import { httpGet, removeTempDb, requireNextBuild, startTestServer } from "../helpers/server.ts";

assert.equal(requireNextBuild(), false);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const accounts = [{ id: "owner", login: "fixture", label: "Isolated browser cabinet", password: hashPassword("isolated-browser-only-password") }];
const env = { RRP_CABINET_STORE_ID: "store_isolatedBrowser", RRP_CABINET_ACCOUNTS: JSON.stringify(accounts) };
const config = cabinetConfiguration(env), records = new Map(); let generation = 0;
const cabinet = new Cabinet(config, {
  async read(path) { return records.get(path) ?? null; },
  async write(path, value, etag) {
    const previous = records.get(path);
    if ((etag && previous?.etag !== etag) || (!etag && previous)) throw new BlobPreconditionFailedError();
    records.set(path, { body: JSON.stringify(value), etag: `"browser-${++generation}"` });
  },
  async paths(prefix) { return [...records.keys()].filter((p) => p.startsWith(prefix)); },
});
const owner = config.accounts[0];
const server = await startTestServer({ env: { ...env, VERCEL: "1", VERCEL_ENV: "preview" } });
let browser; let activePage;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } }); activePage = page; const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/cabinet/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    let body, status = 200;
    try {
      if (url.pathname.endsWith("/session")) body = { account: { id: owner.id, label: owner.label } };
      else if (request.method() === "GET") body = await cabinet.catalog(owner);
      else {
        assert.equal(request.headers().origin, server.baseUrl);
        const input = request.postDataJSON();
        if (input.command === "upload") body = { asset: await cabinet.upload(owner, input.file) };
        else if (input.command === "bank_preview") body = await cabinet.previewBank(owner, input.spec);
        else if (input.command === "bank_commit") body = { asset: await cabinet.commitBank(owner, input.spec, input.previewHash) };
        else if (input.command === "project") body = { project: await cabinet.createProject(owner, input.project) };
        else if (input.command === "agent_key") body = await cabinet.agentKey(owner, input.projectId);
        else throw new Error("Unexpected isolated UI command");
      }
    } catch (error) { status = error.status ?? 400; body = { error: error.message }; }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${server.baseUrl}/cabinet`);
  await page.getByRole("heading", { name: owner.label, exact: true }).waitFor();
  assert.equal((await httpGet(server.baseUrl, "/bank-templates/participants.csv")).status, 200);
  async function upload(name, content) {
    const panel = page.getByRole("heading", { name: "Загрузить в кабинет" }).locator("..");
    await panel.getByLabel("Файл до 2 МБ").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(content) });
    await panel.getByLabel("Источник и версия", { exact: true }).fill("Isolated browser fixture v1");
    await panel.getByLabel("Основание доступа и использования").fill("test-only");
    const response = page.waitForResponse((r) => r.url().endsWith("/catalog") && r.request().method() === "POST");
    await panel.getByRole("button", { name: "Сохранить файл" }).click();
    const uploaded = await response; assert.equal(uploaded.status(), 200);
    const fileId = (await uploaded.json()).asset.id;
    await page.locator(`a[href="/api/cabinet/catalog?asset=${fileId}"]`).waitFor();
    await page.getByRole("status").filter({ hasText: "Файл сохранён" }).waitFor();
  }
  await upload("left.csv", "participant_id,answer\nTEST-A,0\nTEST-B,2\n");
  await upload("addition.csv", "participant_id,answer\nTEST-B,2\nTEST-C,4\n");
  const bank = page.getByRole("region", { name: "Банк респондентов" });
  const catalog = await cabinet.catalog(owner);
  const left = catalog.assets.find((a) => a.name === "left.csv"), addition = catalog.assets.find((a) => a.name === "addition.csv");
  await bank.getByLabel("Сохранённая база", { exact: true }).selectOption(left.id);
  await bank.getByLabel("Дополнение к базе").selectOption(addition.id);
  assert.equal(await bank.getByLabel("ID в первой базе").inputValue(), "participant_id");
  await bank.getByLabel("Источник и версия результата").fill("Browser bank v1");
  await bank.getByLabel("Основание использования результата").fill("test-only");
  await bank.getByRole("button", { name: "Проверить объединение" }).click();
  await bank.getByRole("heading", { name: "Результат проверки" }).waitFor();
  assert.equal(await bank.getByText("Записей в результате", { exact: true }).locator("..").locator("dd").textContent(), "3");
  // Editing after preview must invalidate the approved snapshot.
  await bank.getByLabel("Название новой версии").fill("Browser bank v2");
  assert.equal(await bank.getByRole("button", { name: "Сохранить версию банка" }).count(), 0);
  await bank.getByRole("button", { name: "Проверить объединение" }).click();
  await bank.getByRole("button", { name: "Сохранить версию банка" }).click();
  await bank.getByRole("status").filter({ hasText: "Версия «Browser bank v2.json» сохранена" }).waitFor();
  const saved = (await cabinet.catalog(owner)).assets.find((a) => !!a.derivation);
  const project = page.getByRole("heading", { name: "Проект по ссылке на форму" }).locator("..");
  assert.equal(await project.getByLabel("База", { exact: true }).inputValue(), saved.id);
  await project.getByLabel("Название", { exact: true }).fill("Bank browser fixture");
  await project.getByLabel("ID участника", { exact: true }).selectOption("participant_id");
  await project.getByLabel("Ссылка Google Forms").fill("https://docs.google.com/forms/d/e/isolated-fixture/viewform");
  await project.getByLabel("Цель проекта").fill("test-only");
  await project.getByRole("button", { name: "Создать проект" }).click();
  await page.getByRole("button", { name: "Дать проект агенту" }).click();
  const prompt = await page.getByLabel("Инструкция и ключ проекта для агента").inputValue();
  const token = prompt.match(/Authorization: Bearer ([A-Za-z0-9_-]{43})/)[1];
  const bundle = await cabinet.forAgent(token);
  assert.equal(bundle.source.id, saved.id); assert.equal(bundle.sourceChecks.selectedRecords, 3);
  assert.equal((await cabinet.forAgentLineage(token, saved.id)).parents.length, 2);
  // Source changes with a conflicting answer keep the save button disabled.
  await upload("conflict.csv", "participant_id,answer\nTEST-A,9\n");
  const conflict = (await cabinet.catalog(owner)).assets.find((a) => a.name === "conflict.csv");
  await bank.getByLabel("Дополнение к базе").selectOption(conflict.id);
  await bank.getByRole("button", { name: "Проверить объединение" }).click();
  await bank.getByText(/Сохранение заблокировано/).waitFor();
  assert.equal(await bank.getByRole("button", { name: "Сохранить версию банка" }).isDisabled(), true);
  await upload("profiles.csv", "participant_id,group\nTEST-A,one\nTEST-B,two\n");
  const profiles = (await cabinet.catalog(owner)).assets.find((a) => a.name === "profiles.csv");
  await bank.getByLabel("Действие с банком").selectOption("join");
  await bank.getByLabel("База характеристик участников").selectOption(profiles.id);
  await bank.getByRole("button", { name: "Проверить объединение" }).click();
  await bank.getByText(/Ответов без профиля: 0/).waitFor();
  assert.equal(await bank.getByRole("button", { name: "Сохранить версию банка" }).isDisabled(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  log("Cabinet browser: upload → preview invalidation → durable bank version → project → scoped agent/lineage; conflicts and exact profile join; mobile passed.");
} catch (error) {
  if (activePage) log("Isolated fixture cabinet failure before returning an agent key:", (await activePage.locator("body").innerText()).replace(/Bearer [A-Za-z0-9_-]+/g, "Bearer [redacted]"));
  throw error;
} finally { if (browser) await browser.close(); await server.stop(); removeTempDb(server.dbFile); }
