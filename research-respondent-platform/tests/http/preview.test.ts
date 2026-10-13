/** Actual production server with Vercel env, using only disposable fixtures. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { bootstrap } from "../../lib/services/bootstrap.ts";
import { createSession } from "../../lib/repo/org.ts";
import { httpGet, httpPost, removeTempDb, requireNextBuild, serverActionRefsFromBuild, startTestServer, type TestServer } from "../helpers/server.ts";

const password = "fixture-preview-password";
let server: TestServer;
let cookie = "";

describe("isolated Vercel preview policy over HTTP", { skip: requireNextBuild() }, () => {
  before(async () => {
    server = await startTestServer({ env: { VERCEL: "1", VERCEL_ENV: "preview" } });
    const account = bootstrap(server.db, { organizationName: "Fixture", adminEmail: "preview@example.test", adminPassword: password });
    cookie = `rrp_session=${createSession(server.db, account.adminUserId).token}`;
  });
  after(async () => { if (server) { await server.stop(); removeTempDb(server.dbFile); } });

  it("preview renders a disabled sign-in and explicitly reports nondurable storage", async () => {
    const login = await httpGet(server.baseUrl, "/login");
    assert.equal(login.status, 200);
    assert.match(login.body, /Sign-in and research data entry are disabled/);
    assert.equal(login.body.includes('name="password"'), false);
    const health = await httpGet(server.baseUrl, "/api/health");
    assert.equal(health.status, 200);
    const payload = JSON.parse(health.body);
    assert.deepEqual(payload.hosting, { mode: "isolated-preview", durable: false, signInEnabled: false });
    assert.equal(payload.database.integrityCheck, "ok");
  });

  it("valid cookies from a configured database cannot access preview records", async () => {
    const response = await httpGet(server.baseUrl, "/participants", { cookie });
    assert.ok([302, 303, 307, 308].includes(response.status));
    assert.match(response.location ?? "", /\/login/);
    assert.equal(response.body.includes("data-table"), false);
  });

  it("cloud diagnostics stay unavailable until explicitly configured; direct actions cannot enable them", async () => {
    const page = await httpGet(server.baseUrl, "/cloud/setup");
    assert.equal(page.status, 404);
    assert.equal((await httpGet(server.baseUrl, "/cloud/audit")).status, 404);
    assert.equal((await httpPost(server.baseUrl, "/cloud/audit", {})).status, 404);
    const ref = serverActionRefsFromBuild().find((entry) => entry.exportedName === "runStorageProbeAction");
    assert.ok(ref);
    const action = await httpPost(server.baseUrl, "/cloud/setup", { [`$ACTION_ID_${ref.id}`]: "" }, { multipart: true });
    assert.ok([302, 303, 307, 308].includes(action.status));
    assert.match(action.location ?? "", /\/workbench/);
  });

  it("preview home opens Quorum participation without exposing private data", async () => {
    const home = await httpGet(server.baseUrl, "/");
    assert.ok([302, 303, 307, 308].includes(home.status));
    assert.match(home.location ?? "", /\/quorum/);
    const panel = await httpGet(server.baseUrl, "/workbench");
    assert.equal(panel.status, 200);
    assert.match(panel.body, /Respondent Lab/);
    assert.match(panel.body, /Скачать пакет для агента|Пакет для агента/);
    assert.equal(panel.body.includes('name="password"'), false);
    assert.equal(panel.body.includes("preview@example.test"), false);
  });

  it("agent discovery returns a credential-free browser protocol without exposing data", async () => {
    const response = await httpGet(server.baseUrl, "/.well-known/rrp-agent.json");
    assert.equal(response.status, 200);
    const manifest = JSON.parse(response.body);
    assert.equal(manifest.capabilities.simulationLab, true);
    assert.equal(manifest.protocol, "rrp.workbench-agent.v1");
    assert.equal(manifest.capabilities.hostedBackgroundWorker, true);
    assert.equal(manifest.capabilities.serverSourceUpload, true);
    assert.equal(response.body.includes("preview@example.test"), false);
    assert.equal("source" in manifest, false);
    for (const name of ["task", "observation"]) {
      const schema = await httpGet(server.baseUrl, manifest.schemas[name]);
      assert.equal(schema.status, 200);
      assert.equal(JSON.parse(schema.body).additionalProperties, false);
    }
  });
  it("cabinet discovery stays public, while files, keys and proof stay closed without configuration", async () => {
    assert.equal((await httpGet(server.baseUrl, "/cabinet")).status, 200);
    assert.equal((await httpGet(server.baseUrl, "/agent-cabinet.md")).status, 200);
    const denied = await fetch(`${server.baseUrl}/api/cabinet/catalog`);
    assert.equal(denied.status, 503);
    assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
    await denied.body?.cancel();
    assert.equal((await httpGet(server.baseUrl, "/api/cabinet/agent")).status, 401);
    assert.equal((await httpGet(server.baseUrl, "/cloud/cabinet-check")).status, 404);
    assert.equal((await httpPost(server.baseUrl, "/cloud/cabinet-check/run", {})).status, 404);
    const login = await fetch(`${server.baseUrl}/api/cabinet/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.test" }, body: '{"login":"owner","password":"fixture-only"}' });
    assert.equal(login.status, 403);
    const project = await httpGet(server.baseUrl, "/workbench?project=00000000-0000-4000-8000-000000000000");
    assert.equal(project.status, 307); assert.match(project.location ?? "", /\/cabinet/);
  });
  it("bank templates and command schema are public while mutation and lineage require cabinet authorization", async () => {
    const schema = await httpGet(server.baseUrl, "/.well-known/rrp-bank-command.schema.json");
    assert.equal(schema.status, 200); assert.equal(JSON.parse(schema.body).oneOf.length, 2);
    const template = await httpGet(server.baseUrl, "/bank-templates/participants.csv");
    assert.equal(template.status, 200); assert.match(template.body, /^participant_id,/);
    const blocked = await fetch(`${server.baseUrl}/api/cabinet/catalog`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.test" }, body: '{"command":"bank_preview","spec":{}}' });
    assert.equal(blocked.status, 403); await blocked.body?.cancel();
    assert.equal((await httpGet(server.baseUrl, "/api/cabinet/agent?lineage=11111111-1111-4111-8111-111111111111")).status, 401);
  });
  it("automation discovery is public, while job reads and launch remain authenticated and origin-bound", async () => {
    const schema = await httpGet(server.baseUrl, "/.well-known/rrp-automation-command.schema.json");
    assert.equal(schema.status, 200); assert.equal(JSON.parse(schema.body).oneOf.length, 2);
    assert.equal((await httpGet(server.baseUrl, "/api/cabinet/automation")).status, 503);
    assert.equal((await httpGet(server.baseUrl, "/api/cabinet/agent?jobs=1")).status, 401);
    const denied = await fetch(`${server.baseUrl}/api/cabinet/automation`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.test" }, body: '{"command":"start","request":{}}' });
    assert.equal(denied.status, 403); await denied.body?.cancel();
  });

  it("lab discovery is public; reads require cabinet and mutations are origin-bound", async () => {
    assert.equal((await httpGet(server.baseUrl, "/agent-simulation-lab.md")).status, 200);
    const schema = await httpGet(server.baseUrl, "/.well-known/rrp-lab-command.schema.json");
    assert.equal(schema.status, 200); assert.equal(JSON.parse(schema.body).oneOf.length, 4);
    assert.equal((await httpGet(server.baseUrl, "/api/cabinet/lab")).status, 503);
    const denied = await fetch(`${server.baseUrl}/api/cabinet/lab`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.test" }, body: '{"command":"generate","config":{"seed":"fixture"}}' });
    assert.equal(denied.status, 403); await denied.body?.cancel();
  });
  it("Quorum page/contracts are public and participant/operator writes are authenticated and origin-bound", async () => {
    const page = await httpGet(server.baseUrl, "/quorum"); assert.equal(page.status, 200); assert.match(page.body, /Кворум/);
    assert.equal((await httpGet(server.baseUrl, "/agent-quorum.md")).status, 200);
    for (const name of ["quorum-student-command", "quorum-admin-command", "quorum-agent-prediction", "quorum-study", "quorum-experiment"]) assert.equal((await httpGet(server.baseUrl, `/.well-known/${name}.schema.json`)).status, 200);
    assert.equal((await httpGet(server.baseUrl, "/api/quorum/agent")).status, 401);
    assert.equal((await httpGet(server.baseUrl, "/api/quorum")).status, 503);
    for (const path of ["/api/quorum", "/api/quorum/session", "/api/cabinet/quorum"]) {
      const denied = await fetch(`${server.baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.test" }, body: '{}' });
      assert.equal(denied.status, 403); assert.match(denied.headers.get("cache-control") ?? "", /no-store/); await denied.body?.cancel();
    }
  });
  it("a real create-study POST remains refused even with a valid file-database cookie", async () => {
    const ref = serverActionRefsFromBuild().find((entry) => entry.exportedName === "createStudyAction");
    assert.ok(ref);
    const response = await httpPost(server.baseUrl, "/studies", { [`$ACTION_ID_${ref.id}`]: "", code: "NO-WRITE", title: "Must not be stored", researchQuestion: "Preview must refuse research writes" }, { cookie, multipart: true });
    assert.ok([302, 303, 307, 308].includes(response.status));
    const row = server.db.prepare("SELECT COUNT(*) AS count FROM study").get() as { count: number };
    assert.equal(row.count, 0);
  });
});

it("Vercel production refuses SQLite database health until durable hosting is configured", { skip: requireNextBuild() }, async () => {
  const production = await startTestServer({ env: { VERCEL: "1", VERCEL_ENV: "production" } });
  try {
    const health = await httpGet(production.baseUrl, "/api/health");
    assert.equal(health.status, 503);
    assert.match(health.body, /Database health check unavailable/);
    assert.equal(health.body.includes(production.dbFile), false);
    const home = await httpGet(production.baseUrl, "/");
    assert.ok([302, 303, 307, 308].includes(home.status));
    assert.match(home.location ?? "", /\/quorum/);
    const panel = await httpGet(production.baseUrl, "/workbench");
    assert.equal(panel.status, 200);
    assert.match(panel.body, /Respondent Lab/);
    assert.equal(panel.body.includes('name="password"'), false);
    const participants = await httpGet(production.baseUrl, "/participants");
    const setup = await httpGet(production.baseUrl, "/cloud/setup");
    assert.equal(setup.status, 404);
    assert.equal((await httpGet(production.baseUrl, "/cloud/audit")).status, 404);
    assert.equal((await httpPost(production.baseUrl, "/cloud/audit", {})).status, 404);
    assert.ok([302, 303, 307, 308].includes(participants.status));
    assert.match(participants.location ?? "", /\/login/);
  } finally { await production.stop(); removeTempDb(production.dbFile); }
});
