/** Actual Chromium over isolated service transport; no real people/provider/model calls. */
/* global document, window */
import assert from "node:assert/strict";
import process from "node:process";
import { URL } from "node:url";
import { log } from "node:console";
import { Cabinet } from "../../lib/services/cabinet.ts";
import { SimulationLab } from "../../lib/services/simulation-lab.ts";
import { quorumFixture, addPerson, fixturePassword } from "../helpers/quorum-fixture.ts";
import { startTestServer, removeTempDb, requireNextBuild } from "../helpers/server.ts";
assert.equal(requireNextBuild(), false);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const f = quorumFixture(), cabinet = new Cabinet(f.config, f.store, f.now), lab = new SimulationLab(f.config, f.store, f.now);
const server = await startTestServer({ env: { RRP_CABINET_STORE_ID: f.config.storeId, RRP_CABINET_ACCOUNTS: JSON.stringify(f.config.accounts), VERCEL: "1", VERCEL_ENV: "preview" } });
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const ownerContext = await browser.newContext({ viewport: { width: 1360, height: 1000 } }), participantContext = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const ownerPage = await ownerContext.newPage(), personPage = await participantContext.newPage(), errors = [];
  for (const page of [ownerPage, personPage]) page.on("pageerror", e => errors.push(e.message));
  await personPage.clock.setFixedTime(new Date(f.now()));
  async function routeHandler(route) {
    const request = route.request(), url = new URL(request.url()); let body, status = 200, headers = {};
    try {
      if (url.pathname.startsWith("/api/cabinet/")) {
        if (url.pathname.endsWith("/session")) body = { account: { id: "owner", label: f.config.accounts[0].label } };
        else if (url.pathname.endsWith("/catalog")) body = await cabinet.catalog(f.config.accounts[0]);
        else if (url.pathname.endsWith("/automation")) body = { flags: { enabled: false, writes: false }, jobs: [] };
        else if (url.pathname.endsWith("/lab")) body = { grants: await lab.grants(f.config.accounts[0]) };
        else if (url.pathname.endsWith("/quorum")) {
          if (request.method() === "POST") { assert.equal(request.headers().origin, server.baseUrl); body = await f.q.adminCommand("owner", request.postDataJSON()); }
          else body = url.searchParams.has("report") ? await f.q.report("owner", url.searchParams.get("report")) : await f.q.admin("owner");
        }
      } else if (url.pathname.endsWith("/agent")) {
        const token = (request.headers().authorization ?? "").slice(7);
        body = request.method() === "GET" ? await f.q.agentTask(token) : await f.q.predict(token, request.postDataJSON());
      } else {
        const token = request.headers().cookie?.match(/rrp_quorum_session=([^;]+)/)?.[1], person = await f.q.session(token);
        if (url.pathname.endsWith("/session")) {
          if (request.method() === "POST") {
            assert.equal(request.headers().origin, server.baseUrl); const input = request.postDataJSON();
            const result = input.command === "activate" ? await f.q.activate(input.invitationToken, input.password, input.age18, input.terms) : await f.q.login(input.login, input.password);
            headers["set-cookie"] = `rrp_quorum_session=${result.token}; Path=/; HttpOnly; SameSite=Lax`;
            body = { person: result.person };
          } else if (request.method() === "DELETE") { await f.q.logout(token); headers["set-cookie"] = "rrp_quorum_session=; Path=/; Max-Age=0"; body = { signedOut: true }; }
          else { if (!person) throw Object.assign(new Error("Sign in"), { status: 401 }); body = { person }; }
        } else {
          if (!person) throw Object.assign(new Error("Sign in"), { status: 401 });
          if (request.method() === "POST") { assert.equal(request.headers().origin, server.baseUrl); body = await f.q.studentCommand(person.id, request.postDataJSON()); }
          else body = await f.q.dashboard(person.id);
        }
      }
      if (!body) throw new Error("Unexpected fixture endpoint");
    } catch(e) { status = e.status ?? 400; body = { error: e.message }; }
    await route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
  }
  await ownerPage.route("**/api/cabinet/**", routeHandler); await ownerPage.route("**/api/quorum/**", routeHandler);
  // Playwright glob syntax is deliberately simple for both root and child endpoints.
  await personPage.route("**/api/quorum", routeHandler); await personPage.route("**/api/quorum/**", routeHandler);
  await ownerPage.goto(`${server.baseUrl}/cabinet`);
  const admin = ownerPage.getByRole("region", { name: "Управление Кворумом" });
  await admin.getByText("Пригласить участника", { exact: true }).click();
  await admin.getByLabel("Логин участника", { exact: true }).fill("author-fixture");
  await admin.getByLabel("Псевдоним", { exact: true }).fill("Author fixture");
  await admin.getByLabel("Группа участника", { exact: true }).fill("fixture-group");
  await admin.getByRole("button", { name: "Создать приглашение", exact: true }).click();
  const invitation = await admin.getByLabel("Ссылка приглашения", { exact: true }).inputValue(), inviteToken = invitation.match(/#invite=([A-Za-z0-9_-]{43})/)[1];
  await personPage.goto(`${server.baseUrl}/quorum#invite=${inviteToken}`);
  await personPage.getByLabel("Придумайте пароль", { exact: true }).fill(fixturePassword);
  await personPage.getByLabel("Мне исполнилось 18 лет", { exact: true }).check();
  await personPage.getByLabel(/Согласен с правилами участия/).check();
  await personPage.getByRole("button", { name: "Активировать кабинет", exact: true }).click();
  await personPage.getByRole("button", { name: "Выйти из Кворума" }).waitFor();
  assert.equal(await personPage.evaluate(() => window.location.hash), "");
  const author = (await f.q.admin("owner")).students.find(p => p.login === "author-fixture");
  const studies = personPage.getByRole("region", { name: "Мои исследования" });
  await studies.getByLabel("Название исследования", { exact: true }).fill("Browser exchange fixture");
  await studies.getByLabel("Цель использования ответов", { exact: true }).fill("Isolated browser verification");
  await studies.getByLabel("Источник вопросов и версия", { exact: true }).fill("fixture v1");
  await studies.getByLabel("Правила проверки прохождения", { exact: true }).fill("Declared completion and eligibility fixture rules");
  await studies.getByLabel("Информация для согласия участника", { exact: true }).fill("Isolated test consent for fixture-only storage and operator review");
  await studies.getByLabel("Нужное количество ответов", { exact: true }).fill("1");
  await studies.getByLabel("Вопрос 1", { exact: true }).fill("Fixture scale question");
  await studies.getByRole("button", { name: "Сохранить исследование", exact: true }).click();
  await personPage.getByRole("status").filter({ hasText: "Кредиты зарезервированы" }).waitFor();
  assert.equal((await f.q.dashboard(author.id)).person.balance,4);
  await admin.getByRole("button", { name: "Обновить пилот" }).click();
  const review = admin.getByRole("form", { name: "Рассмотрение исследования Browser exchange fixture" });
  await review.getByLabel("Обоснование", { exact: true }).fill("Declared fixture checks passed");
  await review.getByRole("button", { name: "Сохранить решение по исследованию", exact: true }).click();
  await admin.getByRole("status").filter({ hasText: "Решение сохранено" }).waitFor();
  const respondent = await addPerson(f, "person-b");
  await personPage.getByRole("button", { name: "Выйти из Кворума" }).click();
  async function login() {
    const panel = personPage.getByRole("region", { name: "Вход участника" });
    await panel.getByLabel("Логин", { exact: true }).fill(respondent.login); await panel.getByLabel("Пароль", { exact: true }).fill(fixturePassword);
    await panel.getByRole("button", { name: "Войти", exact: true }).click(); await personPage.getByRole("button", { name: "Выйти из Кворума" }).waitFor();
  }
  await login();
  const available = personPage.getByRole("region", { name: "Доступные опросы" });
  await available.getByRole("button", { name: "Пройти опрос", exact: true }).click();
  await available.getByLabel("Fixture scale question", { exact: true }).selectOption("3");
  await available.getByLabel(/Согласен на участие/).check(); await available.getByLabel(/Отвечаю лично/).check();
  await available.getByRole("button", { name: "Сохранить мои ответы" }).click();
  await personPage.getByRole("status").filter({ hasText: "Ответ сохранён" }).waitFor();
  await admin.getByRole("button", { name: "Обновить пилот" }).click();
  const response = (await f.q.admin("owner")).responses[0], responseReview = admin.getByRole("form", { name: `Проверка ответа ${response.id}` });
  await responseReview.getByLabel("Обоснование", { exact: true }).fill("Fixture completeness confirmed");
  await responseReview.getByRole("button", { name: "Сохранить решение по ответу" }).click();
  await admin.getByRole("status").filter({ hasText: "Решение сохранено" }).waitFor();
  await personPage.getByRole("button", { name: "Обновить кабинет" }).click();assert.equal((await f.q.dashboard(respondent.id)).person.balance,6);
  assert.equal(await available.getByRole("button", { name: "Ответ уже сохранён" }).count(),1);
  const profile = personPage.getByRole("region", { name: "Профиль для агента" });
  await profile.getByLabel("О себе и своих привычных решениях", { exact: true }).fill("This is an isolated browser persona fixture used only to verify workflow separation and consent.");
  await profile.getByLabel("Источник сведений и дата", { exact: true }).fill("Fixture self-report, no real human");
  await profile.getByLabel(/Разрешаю хранение профиля/).check(); await profile.getByLabel(/В профиле нет ответов/).check();
  await profile.getByRole("button", { name: "Сохранить версию профиля", exact: true }).click();await personPage.getByRole("status").filter({ hasText: "Версия профиля сохранена" }).waitFor();
  await admin.getByRole("button", { name: "Обновить пилот" }).click();await admin.getByText("Создать слепую проверку агента", { exact: true }).click();
  const protocol = admin.getByRole("form", { name: "Протокол сравнения" });
  await protocol.getByLabel("Название проверки", { exact: true }).fill("Browser blind fixture");
  await protocol.getByLabel("Гипотеза и заранее выбранный критерий", { exact: true }).fill("Isolated test of blind data flow");
  await protocol.getByLabel("Источник новых проверочных вопросов", { exact: true }).fill("unseen fixture v1");
  await protocol.getByLabel("Модель и версия", { exact: true }).fill("fixture/model");
  await protocol.getByLabel("Повторное прохождение через, дней", { exact: true }).fill("1");
  await protocol.getByLabel(/person-b · person-b · версия/).check();
  await protocol.getByLabel("Вопрос 1", { exact: true }).fill("New held-out fixture question");
  await protocol.getByLabel(/Эти ответы отсутствуют/).check();await protocol.getByRole("button", { name: "Зафиксировать протокол", exact: true }).click();
  await admin.getByRole("status").filter({ hasText: "Протокол зафиксирован" }).waitFor();
  assert.equal(await admin.getByRole("button", { name: "Ключ персональному агенту person-b" }).count(),0);
  await personPage.getByRole("button", { name: "Обновить кабинет" }).click();
  const comparison = personPage.getByRole("region", { name: "Сравнение с агентом" });
  await comparison.getByLabel(/Разрешаю использование этой версии/).check();
  await comparison.getByRole("button", { name: "Принять участие в проверке" }).click();await personPage.getByRole("status").filter({ hasText: "Согласие на эту проверку" }).waitFor();
  await admin.getByRole("button", { name: "Обновить пилот" }).click();
  async function predict(arm, answer) {
    await admin.getByRole("button", { name: arm === "personal" ? "Ключ персональному агенту person-b" : "Ключ агенту без профиля person-b", exact: true }).click();
    const prompt = await admin.getByLabel("Инструкция агента Кворума", { exact: true }).inputValue(), token = prompt.match(/Authorization: Bearer ([A-Za-z0-9_-]{43})/)[1];
    assert.equal("profile" in await f.q.agentTask(token),arm === "personal");
    const template = JSON.parse(await admin.getByLabel("JSON-прогноз от агента", { exact: true }).inputValue()); template.answers = { q1: answer };
    await admin.getByLabel("JSON-прогноз от агента", { exact: true }).fill(JSON.stringify(template));
    await admin.getByRole("button", { name: "Зафиксировать прогноз", exact: true }).click();await admin.getByRole("status").filter({ hasText: "Прогноз зафиксирован" }).waitFor();
  }
  await predict("personal",3);await predict("baseline",1);
  await personPage.getByRole("button", { name: "Обновить кабинет" }).click();await comparison.getByLabel("New held-out fixture question", { exact: true }).selectOption("3");
  await comparison.getByLabel(/Согласен на участие/).check();await comparison.getByLabel(/Отвечаю лично/).check();
  await comparison.getByRole("button", { name: "Зафиксировать ответы для сравнения", exact: true }).click();await personPage.getByRole("status").filter({ hasText: "Ответ для сравнения сохранён" }).waitFor();
  await comparison.getByText(/Повторное прохождение после/).waitFor();await personPage.reload();await personPage.getByRole("button", { name: "Выйти из Кворума" }).waitFor();
  await comparison.getByText(/Повторное прохождение после/).waitFor();
  f.advance(86400001);await personPage.clock.setFixedTime(new Date(f.now()));await personPage.reload();await login();
  await comparison.getByLabel("New held-out fixture question", { exact: true }).selectOption("4");await comparison.getByLabel(/Согласен на участие/).check();await comparison.getByLabel(/Отвечаю лично/).check();
  await comparison.getByRole("button", { name: "Зафиксировать ответы для сравнения", exact: true }).click();await comparison.getByText("Оба прохождения сохранены.", { exact: true }).waitFor();
  await admin.getByRole("button", { name: "Рассчитать сравнение Browser blind fixture", exact: true }).click();await admin.getByRole("heading", { name: "Результат: фактическое N = 1", exact: true }).waitFor();
  await profile.getByText("Отозвать согласие на моделирование", { exact: true }).click();await profile.getByRole("button", { name: "Отозвать согласие и удалить данные сравнения", exact: true }).click();await personPage.getByRole("status").filter({ hasText: "Согласие отозвано" }).waitFor();
  await admin.getByRole("button", { name: "Обновить пилот" }).click();await admin.getByRole("button", { name: "Рассчитать сравнение Browser blind fixture", exact: true }).click();await admin.getByRole("heading", { name: "Результат: фактическое N = 0", exact: true }).waitFor();
  for (const page of [ownerPage,personPage]) { await page.setViewportSize({ width:390,height:844 });assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true); }
  assert.deepEqual(errors,[]);
  log("Quorum Chromium: invitation/own password, reserved exchange/review/reward, consented profile and per-model trial, blind arm grants/prediction lock, human/retest gating, reload/session, actual-N report, withdrawal and mobile passed. Isolated fixtures; no real people, model calls or form sends.");
} finally { if(browser) await browser.close();await server.stop();removeTempDb(server.dbFile); }
