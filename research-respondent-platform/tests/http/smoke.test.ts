/**
 * End-to-end HTTP smoke test.
 *
 *   nodejs --experimental-strip-types --test tests/http/smoke.test.ts
 *
 * Preconditions: a production build must exist (`npm run build`, or `pnpm build`)
 * because the suite boots the real `next start` server. Without `.next/BUILD_ID`
 * the whole suite is skipped with a message from `requireNextBuild()`.
 *
 * The server always runs against a throwaway SQLite file in the OS temp
 * directory (asserted before boot); the researcher's data/respondent-platform.db
 * is never opened, written or deleted.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { bootstrap } from "../../lib/services/bootstrap.ts";
import { createStudy } from "../../lib/repo/studies.ts";
import { openDatabase } from "../../db/index.ts";
import {
  PROJECT_ROOT,
  REAL_DATABASE_FILE,
  builtPageRoutes,
  describeResponse,
  httpGet,
  httpPost,
  realDatabaseStamp,
  refusedToLogin,
  removeTempDb,
  requireNextBuild,
  routeFromWorker,
  serverActionRefsFromBuild,
  sessionCookieFrom,
  startTestServer,
  submitForm,
  tempDbSidecars,
  type TestServer,
} from "../helpers/server.ts";

const SKIP_REASON = requireNextBuild();

const ADMIN_EMAIL = "smoke.admin@example.org";
const ADMIN_PASSWORD = "smoke-test-password-2026";
const ORG_NAME = "Smoke Test Lab";
const STUDY_CODE = "SMOKE-01";

/** Pages named in the smoke contract (item 4). */
const AUTHENTICATED_PAGES = ["/", "/studies", "/participants", "/library", "/cohorts", "/forms", "/agents", "/audit", "/settings"];
/**
 * Route prefixes that host mutating server actions (item 7), with the table
 * that must stay unchanged when the call arrives without a session.
 */
const MUTATING_TARGETS: Array<{ prefix: string; table: string; fields: Record<string, string> }> = [
  {
    prefix: "/studies",
    table: "study",
    fields: { code: "UNAUTH-01", title: "Unauthorised attempt", researchQuestion: "This request carries no session cookie." },
  },
  {
    prefix: "/participants",
    table: "participant",
    fields: { pseudonym: "UNAUTH-P1", consentStatus: "granted", studyId: "" },
  },
  {
    prefix: "/library",
    table: "derived_score",
    fields: { sessionId: "none", instrumentVersionId: "none" },
  },
];
/** Strings that only ever appear when research records are rendered. */
const RESEARCH_DATA_MARKERS = ["data-table", "Study register", "Audit trail", "<table"];

let server: TestServer | null = null;
let sessionCookie: string | null = null;
let organizationId = "";
let adminUserId = "";
const realDatabaseExistedBefore = existsSync(REAL_DATABASE_FILE);
const realDatabaseStampBefore = realDatabaseStamp();

