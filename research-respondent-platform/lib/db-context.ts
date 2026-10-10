/**
 * Process-wide database handle.
 *
 * Next.js dev mode reloads modules; the connection is cached on globalThis so a
 * reload does not leak file handles or lose the WAL writer lock.
 */
import { hostingMode } from "./services/hosting-policy.ts";
import { openDatabase, runMigrations, type Db } from "../db/index.ts";

const GLOBAL_KEY = "__researchRespondentPlatformDb__";

type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: Db };

export function getDb(): Db {
  const mode = hostingMode(process.env);
  if (mode === "blocked-production") throw new Error("Durable deployment storage is not configured.");
  const container = globalThis as GlobalWithDb;
  if (!container[GLOBAL_KEY]) {
    const db = openDatabase(mode === "isolated-preview" ? { file: ":memory:" } : {});
    container[GLOBAL_KEY] = db;
  }
  return container[GLOBAL_KEY];
}

/** For scripts/tests that need a fresh database in the same process. */
export function resetDb(): void {
  const container = globalThis as GlobalWithDb;
  if (container[GLOBAL_KEY]) {
    container[GLOBAL_KEY].close();
    delete container[GLOBAL_KEY];
  }
}

export function migrateNow(): void {
  runMigrations(getDb());
}

export type { Db };
