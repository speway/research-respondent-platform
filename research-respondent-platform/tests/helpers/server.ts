/**
 * HTTP smoke-test harness.
 *
 * Boots the real production server (`next start`) against a throwaway SQLite
 * file in the OS temp directory, so the smoke suite can prove end-to-end
 * behaviour over HTTP without ever touching a researcher's database.
 *
 *   nodejs --experimental-strip-types --test tests/http/smoke.test.ts
 *
 * A production build must exist first (`npm run build` / `pnpm build`), because
 * `next start` refuses to run without `.next`. `requireNextBuild()` turns that
 * precondition into a clear suite-level skip instead of a confusing crash.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT as DB_PROJECT_ROOT, openDatabase, type Db } from "../../db/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "..", "..");
/** The researcher's real database: this suite must never open, create or touch it. */
export const REAL_DATABASE_FILE = resolve(PROJECT_ROOT, "data", "respondent-platform.db");
const NEXT_BIN = join(PROJECT_ROOT, "node_modules", "next", "dist", "bin", "next");
const BUILD_ID_FILE = join(PROJECT_ROOT, ".next", "BUILD_ID");
/** Mirrors SESSION_COOKIE in lib/services/session.ts (that module imports next/headers). */
export const SESSION_COOKIE_NAME = "rrp_session";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// --------------------------------------------------------------- build gate --

/**
 * `false` when a production build is present, otherwise a skip reason that the
 * whole HTTP suite is registered with.
 */
export function requireNextBuild(): false | string {
  if (existsSync(BUILD_ID_FILE)) return false;
  return `next start requires a production build: ${BUILD_ID_FILE} is missing. Run \`npm run build\` (or \`pnpm build\`) in ${PROJECT_ROOT}, then re-run: nodejs --experimental-strip-types --test tests/http/smoke.test.ts`;
}

// ----------------------------------------------------------- temp database --

/**
 * Throwaway database path. Fails loudly if it is not under the OS temp dir or
 * if it resolves to the real database file.
 */
export function createTempDbPath(): string {
  const file = resolve(join(tmpdir(), `rrp-http-smoke-${randomUUID()}.db`));
  assert.notEqual(file, REAL_DATABASE_FILE, "refusing to run the smoke suite against the real database file");
  assert.ok(file.startsWith(resolve(tmpdir())), `temp database must live under ${tmpdir()}, got ${file}`);
  assert.ok(file.endsWith(".db"), `temp database must be a .db file, got ${file}`);
  return file;
}

export function tempDbSidecars(file: string): string[] {
  return [file, `${file}-wal`, `${file}-shm`, `${file}-journal`];
}

/** Removes the temp database and its WAL/SHM companions; asserts the main file is gone. */
export function removeTempDb(file: string): void {
  assert.notEqual(resolve(file), REAL_DATABASE_FILE, "refusing to delete the real database file");
  for (const candidate of tempDbSidecars(file)) {
    rmSync(candidate, { force: true });
  }
  assert.equal(existsSync(file), false, `temp database ${file} should have been deleted`);
}

/** mtime of the real database, or null when it does not exist (used to prove it was untouched). */
export function realDatabaseStamp(): number | null {
  return existsSync(REAL_DATABASE_FILE) ? statSync(REAL_DATABASE_FILE).mtimeMs : null;
}

// -------------------------------------------------------------- http client --

export interface HttpResult {
  status: number;
  location: string | null;
  setCookie: string[];
  contentType: string;
  /** `x-action-redirect` set by Next when a server action answers with a redirect. */
  actionRedirect: string | null;
  url: string;
  body: string;
}

export interface RequestOptions {
  cookie?: string | null;
  headers?: Record<string, string>;
}

async function toResult(response: Response, url: string): Promise<HttpResult> {
  const body = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    setCookie: response.headers.getSetCookie(),
    contentType: response.headers.get("content-type") ?? "",
    actionRedirect: response.headers.get("x-action-redirect"),
    url,
    body,
  };
}

export async function httpGet(baseUrl: string, path: string, options: RequestOptions = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: "text/html,application/json", ...options.headers };
  if (options.cookie) headers["cookie"] = options.cookie;
  const response = await fetch(`${baseUrl}${path}`, { redirect: "manual", headers });
  return toResult(response, `${baseUrl}${path}`);
}

