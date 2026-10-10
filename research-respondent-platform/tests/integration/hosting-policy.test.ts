import { test } from "node:test";
import assert from "node:assert/strict";
import { hostingMode } from "../../lib/services/hosting-policy.ts";
import { getDb, resetDb } from "../../lib/db-context.ts";

test("Vercel preview ignores configured research files and cannot bootstrap a sign-in", () => {
  const old = { VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV, DATABASE_FILE: process.env.DATABASE_FILE };
  try {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.DATABASE_FILE = "/nonexistent/research-must-not-be-opened.db";
    const db = getDb();
    assert.equal(db.name, ":memory:");
    for (const table of ["app_user", "participant", "observed_answer", "derived_score"]) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      assert.equal(row.count, 0);
    }
    resetDb();
    process.env.VERCEL_ENV = "production";
    assert.throws(() => getDb(), /Durable deployment storage/);
  } finally {
    resetDb();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("hosting policy requires explicit preview environment and blocks default Vercel production", () => {
  assert.equal(hostingMode({}), "persistent-local");
  assert.equal(hostingMode({ VERCEL: "1" }), "blocked-production");
  assert.equal(hostingMode({ VERCEL_ENV: "production" }), "blocked-production");
  assert.equal(hostingMode({ VERCEL_ENV: "preview" }), "isolated-preview");
});
