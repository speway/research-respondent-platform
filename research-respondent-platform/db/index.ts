/**
 * SQLite connection factory and migration runner.
 *
 * This module is intentionally free of Next.js imports so that the exact same
 * data layer is exercised by unit tests, integration tests and the running
 * application. Server-only enforcement happens in `lib/services/guard.ts`.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));
/** Project root = the directory that contains package.json / db / lib. */
export const PROJECT_ROOT = existsSync(join(process.cwd(), "db", "pragmas.sql")) ? process.cwd() : resolve(HERE, "..");
export const MIGRATIONS_DIR = join(PROJECT_ROOT, "db", "migrations");
const PRAGMAS_FILE = join(PROJECT_ROOT, "db", "pragmas.sql");

export interface OpenOptions {
  /** Absolute path, or ":memory:" for throwaway test databases. */
  file?: string;
  /** Apply all pending migrations immediately. Default true. */
  migrate?: boolean;
  /** Skip WAL pragma (required for :memory:). */
  readonly?: boolean;
}

function resolveDatabaseFile(): string {
  const configured = process.env.DATABASE_FILE ?? process.env.DATABASE_PATH;
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }
  return join(PROJECT_ROOT, "data", "respondent-platform.db");
}

function applyPragmas(db: Db, isMemory: boolean): void {
  const sql = readFileSync(PRAGMAS_FILE, "utf8");
  const statements = sql
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));
  for (const statement of statements) {
    try {
      if (isMemory && /journal_mode/i.test(statement)) {
        continue;
      }
      db.exec(statement);
    } catch (error) {
      // Pragmas are best-effort: a read-only or unusual filesystem may reject
      // WAL. Foreign keys are the only non-negotiable one, so re-check it.
      if (/foreign_keys/i.test(statement)) {
        throw error;
      }
    }
  }
  const fk = db.pragma("foreign_keys", { simple: true });
  if (fk !== 1) {
    db.pragma("foreign_keys = ON");
  }
}

export function openDatabase(options: OpenOptions = {}): Db {
  const file = options.file ?? resolveDatabaseFile();
  const isMemory = file === ":memory:";
  if (!isMemory && !existsSync(dirname(file))) {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file, {
    readonly: options.readonly ?? false,
    fileMustExist: false,
  });
  applyPragmas(db, isMemory);
  if (options.migrate !== false) {
    runMigrations(db);
  }
  return db;
}

export interface MigrationFile {
  id: string;
  path: string;
  sql: string;
  checksum: string;
}

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(/* turbopackIgnore: true */ dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
  return files.map((name) => {
    const path = join(dir, name);
    const sql = readFileSync(/* turbopackIgnore: true */ path, "utf8");
    return {
      id: name.replace(/\.sql$/, ""),
      path,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  checksumMismatches: string[];
}

/**
 * Apply pending migrations. Each migration runs inside a transaction; the
 * recorded checksum detects edits to already-applied migrations, which would
 * otherwise silently diverge environments.
 */
export function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    applied_by TEXT NOT NULL
  )`);

  const files = loadMigrationFiles(dir);
  const existing = new Map<string, string>();
  for (const row of db
    .prepare("SELECT id, checksum FROM schema_migration")
    .all() as Array<{ id: string; checksum: string }>) {
    existing.set(row.id, row.checksum);
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  const checksumMismatches: string[] = [];

  const insert = db.prepare(
    `INSERT INTO schema_migration (id, applied_at, checksum, duration_ms, applied_by)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (const file of files) {
    const known = existing.get(file.id);
    if (known !== undefined) {
      if (known !== file.checksum) {
        checksumMismatches.push(file.id);
      }
      skipped.push(file.id);
      continue;
    }
    const startedAt = Date.now();
    const run = db.transaction(() => {
      db.exec(file.sql);
      insert.run(
        file.id,
        new Date().toISOString(),
        file.checksum,
        Date.now() - startedAt,
        process.env.USERNAME ?? process.env.USER ?? "system",
      );
    });
    try {
      run();
      applied.push(file.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${file.id} failed: ${message}`);
    }
  }

  return { applied, skipped, checksumMismatches };
}

export function migrationStatus(db: Db, dir: string = MIGRATIONS_DIR) {
  const files = loadMigrationFiles(dir);
  // A status probe must not create migration metadata or fail on a fresh DB.
  const hasMetadata = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get();
  const rows = (hasMetadata ? db
    .prepare("SELECT id, applied_at, checksum FROM schema_migration ORDER BY id")
    .all() : []) as Array<{ id: string; applied_at: string; checksum: string }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return files.map((file) => {
    const record = byId.get(file.id);
    return {
      id: file.id,
      applied: record !== undefined,
      appliedAt: record?.applied_at ?? null,
      checksumMatches: record ? record.checksum === file.checksum : null,
    };
  });
}