export interface PostOptions extends RequestOptions {
  /** Server-action id for the `Next-Action` header (JS-only form path). */
  actionId?: string | null;
  /** Send multipart/form-data instead of urlencoded. */
  multipart?: boolean;
}

export async function httpPost(
  baseUrl: string,
  path: string,
  fields: Record<string, string>,
  options: PostOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    // Server actions verify same-origin: Origin must match the Host header.
    origin: baseUrl,
    referer: `${baseUrl}${path}`,
    accept: "text/x-component,text/html,application/json",
    ...options.headers,
  };
  if (options.cookie) headers["cookie"] = options.cookie;
  if (options.actionId) headers["next-action"] = options.actionId;

  let body: FormData | URLSearchParams;
  if (options.multipart) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    body = form;
  } else {
    body = new URLSearchParams(fields);
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", redirect: "manual", headers, body });
  return toResult(response, `${baseUrl}${path}`);
}

/** `rrp_session=<token>` pair (ready for a Cookie header), or null. */
export function sessionCookieFrom(response: HttpResult, name: string = SESSION_COOKIE_NAME): string | null {
  for (const raw of response.setCookie) {
    const pair = raw.split(";")[0]?.trim() ?? "";
    if (pair.startsWith(`${name}=`) && pair.length > name.length + 2) return pair;
  }
  return null;
}

// --------------------------------------------------------------- html forms --

export interface ParsedForm {
  action: string;
  method: string;
  enctype: string;
  /** name → value for every <input type="hidden">, i.e. React's server-action envelope. */
  hidden: Record<string, string>;
  /** Names of fillable controls (inputs, textareas, selects). */
  names: string[];
  actionId: string | null;
}

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&#34;": '"',
  "&#x22;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#x27;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&nbsp;": " ",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(?:quot|#34|#x22|apos|#39|#x27|lt|gt|amp|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
}

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = /([a-zA-Z_:$][-a-zA-Z0-9_:.$]*)\s*=\s*"([^"]*)"|([a-zA-Z_:$][-a-zA-Z0-9_:.$]*)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    const name = (match[1] ?? match[3] ?? "").toLowerCase();
    if (name) found[name] = decodeEntities(match[2] ?? match[4] ?? "");
  }
  return found;
}

export function parseForms(html: string): ParsedForm[] {
  const forms: ParsedForm[] = [];
  const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match: RegExpExecArray | null;
  while ((match = formPattern.exec(html)) !== null) {
    const tag = match[1] ?? "";
    const inner = match[2] ?? "";
    const attrs = attributes(tag);
    const hidden: Record<string, string> = {};
    const names: string[] = [];
    const controlPattern = /<(input|textarea|select)\b([^>]*)>/gi;
    let control: RegExpExecArray | null;
    while ((control = controlPattern.exec(inner)) !== null) {
      const controlAttrs = attributes(control[2] ?? "");
      const name = controlAttrs["name"];
      if (!name) continue;
      if ((controlAttrs["type"] ?? "").toLowerCase() === "hidden") {
        hidden[name] = controlAttrs["value"] ?? "";
      } else {
        names.push(name);
      }
    }
    const actionIdKey = Object.keys(hidden).find((key) => /^\$ACTION_ID_[0-9a-f]+$/i.test(key));
    forms.push({
      action: attrs["action"] ?? "",
      method: (attrs["method"] ?? "get").toLowerCase(),
      enctype: (attrs["enctype"] ?? "application/x-www-form-urlencoded").toLowerCase(),
      hidden,
      names,
      actionId: actionIdKey ? actionIdKey.replace(/^\$ACTION_ID_/i, "") : null,
    });
  }
  return forms;
}

/** Picks the form that owns `requiredField`, else the first submittable form. */
export function findForm(html: string, requiredField?: string): ParsedForm | null {
  const forms = parseForms(html);
  if (requiredField) {
    const owning = forms.find((form) => form.names.includes(requiredField));
    if (owning) return owning;
  }
  return forms.find((form) => form.method === "post" || Object.keys(form.hidden).length > 0) ?? forms[0] ?? null;
}

