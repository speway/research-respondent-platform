# Setup and operations

Everything below was derived from `package.json`, `db/index.ts`,
`scripts/migrate.ts`, `scripts/bootstrap.ts`, `lib/db-context.ts` and the test
harness. Commands that were executed while writing this document are marked
"[ran]"; commands that are documented but were not executed here are marked
"[not run]" with the reason.

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js >= 22 | `package.json` declares `engines.node >= 22`. The test and CLI scripts rely on `node --experimental-strip-types`, so TypeScript sources run without a build step. Verified locally on Node v24.21.0. |
| pnpm | The lockfile (`pnpm-lock.yaml`, lockfileVersion 9.0) was produced and validated with pnpm 11.7.0. `npm` also works for the package scripts, but the lockfile is a pnpm lockfile. |
| Native build toolchain | `better-sqlite3` is a native module. Current versions ship prebuilt binaries for common platforms; if a prebuild is unavailable, a C++ toolchain is required (on Windows the Visual Studio Build Tools, on Debian/Ubuntu `build-essential` and `python3`). |
| A writable data directory | The default database path is `<project root>/data/respondent-platform.db`. The directory is created on demand by `openDatabase()` if it does not exist. |

There is no `.gitignore` in the repository at the time of writing. If you add
version control, exclude `node_modules/`, `.next/`, `data/`, `*.db`,
`*.db-wal`, `*.db-shm` and `tsconfig.tsbuildinfo`.

## 2. Install

```bash
pnpm install
```

Notes:

- `pnpm-workspace.yaml` lists `better-sqlite3` and `sharp` under
  `onlyBuiltDependencies`, so their install scripts are allowed to run.
- If pnpm reports `ERR_PNPM_IGNORED_BUILDS` or the module fails to load, approve
  the build script once: `pnpm approve-builds`, then re-run `pnpm install`.
- Verify the native binding directly:

```bash
node -e "require('better-sqlite3'); console.log('better-sqlite3 native binding loaded')"
```

- In the environment used to write this document, `pnpm run <script>` aborts in
  pnpm's dependency check with `ERR_PNPM_IGNORED_BUILDS` before the script starts.
  The workaround used for verification was to invoke the underlying binaries
  directly, for example:

```bash
node ./node_modules/typescript/bin/tsc --noEmit
node ./node_modules/eslint/bin/eslint.js .
node --experimental-strip-types --test tests/unit/*.test.ts tests/integration/*.test.ts
node ./node_modules/next/dist/bin/next build
```

## 3. Environment variables

The application reads four environment variables (verified by searching for
`process.env` across `app/`, `components/`, `lib/`, `db/`, `scripts/`, `tests/`).
See `.env.example` for a copy-ready template with comments.

| Variable | Read by | Purpose |
| --- | --- | --- |
| `DATABASE_FILE` | `db/index.ts`, `scripts/migrate.ts`, `scripts/bootstrap.ts` | Absolute or relative path to the SQLite file. Default: `<project root>/data/respondent-platform.db`. Relative paths resolve against the current working directory. |
| `DATABASE_PATH` | `db/index.ts` | Legacy alias, used only when `DATABASE_FILE` is unset or blank. |
| `NODE_ENV` | `app/actions/auth.ts` | Sets the `Secure` flag on the session cookie when the value is exactly `production`. Next.js manages this for `next dev`, `next build` and `next start`. |
| `USERNAME` / `USER` | `db/index.ts` | Operating-system account name recorded in `schema_migration.applied_by`, defaulting to `system`. Provided by the OS; do not set them in `.env`. |

`GOOGLE_FORMS_SERVICE_ACCOUNT_JSON` is a reserved secret *reference name*
(`GOOGLE_FORMS_SECRET_REF` in `lib/domain/adapters/google-forms.ts`). No code
reads it today and no Google Forms transport is implemented; the name exists so
that a future authorized transport has a fixed, auditable reference. Secret
values must never be committed, logged or stored in a task contract.

Important: Next.js loads `.env` automatically for its own commands, but the
standalone CLI scripts read the process environment directly and do not parse
`.env` files, because the project has no dotenv dependency. Set the variable in
the shell for `db:migrate`, `db:status` and `bootstrap`:

```powershell
$env:DATABASE_FILE = "C:\data\respondent-platform.db"
npm run db:migrate
```

```bash
DATABASE_FILE=/data/respondent-platform.db npm run db:migrate
```

## 4. Database location and migrations

- Default file: `<project root>/data/respondent-platform.db`. In WAL mode SQLite
  also creates `respondent-platform.db-wal` and `respondent-platform.db-shm`
  beside it. Treat all three as one unit when copying or deleting.
- Migrations live in `db/migrations/` and are applied in file-name order.
- `openDatabase()` applies pending migrations by default
  (`openDatabase({ migrate: false })` skips them, which is what the status
  command uses). Opening the app or any script therefore brings the schema up to
  date.
