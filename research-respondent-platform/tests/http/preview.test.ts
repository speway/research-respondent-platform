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
  } finally { await production.stop(); removeTempDb(production.dbFile); }
});