// -------------------------------------------------- registered server actions --

export interface ServerActionRef {
  id: string;
  filename: string;
  exportedName: string;
  /** Route-tree entries (e.g. "app/studies/page") that can reach this action. */
  workers: string[];
}

/**
 * Server actions registered by the production build. The smoke suite needs
 * these because a client component that wraps a server action in a local async
 * function renders no progressive-enhancement envelope, leaving the action id
 * as the only way to replay the endpoint over HTTP.
 */
export function serverActionRefsFromBuild(): ServerActionRef[] {
  const file = join(PROJECT_ROOT, ".next", "server", "server-reference-manifest.json");
  if (!existsSync(file)) return [];
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    node?: Record<string, { workers?: Record<string, unknown>; filename?: string; exportedName?: string }>;
  };
  return Object.entries(manifest.node ?? {}).map(([id, entry]) => ({
    id,
    filename: entry.filename ?? "",
    exportedName: entry.exportedName ?? "",
    workers: Object.keys(entry.workers ?? {}),
  }));
}

/** "app/studies/page" → "/studies"; dynamic and API entries return null. */
export function routeFromWorker(worker: string): string | null {
  if (worker === "app/page") return "/";
  const match = /^app\/(.+)\/page$/.exec(worker);
  if (match === null) return null;
  const segments = (match[1] ?? "").split("/");
  if (segments.some((segment) => segment.startsWith("[") || segment.startsWith("("))) return null;
  return `/${segments.join("/")}`;
}

/**
 * Static page routes the running build actually serves, taken from
 * `.next/server/app-paths-manifest.json`. Using the build (not the source tree)
 * keeps "not implemented" and "built but failing" distinguishable.
 */
export function builtPageRoutes(): string[] {
  const file = join(PROJECT_ROOT, ".next", "server", "app-paths-manifest.json");
  if (!existsSync(file)) return [];
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const routes: string[] = [];
  for (const key of Object.keys(manifest)) {
    if (!key.endsWith("/page") || key.includes("[")) continue;
    routes.push(key === "/page" ? "/" : key.slice(0, -"/page".length));
  }
  return routes;
}

export interface SubmitResult {
  response: HttpResult;
  form: ParsedForm | null;
  /** Path the POST was actually sent to. */
  postedTo: string;
}

/**
 * Posts an already-parsed form with the supplied values. The caller decides
 * whether to send a session cookie, which is what lets the smoke suite replay a
 * real form submission both authenticated and unauthenticated.
 */