- Every applied migration is recorded in `schema_migration` with a SHA-256
  checksum of the file content, the duration and the OS account name. The insert
  happens inside the same transaction as the migration itself, so a failed
  migration leaves no bookkeeping row.

Commands:

```bash
npm run db:migrate     # apply pending migrations
npm run db:status      # list migrations without writing anything
```

`db:status` prints one line per migration as `applied`, `applied (CHECKSUM
DRIFT)` or `pending`, then a summary, and exits with code 1 when any applied
migration shows checksum drift (so it can be used in CI). [not run] - running it
here would have created `data/`, which is outside this document's write scope.
Migration application itself is exercised by `tests/integration/migrations.test.ts`
against an in-memory database, which passed in the run recorded in the README
status table [ran].

## 5. First-run bootstrap

The application refuses to create its own first user. Use the bootstrap CLI:

```bash
npm run bootstrap -- --org "Example Research Lab" --email "pi@example.org" --password "<at least 10 characters>" --name "Principal Investigator"
```

- `--org` (or `--organization`), `--email` and `--password` are required;
  `--name` is optional.
- The password must be at least 10 characters, otherwise the command exits with
  code 2 and writes nothing.
- The command creates: the organization (or reuses the first existing one), one
  `admin` user with an scrypt password hash, and two retention defaults
  (`participant_private_identity`: 60 months, `audit_event`: 120 months, both
  with action `review`). It records the audit action `system.bootstrap` and
  prints "No participants, responses or scores were created."
- It is safe to re-run: an existing organization and an existing user are reused
  and the password is left unchanged.
- [not run] - this command writes a database file into `data/`. The logic is
  covered by `lib/services/bootstrap.ts` and was read in full.

If you open the app before bootstrapping, `/login` shows an explicit message
telling you to run the bootstrap command (`firstRunAction()` in
`app/actions/auth.ts`).

## 6. Development, build and server

```bash
npm run dev      # next dev on port 4310
npm run build    # production build (required before next start)
npm run start    # next start on port 4310
```

- The development port is fixed at 4310 by the scripts.
- `next start` refuses to run without a production build; the HTTP smoke suite
  checks for `.next/BUILD_ID` and skips itself with an explanatory message when
  the build is missing.
- `build` [ran]: exit code 0, routes `/`, `/_not-found`, `/api/health`,
  `/login`, `/participants`, `/studies`, `/studies/[id]` at the observation time
  (the library pages were added during the same session).
- The build prints an informational warning that `readdirSync` in `db/index.ts`
  causes the whole project to be traced into the deployment output. It does not
  fail the build; if deployment size matters, scope the migrations directory
  access or add a Turbopack ignore comment in `db/index.ts`.

Health probe: `GET /api/health` returns `{"status":"ok",...}` with the SQLite
`integrity_check` result, the number of applied migrations, pending migrations and
any checksum drift, and returns HTTP 503 when the database is unhealthy or
unreachable. It exposes no research data.

## 7. Quality gates

| Command | What it runs |
| --- | --- |
| `npm run lint` | `eslint .` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit and integration suites (`tests/unit/*.test.ts`, `tests/integration/*.test.ts`) |
| `npm run test:unit` | Unit suites only |
| `npm run test:integration` | Integration suite only |
| `npm run test:http` | HTTP smoke suite; requires a production build first |
| `npm run verify` | lint, typecheck, test and build in sequence |

Observed state at the observation timestamp in the README status table [ran]:

- `tsc --noEmit`: exit 0.
- unit + integration tests: 153 tests, 153 pass, 0 fail.
- `next build`: exit 0.
- `eslint .`: 5 errors - 3 `no-useless-escape` in `lib/import/plan.ts`, 2 unused
  bindings in `lib/services/orchestration.ts`. Lint is therefore not green, and
  `npm run verify` will stop at the lint step until those are fixed.
- HTTP smoke suite: 7 pass, 2 fail (missing `/library` page and a missing create
  form on `/studies` at that moment).

Run the HTTP smoke suite as:

```bash
npm run build
node --experimental-strip-types --test tests/http/smoke.test.ts
```

The suite boots `next start` against a throwaway database created under the
operating system temp directory, refuses to run against `data/respondent-platform.db`,
and removes its temporary files afterwards.

## 8. Resetting the database safely

A reset destroys all research data. Because observed answers, derived scores and
audit events are append-only, there is no partial "clean-up" path: the only way to
discard them is to remove the database file, which also discards the audit trail.
Copy anything you still need first.

1. Stop every process that holds the file: the dev or production server and any
   running script. SQLite in WAL mode keeps `-wal` and `-shm` sidecars, and open
   handles keep them alive.
