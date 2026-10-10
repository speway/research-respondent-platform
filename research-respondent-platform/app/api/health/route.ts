/**
 * Health probe: reports process liveness plus database reachability and
 * migration state. Deliberately exposes no research data.
 */
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db-context.ts";
import { migrationStatus } from "../../../db/index.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const migrations = migrationStatus(db);
    const pending = migrations.filter((entry) => !entry.applied).map((entry) => entry.id);
    const drift = migrations.filter((entry) => entry.applied && entry.checksumMatches === false).map((entry) => entry.id);
    const integrity = db.pragma("integrity_check", { simple: true });
    const healthy = pending.length === 0 && drift.length === 0 && integrity === "ok";
    return NextResponse.json(
      {
        status: healthy ? "ok" : "degraded",
        database: {
          integrityCheck: integrity,
          migrationsApplied: migrations.filter((entry) => entry.applied).length,
          migrationsPending: pending,
          checksumDrift: drift,
        },
        timestamp: new Date().toISOString(),
      },
      { status: healthy ? 200 : 503 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
