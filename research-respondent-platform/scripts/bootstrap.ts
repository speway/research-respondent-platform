/**
 * Bootstrap CLI.
 *
 *   npm run bootstrap -- --org "Lab name" --email you@example.org --password "<min 10 chars>"
 *
 * Creates the organization, the first administrator and retention defaults, and
 * records an audit event. It never creates participants or research responses.
 */
import { openDatabase, PROJECT_ROOT } from "../db/index.ts";
import { bootstrap } from "../lib/services/bootstrap.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const organizationName = arg("org") ?? arg("organization");
const email = arg("email");
const password = arg("password");
const displayName = arg("name");
const file = process.env.DATABASE_FILE ?? `${PROJECT_ROOT}/data/respondent-platform.db`;

if (!organizationName || !email || !password) {
  console.error(
    [
      "Usage: npm run bootstrap -- --org \"<organization>\" --email <admin e-mail> --password \"<min 10 characters>\"",
      "Optional: --name \"<display name>\"",
      "",
      "This command creates no participants and no research responses.",
    ].join("\n"),
  );
  process.exit(2);
}
if (password.length < 10) {
  console.error("Refusing to continue: the password must contain at least 10 characters.");
  process.exit(2);
}

const db = openDatabase({ file });
try {
  const result = bootstrap(db, {
    organizationName,
    adminEmail: email,
    adminPassword: password,
    adminDisplayName: displayName,
  });
  console.log(`Database: ${file}`);
  console.log(`Organization: ${result.organizationName} (${result.organizationId})${result.createdOrganization ? " [created]" : " [existing]"}`);
  console.log(`Administrator: ${email}${result.createdAdmin ? " [created]" : " [existing, password unchanged]"}`);
  console.log("Retention defaults recorded for identity data and audit events.");
  console.log("No participants, responses or scores were created.");
} finally {
  db.close();
}