2. Optional but recommended: checkpoint and back up.
   `sqlite3 data/respondent-platform.db "PRAGMA wal_checkpoint(TRUNCATE);"` (if
   the `sqlite3` CLI is available), then copy the `.db` file - after a checkpoint
   the sidecars no longer hold committed data.
3. Verify the absolute path before deleting anything. From the project root the
   files are `data/respondent-platform.db`, `data/respondent-platform.db-wal` and
   `data/respondent-platform.db-shm`. Never delete a computed path you have not
   inspected.
4. Delete the three files (the sidecars may not exist if the database was closed
   cleanly).
5. Recreate the schema and the first administrator:

```bash
npm run db:migrate
npm run bootstrap -- --org "Example Research Lab" --email "pi@example.org" --password "<at least 10 characters>"
```

6. Re-import the documented sources. Participants, answers and scores cannot be
   restored from anywhere else.

Notes:

- Do not delete the database while the server is running. On Windows the delete
  fails because the file is locked; on other systems the running process may keep
  writing to an unlinked file, so the data you think you removed stays in the
  open handle.
- `data/` is not tracked; there is no automated backup in the codebase.
- To reset only the schema during development, prefer pointing
  `DATABASE_FILE` at a throwaway path instead of deleting a shared database.

## 9. Migration checksum drift

How the runner behaves (`db/index.ts`):

- Each migration file's SHA-256 is recorded in `schema_migration.checksum` when it
  is applied.
- On every later run, an already-applied migration whose file checksum no longer
  matches is reported in `MigrationResult.checksumMismatches` and skipped. It is
  never re-applied, and nothing else is changed.
- `migrationStatus()` returns `{ id, applied, appliedAt, checksumMatches }` per
  file. `npm run db:status` prints `applied (CHECKSUM DRIFT)` and exits 1 when any
  drift exists.
- A migration that fails mid-way throws `Migration <id> failed: <message>`. The
  transaction rolls back, so neither the schema change nor the bookkeeping row is
  kept.

What to do:

1. Do not edit `db/index.ts` or the recorded checksum to silence the warning.
   The checksum exists to detect exactly that.
2. Determine which side changed: `git diff`/your backup for the migration file,
   and `SELECT id, applied_at, checksum, applied_by FROM schema_migration` for
   what the database recorded.
3. If the file was edited locally and the change was never released: restore the
   original file content, or, if the schema in the database is disposable,
   recreate the database (section 8) and re-apply.
4. If the change is a genuine, intended schema change: leave the applied file
   untouched and add a new migration file (next number, e.g. `0004_...sql`), then
   run `npm run db:migrate`. Environments that already applied the old file stay
   consistent, and fresh environments get the same end state.
5. Re-run `npm run db:status`; it must report 0 with checksum drift before you
   continue.

## 10. Troubleshooting

| Symptom | Cause and action |
| --- | --- |
| `ERR_PNPM_IGNORED_BUILDS` for `better-sqlite3`, or `Could not locate the bindings file` | pnpm skipped the native build script. Run `pnpm approve-builds` (select `better-sqlite3`), re-run `pnpm install`, then check with `node -e "require('better-sqlite3')"`. |
| `pnpm run <script>` aborts with a pnpm install error before the script starts | pnpm's dependency check runs an install first. Either fix the ignored-builds issue above, or run the underlying binary directly (`node ./node_modules/typescript/bin/tsc --noEmit`, `node --experimental-strip-types --test ...`, `node ./node_modules/next/dist/bin/next build`). |
| Login page says no organization exists | Run the bootstrap command in section 5. The application never creates the first administrator by itself. |
| `Error: listen EADDRINUSE ... 4310` | Another instance is running. Stop it or start on another port: `npx next dev --port 4311`. |
| `SQLITE_BUSY: database is locked` | WAL allows one writer at a time and the pragma sets `busy_timeout = 5000`. Close other scripts or servers that write to the same file, and confirm that a crashed process is not still holding it. |
| `next start` exits immediately | No production build: run `npm run build` first (`.next/BUILD_ID` must exist). |
| Database file is not created | `openDatabase()` creates the parent directory, but not an unwritable location. Point `DATABASE_FILE` at a writable absolute path, and remember that the CLI scripts ignore `.env`. |
| `npm run db:status` exits 1 | Checksum drift or a pending migration; see section 9. |
| `next build` warns that the whole project is traced | Informational, from `readdirSync` over `db/migrations` in `db/index.ts`. The build still succeeds; scope the path or add a Turbopack ignore comment if the deployment output size matters. |
| Lint fails | `eslint .` currently reports 5 errors (`lib/import/plan.ts`, `lib/services/orchestration.ts`). They are unrelated to documentation and must be fixed by the owning workstream before `npm run verify` can pass. |
| Windows: deleting `respondent-platform.db` fails | The server still holds the file. Stop it, then delete the `.db`, `-wal` and `-shm` files. |
