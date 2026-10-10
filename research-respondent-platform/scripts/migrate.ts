/**
 * Migration runner CLI.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:status             show migration status without writing
 */
import { openDatabase, migrationStatus, PROJECT_ROOT } from "../db/index.ts";

const isStatus = process.argv.includes("--status");
const file = process.env.DATABASE_FILE ?? `${PROJECT_ROOT}/data/respondent-platform.db`;

if (isStatus) {
  const db = openDatabase({ file, migrate: false });
  const rows = migrationStatus(db);
  console.log(`Database: ${file}`);
  for (const row of rows) {
    const mark = row.applied ? (row.checksumMatches ? "applied" : "applied (CHECKSUM DRIFT)") : "pending";
    console.log(`  ${row.id.padEnd(28)} ${mark}${row.appliedAt ? `  ${row.appliedAt}` : ""}`);
  }
  const pending = rows.filter((row) => !row.applied).length;
  const drift = rows.filter((row) => row.applied && row.checksumMatches === false).length;
  console.log(`\n${rows.length} migration(s), ${pending} pending, ${drift} with checksum drift.`);
  db.close();
  process.exit(drift > 0 ? 1 : 0);
} else {
  const db = openDatabase({ file });
  const result = migrationStatus(db);
  console.log(`Database: ${file}`);
  console.log(result.map((row) => `  ${row.applied ? "applied" : "pending"}  ${row.id}`).join("\n"));
  db.close();
}