function routePageFile(route: string): string | null {
  const base = route === "/" ? join(PROJECT_ROOT, "app") : join(PROJECT_ROOT, "app", ...route.split("/").filter((part) => part.length > 0));
  for (const name of ["page.tsx", "page.ts", "page.jsx", "page.js"]) {
    const candidate = join(base, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function countRows(sql: string, ...params: Array<string | number>): number {
  const row = requireServer().db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

function requireServer(): TestServer {
  assert.ok(server, "the HTTP server must be running for this assertion");
  return server;
}

function requireCookie(): string {
  assert.ok(sessionCookie, "the login in step 3 must have produced a session cookie");
  return sessionCookie;
}

describe("HTTP smoke: production server on a throwaway database", { skip: SKIP_REASON }, () => {
  before(async () => {
    server = await startTestServer();
    assert.notEqual(server.dbFile, REAL_DATABASE_FILE, "the suite must never run against the real database");
  });

  after(async () => {
    if (server) {
      await server.stop();
      if (existsSync(server.dbFile)) removeTempDb(server.dbFile);
    }
  });

  it("1. unauthenticated GET / redirects to /login and renders no research data", async () => {
    const response = await httpGet(requireServer().baseUrl, "/");
    assert.ok(
      [302, 303, 307, 308].includes(response.status),
      `GET / without a session must redirect, got ${response.status} (body starts: ${response.body.slice(0, 200)})`,
    );
    assert.match(response.location ?? "", /\/login/, `redirect must target /login, got ${String(response.location)}`);
    for (const marker of RESEARCH_DATA_MARKERS) {
      assert.equal(response.body.includes(marker), false, `unauthenticated response must not contain "${marker}"`);
    }
  });

  it("2. GET /login returns 200 with the platform name and a sign-in form", async () => {
    const response = await httpGet(requireServer().baseUrl, "/login");
    assert.equal(response.status, 200);
    assert.match(response.body, /Research Respondent Platform/);
    assert.match(response.body, /name="email"/, "the sign-in form must expose an email control");
    assert.match(response.body, /name="password"/, "the sign-in form must expose a password control");
    assert.equal(response.setCookie.length, 0, "rendering the sign-in page must not issue a session cookie");
  });

  it("3. first-run bootstrap then a real login form POST yields a working session", async () => {
    const bootstrapped = bootstrap(requireServer().db, {
      organizationName: ORG_NAME,
      slug: "smoke-lab",
      adminEmail: ADMIN_EMAIL,
      adminPassword: ADMIN_PASSWORD,
      adminDisplayName: "Smoke Administrator",
    });
    assert.equal(bootstrapped.createdOrganization, true);
    assert.equal(bootstrapped.createdAdmin, true);
    organizationId = bootstrapped.organizationId;
    adminUserId = bootstrapped.adminUserId;

    const login = await submitForm(requireServer().baseUrl, "/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { requiredField: "email" });
    assert.ok(login.form, `the sign-in page must render a submittable form (posted to ${login.postedTo})`);
    assert.ok(
      [200, 302, 303, 307, 308].includes(login.response.status),
      `login POST returned ${login.response.status}: ${login.response.body.slice(0, 300)}`,
    );
    const cookie = sessionCookieFrom(login.response);
    assert.ok(cookie, `login must set a session cookie; status ${login.response.status}, location ${String(login.response.location)}`);
    assert.equal(login.response.body.includes(ADMIN_PASSWORD), false, "the response must never echo the password");
    sessionCookie = cookie;

    const home = await httpGet(requireServer().baseUrl, "/", { cookie });
    assert.equal(home.status, 200, "the session cookie must authenticate GET /");
    assert.equal(home.body.includes('name="password"'), false, "an authenticated home page is not the sign-in form");
    assert.ok(home.body.includes("/studies"), "the authenticated shell must link to the study register");
  });

  it("4. every implemented authenticated page renders 200", async () => {
    const built = new Set(builtPageRoutes());
    const notOk: string[] = [];
    const notImplemented: string[] = [];
    const staleBuild: string[] = [];
    for (const route of AUTHENTICATED_PAGES) {
      if (!built.has(route)) {
        (routePageFile(route) === null ? notImplemented : staleBuild).push(route);
        continue;
      }
      const response = await httpGet(requireServer().baseUrl, route, { cookie: requireCookie() });
      if (response.status !== 200) {
        notOk.push(`${route} -> ${response.status}${response.location ? ` (Location: ${response.location})` : ""}`);
      } else if (response.body.includes('name="password"')) {
        notOk.push(`${route} -> 200 but rendered the sign-in form`);
      }
    }
    assert.deepEqual(notOk, [], "built pages must render 200 for an authenticated administrator");
    assert.deepEqual(staleBuild, [], "these pages exist in app/ but not in the running build; rebuild before running this suite");
    assert.deepEqual(notImplemented, [], "routes named in the smoke contract have no page file on disk yet");
  });

  it("5. /studies shows the empty state, then a stored study appears in the register", async () => {
    const empty = await httpGet(requireServer().baseUrl, "/studies", { cookie: requireCookie() });
    assert.equal(empty.status, 200);
    assert.match(empty.body, /No studies yet/, "a fresh database must render the empty state");

    const study = createStudy(requireServer().db, {
      organizationId,
      code: STUDY_CODE,
      title: "Smoke test study",
      researchQuestion: "Does the HTTP suite observe a study created directly in the database?",
      createdBy: adminUserId,
    });
    assert.equal(study.code, STUDY_CODE);
    assert.equal(countRows("SELECT COUNT(*) AS n FROM study"), 1);

    const listed = await httpGet(requireServer().baseUrl, "/studies", { cookie: requireCookie() });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.includes(STUDY_CODE), `the register must show the stored study code ${STUDY_CODE}`);
    assert.equal(listed.body.includes("No studies yet"), false, "the empty state must disappear once a study exists");
  });

  it("6. /api/health reports a healthy database", async (t) => {
    const healthRoute = join(PROJECT_ROOT, "app", "api", "health", "route.ts");
    if (!existsSync(healthRoute)) {
      t.skip("app/api/health/route.ts does not exist yet");
      return;
    }
    const response = await httpGet(requireServer().baseUrl, "/api/health");
    assert.equal(response.status, 200, `health must return 200, got ${response.status}: ${response.body.slice(0, 300)}`);
    assert.match(response.contentType, /application\/json/);
    const payload = JSON.parse(response.body) as {
      status: string;
      database: { integrityCheck: string; migrationsApplied: number; migrationsPending: string[]; checksumDrift: string[] };
    };
    assert.equal(payload.status, "ok");
    assert.equal(payload.database.integrityCheck, "ok");
    assert.deepEqual(payload.database.migrationsPending, []);
    assert.deepEqual(payload.database.checksumDrift, []);
    assert.ok(payload.database.migrationsApplied >= 3, `expected the schema migrations to be applied, got ${payload.database.migrationsApplied}`);
    assert.equal(response.body.includes("participant"), false, "the health probe must not expose research tables");
  });

  it("7. an unauthenticated POST to a mutating server action is refused and changes nothing", async (t) => {
    const refs = serverActionRefsFromBuild();
    assert.ok(refs.length > 0, "the production build must register server actions in server-reference-manifest.json");

    // Match every registered action to the route that can reach it, then keep
    // the mutating ones (the create/update/delete/score family).
    const seen = new Set<string>();
    const candidates: Array<{ route: string; ref: (typeof refs)[number]; table: string; fields: Record<string, string> }> = [];
    for (const ref of refs) {
      if (!/^(create|update|delete|set|enrol|register|import|score|plan|revoke|approve)/i.test(ref.exportedName)) continue;
      for (const worker of ref.workers) {
        const route = routeFromWorker(worker);
        if (route === null) continue;
        const target = MUTATING_TARGETS.find((entry) => route === entry.prefix || route.startsWith(`${entry.prefix}/`));
        if (!target) continue;
        const key = `${route}#${ref.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ route, ref, table: target.table, fields: target.fields });
      }
    }
    candidates.sort((left, right) => left.ref.exportedName.localeCompare(right.ref.exportedName, "en"));
    const exercisedTargets = candidates.slice(0, 6);
    assert.ok(exercisedTargets.length > 0, `no mutating server action matched ${MUTATING_TARGETS.map((entry) => entry.prefix).join(", ")}`);

    const violations: string[] = [];
    const observations: string[] = [];
    let sawServerError = false;

    for (const { route, ref, table, fields } of exercisedTargets) {
      const label = `${route}#${ref.exportedName}`;
      // Progressive-enhancement envelope: the action id travels in the body,
      // exactly as a no-JS browser posts the form. Only the cookie differs
      // between the anonymous call and the authenticated control.
      const envelope = { [`$ACTION_ID_${ref.id}`]: "", ...fields };
      const rowsBefore = countRows(`SELECT COUNT(*) AS n FROM ${table}`);
      const anonymous = await httpPost(requireServer().baseUrl, route, envelope);
      const rowsAfter = countRows(`SELECT COUNT(*) AS n FROM ${table}`);

      if (rowsAfter !== rowsBefore) {
        violations.push(`${label}: an unauthenticated POST created ${rowsAfter - rowsBefore} ${table} row(s)`);
      }
      if (!refusedToLogin(anonymous)) {
        violations.push(
          `${label}: an unauthenticated POST was not refused with a login redirect, 401 or 403 — got ${describeResponse(anonymous)}: ${anonymous.body.slice(0, 160)}`,
        );
      }
      if (anonymous.status >= 500) sawServerError = true;

      // Positive control: the identical request with a session must get past the
      // auth gate, otherwise the refusal above would prove nothing.
      const authenticated = await httpPost(requireServer().baseUrl, route, envelope, { cookie: requireCookie() });
      if (refusedToLogin(authenticated)) {
        violations.push(`${label}: the authenticated control was ALSO refused (${describeResponse(authenticated)}), so the refusal above is not evidence of an auth gate`);
      }
      if (authenticated.status >= 500) sawServerError = true;

      observations.push(
        `${label}: anonymous -> ${describeResponse(anonymous)}, ${table} rows ${rowsBefore}->${rowsAfter}; ` +
          `authenticated control -> ${describeResponse(authenticated)}, ${table} rows now ${countRows(`SELECT COUNT(*) AS n FROM ${table}`)}`,
      );
    }

    for (const line of observations) t.diagnostic(line);
    if (sawServerError) t.diagnostic(`server log tail:\n${requireServer().logs().split("\n").slice(-12).join("\n")}`);
    assert.deepEqual(violations, [], "an unauthenticated server action call must never succeed or change state");
  });

  it("8. the audit trail records auth.sign_in success and denial", async () => {
    const successes = requireServer()
      .db.prepare("SELECT actor_id, outcome FROM audit_event WHERE action = 'auth.sign_in' AND outcome = 'success'")
      .all() as Array<{ actor_id: string | null; outcome: string }>;
    assert.ok(successes.length >= 1, "the successful login must be audited");
    assert.ok(successes.some((row) => row.actor_id === adminUserId), "the audited actor must be the administrator who signed in");

    const sessionsBefore = countRows("SELECT COUNT(*) AS n FROM auth_session");
    const deniedBefore = countRows("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'auth.sign_in' AND outcome = 'denied'");
    const bad = await submitForm(requireServer().baseUrl, "/login", { email: ADMIN_EMAIL, password: "not-the-password" }, { requiredField: "email" });
    assert.equal(sessionCookieFrom(bad.response), null, "a failed sign-in must not issue a session cookie");
    assert.equal(countRows("SELECT COUNT(*) AS n FROM auth_session"), sessionsBefore, "a failed sign-in must not create a session");
    assert.equal(
      countRows("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'auth.sign_in' AND outcome = 'denied'"),
      deniedBefore + 1,
      "a bad-password attempt must be audited as denied",
    );
    assert.equal(bad.response.body.includes("not-the-password"), false, "the response must never echo the attempted password");
    const denial = requireServer()
      .db.prepare("SELECT detail_json FROM audit_event WHERE action = 'auth.sign_in' AND outcome = 'denied' ORDER BY occurred_at DESC LIMIT 1")
      .get() as { detail_json: string } | undefined;
    assert.ok(denial, "the denial row must be readable");
    assert.match(denial.detail_json, /invalid_credentials_or_inactive/);
  });

  it("9. after shutdown the throwaway database is intact and then removed", async () => {
    const active = requireServer();
    const dbFile = active.dbFile;
    await active.stop();

    const verify = openDatabase({ file: dbFile, migrate: false });
    try {
      assert.equal(verify.pragma("integrity_check", { simple: true }), "ok", "the database must survive server shutdown intact");
      const tables = verify.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
      assert.ok(tables.n >= 30, `expected the migrated schema to persist, found ${tables.n} tables`);
      const audits = verify.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE action = 'auth.sign_in'").get() as { n: number };
      assert.ok(audits.n >= 2, `expected the audit rows written over HTTP to persist, found ${audits.n}`);
      const studies = verify.prepare("SELECT COUNT(*) AS n FROM study WHERE code = ?").get(STUDY_CODE) as { n: number };
      assert.equal(studies.n, 1, "the study created during the suite must persist in the throwaway database");
    } finally {
      verify.close();
    }

    if (realDatabaseExistedBefore) {
      assert.equal(realDatabaseStamp(), realDatabaseStampBefore, "the researcher's real database must not be modified");
    } else {
      assert.equal(
        existsSync(REAL_DATABASE_FILE),
        false,
        "the smoke suite must not create the real database; if another process created it, re-run this suite",
      );
    }

    removeTempDb(dbFile);
    for (const sidecar of tempDbSidecars(dbFile)) {
      assert.equal(existsSync(sidecar), false, `${sidecar} must be cleaned up`);
    }
  });
});