export async function submitParsedForm(
  baseUrl: string,
  pagePath: string,
  form: ParsedForm,
  fields: Record<string, string>,
  options: { cookie?: string | null } = {},
): Promise<HttpResult> {
  const rawAction = form.action.trim();
  const usableAction = rawAction.startsWith("/") || rawAction.startsWith("http");
  const postedTo = usableAction ? (rawAction.startsWith("http") ? rawAction : `${baseUrl}${rawAction}`) : `${baseUrl}${pagePath}`;
  const multipart = form.enctype.includes("multipart");
  const body: Record<string, string> = { ...form.hidden, ...fields };
  const response = await fetch(postedTo, {
    method: "POST",
    redirect: "manual",
    headers: {
      // Server actions verify same-origin: Origin must match the Host header.
      origin: baseUrl,
      referer: `${baseUrl}${pagePath}`,
      ...(multipart ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      // Only a JS-driven form needs the action id in a header.
      ...(usableAction || form.actionId === null ? {} : { "next-action": form.actionId }),
    },
    body: multipart
      ? Object.entries(body).reduce((payload, [name, value]) => {
          payload.append(name, value);
          return payload;
        }, new FormData())
      : new URLSearchParams(body),
  });
  return toResult(response, postedTo);
}

/**
 * Fills and submits a rendered form exactly like a no-JS browser: hidden
 * server-action envelope fields plus the supplied values, posted to the form's
 * own action URL. Falls back to the `Next-Action` header when the form has no
 * usable action URL.
 */
export async function submitForm(
  baseUrl: string,
  pagePath: string,
  fields: Record<string, string>,
  options: { cookie?: string | null; requiredField?: string } = {},
): Promise<SubmitResult> {
  const page = await httpGet(baseUrl, pagePath, { cookie: options.cookie });
  const form = findForm(page.body, options.requiredField);
  if (form === null) {
    const response = await httpPost(baseUrl, pagePath, fields, { cookie: options.cookie, multipart: true });
    return { response, form: null, postedTo: pagePath };
  }
  const response = await submitParsedForm(baseUrl, pagePath, form, fields, { cookie: options.cookie });
  return { response, form, postedTo: form.action.trim() || pagePath };
}

/**
 * True when a response proves the request was refused for lack of a session:
 * a redirect to /login (header or action-level), a 401/403, or an action
 * payload that carries the login redirect. A 5xx is deliberately NOT treated as
 * a refusal: it may mean the action crashed after passing the auth gate.
 */
export function refusedToLogin(response: HttpResult): boolean {
  if (response.status >= 300 && response.status < 400) return (response.location ?? "").includes("/login");
  if (response.status === 401 || response.status === 403) return true;
  if ((response.actionRedirect ?? "").includes("/login")) return true;
  return response.status === 200 && response.body.includes("/login");
}

/** Compact description of a response for assertion messages and diagnostics. */
export function describeResponse(response: HttpResult): string {
  const parts = [`status ${response.status}`];
  if (response.location) parts.push(`location ${response.location}`);
  if (response.actionRedirect) parts.push(`x-action-redirect ${response.actionRedirect}`);
  parts.push(`content-type ${response.contentType || "(none)"}`);
  return parts.join(", ");
}

// ------------------------------------------------------------------ server --

export interface StartTestServerOptions {
  env?: Record<string, string>;
  /** Milliseconds to wait for the port to answer. */
  readyTimeoutMs?: number;
}

export interface TestServer {
  baseUrl: string;
  port: number;
  dbFile: string;
  db: Db;
  /** Bounded stdout/stderr tail from `next start`, for failure diagnostics. */
  logs(): string;
  /** Terminates the server, closes the harness database handle, keeps the file. */
  stop(): Promise<void>;
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done, fail) => {
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => done());
  });
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  assert.ok(port > 0, "could not allocate a free TCP port");
  return port;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

export async function startTestServer(options: StartTestServerOptions = {}): Promise<TestServer> {
  assert.equal(resolve(PROJECT_ROOT), resolve(DB_PROJECT_ROOT), "helper and db module disagree on the project root");
  const skipReason = requireNextBuild();
  assert.equal(skipReason, false, `startTestServer called without a production build: ${skipReason}`);
  assert.ok(existsSync(NEXT_BIN), `next binary not found at ${NEXT_BIN}; install dependencies first`);

  const dbFile = createTempDbPath();
  const port = await findFreePort();
  // Open (and migrate) the throwaway database here so the test process can write
  // before the server is asked to serve it.
  const db: Db = openDatabase({ file: dbFile });

  const lines: string[] = [];
  const push = (chunk: Buffer | string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim().length > 0) lines.push(line.trimEnd());
    }
    while (lines.length > 200) lines.shift();
  };
  const logs = () => (lines.length === 0 ? "(no server output)" : lines.join("\n"));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_FILE: dbFile,
    DATABASE_PATH: dbFile,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    ...options.env,
  };
  // The override is the whole point of this harness: re-assert it.
  assert.equal(env["DATABASE_FILE"], dbFile, "DATABASE_FILE must point at the throwaway database");
  assert.notEqual(resolve(env["DATABASE_FILE"] ?? ""), REAL_DATABASE_FILE, "refusing to start the server against the real database");

  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 90_000);
  let lastError = "no response yet";
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      db.close();
      throw new Error(`next start exited before answering (code ${child.exitCode}, signal ${child.signalCode}).\n${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/login`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      await response.arrayBuffer();
      ready = true;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  if (!ready) {
    child.kill();
    db.close();
    throw new Error(`next start did not answer on ${baseUrl} within the ready timeout (last error: ${lastError}).\n${logs()}`);
  }

  let stopped = false;
  return {
    baseUrl,
    port,
    dbFile,
    db,
    logs,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      child.kill();
      if (!(await waitForExit(child, 10_000))) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
      db.close();
    },
  };
}
