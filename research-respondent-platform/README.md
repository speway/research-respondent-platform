# Research Respondent Platform

A source-backed research data platform: it registers pseudonymous participants,
stores what documented source documents actually say, scores versioned
instruments, evaluates cohort eligibility, maps documented values onto
researcher-controlled external forms, and runs multi-agent tasks with an
append-only audit trail.

The platform is built for one property above all others: **no value exists
without a documented source**. It never invents participants, answers, scores,
consent records or missing values, and it never claims an external submission
that did not verifiably happen.

## The non-negotiable rule

> Every participant, answer, score, consent record and payload value must trace
> back to a documented source, to a versioned algorithm applied to documented
> answers, or to a constant the researcher declared explicitly. A documented
> missing answer is a documented missing answer: it becomes a blocking reason for
> a required field, a warning with the key omitted for an optional field, and
> never a value, dash, empty string or placeholder.

This rule is enforced in the schema (CHECK constraints and triggers), in the pure
domain layer (scoring, cohort, mapping, task contracts) and in the UI (missing
counts and integrity alerts are shown, not hidden). The full policy, including
what the platform refuses to do and where each refusal lives, is in
[docs/RESEARCH_INTEGRITY.md](docs/RESEARCH_INTEGRITY.md).

## Operating model

The pipeline below is the intended end-to-end flow. Each stage names the code
that implements it and the gate that protects it.

1. **Documented participant record.** Research data enters only through a
   `documented_source` (spreadsheet, Google Form export, SPSS dataset, paper
   form, transcript, signed manual entry, instrument report). `lib/import/plan.ts`
   builds a plan with per-cell issues, blockers and warnings;
   `lib/services/import-commit.ts` writes participants, sessions, answers and the
   consent declaration with provenance (`source_locator`, checksum, audit action
   `import.commit`).
   Gate: no commit without a declared consent basis and an evidence note; answers
   are append-only once written.

2. **Verified participant record.** `participant` holds a pseudonym plus
   cohort-safe attributes and an explicit missingness map. Identity data
   (name, e-mail, phone) lives only in `participant_private_identity` and requires
   a documented lawful basis plus an `identity:read` grant.
   Gate: identity separation and access grants (`lib/services/authz.ts`).

3. **Study eligibility.** Studies carry versioned protocols and machine-readable
   inclusion/exclusion criteria. `lib/domain/cohort.ts` evaluates them and returns
   include / exclude / **indeterminate** with observed-vs-expected explanations;
   evaluations are frozen into `segment_snapshot` revisions and
   `eligibility_decision` rows.
   Gate: absent data defaults to `indeterminate`; it is never counted as
   satisfied.

4. **Instrument mapping and scoring.** Instruments are versioned, item wording is
   frozen once answers exist, and scoring algorithms are declarative versioned
   pipelines executed by `lib/domain/scoring.ts` (reverse-keying, declared
   scaling, band and percentile lookups, four missing-data policies). Scores store
   the algorithm version, the exact source items, and are immutable.
   Gate: no imputation; non-computable scores carry a reason; a clinical band is
   withheld without `clinical_use_permitted`.

5. **Form mapping and preflight.** `external_form_version` snapshots a form
   structure; `field_mapping` binds each field to a documented answer, a score, a
   participant attribute, a declared constant or `unmapped`.
   `lib/domain/mapping.ts` validates each binding and `buildPreflight()` produces
   a report with per-field outcomes, provenance, counts, blocking reasons and a
   **dry-run payload** for researcher review. It also detects structural drift
   between form versions and can suggest mappings (suggestions only; a human must
   accept them).
   Gate: required unmapped fields, out-of-range values, values that are not among
   the form's options, non-date sources for date fields, withdrawn consent and
   broken mapping references all block.

6. **Agent assignment and authorized execution.** `agent` and `agent_capability`
   define what an executor may do; `createTaskFromPreflight()` derives a
   pseudonymous `AgentTaskContract` with an idempotency key and a SHA-256 contract
   hash. `lib/domain/task-flow.ts` owns the 10-state machine, the approval gate
   (principal investigator or reviewer) and the retry policy.
   Gate: `validateContract()` rejects identity or credential keys, expired
   contracts, submission permission without a callback, and required fields
   without a documented source.

7. **Validation and audit log.** Every consequential action writes an
   `audit_event` (append-only, enforced by triggers); task attempts and execution
   evidence carry SHA-256 hashes; `mapping_validation` keeps validation history;
   `auditIntegrityReport()` verifies that the append-only triggers still exist.
   Gate: UPDATE and DELETE on audit events, observed answers and derived scores are
   rejected by the database itself.

## Architecture and stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Runtime | Node.js >= 22 | TypeScript sources run directly in tests and scripts via `node --experimental-strip-types`. |
| Framework | Next.js 16 (App Router), React 19 | Server components and server actions; `next dev`/`next start` on port 4310. |
| Language | TypeScript 5.9, `strict`, `noUncheckedIndexedAccess` | `@/*` path alias; `.ts` extension imports are enabled (`allowImportingTsExtensions`). |
| Data | SQLite via `better-sqlite3` 13 | WAL, `foreign_keys = ON`, `busy_timeout = 5000`, `trusted_schema = OFF`. No ORM: all SQL lives in `lib/repo/*.ts`. |
| Validation | `zod` 4 | Used in some server actions; the domain layer stays dependency-free with hand-written guards in `lib/domain/guards.ts`. |
| UI | Tailwind CSS 4 | Server-rendered pages with a small component set in `components/`. |

Layering (dependencies point downward):

```
app/                  pages and server actions (auth, studies, participants, library, cohorts, forms)
  |
components/           presentational React components (nav, panels, forms, table helpers)
  |
lib/services/         use cases: session, authz, audit, cohorts, orchestration, import-commit, bootstrap
  |
lib/repo/             SQL for every table (studies, participants, sources, assessments, cohorts, forms, tasks, exports, org)
  |
lib/domain/           pure, framework-free rules: types.ts, cohort.ts, scoring.ts, mapping.ts, task-flow.ts, guards.ts, adapters/
lib/import/           tabular parsing (CSV/XLSX) and import planning
  |
db/                   connection factory, checksummed migration runner, SQL migrations, pragmas
```

Key design points:

- `lib/domain/*` is pure: no database, no network, no clock. Deterministic inputs
  produce identical outputs, so every score, cohort evaluation, preflight and task
  contract can be re-derived and audited. Functions that need a timestamp take it
  as an injected parameter.
- `db/index.ts` is deliberately free of Next.js imports so tests, scripts and the
  running app exercise the same data layer. The app caches one connection on
  `globalThis` (`lib/db-context.ts`) so dev-mode reloads do not leak handles.
- The adapter registry fails closed: `resolveAdapter()` throws for unknown ids and
  the Google Forms adapter refuses to construct without an explicit capability
  config, because guessing capabilities would assume an authorized submission path.

## UI sections

The navigation (`components/site-nav.tsx`) declares nine sections. The table shows
what actually renders from `app/**/page.tsx` at the observation timestamp below.
Anything without a page file is pending work, not a feature.

| Section | Nav hint (from the code) | Status |
| --- | --- | --- |
| Overview (`/`) | Studies, data-quality signals and pending work | Page implemented; reads studies, participants, provenance coverage, session coverage, task queue, audit integrity, retention. |
| Studies (`/studies`, `/studies/[id]`) | Protocols, eligibility criteria, timepoints | Pages implemented (create/update studies, protocols, criteria, enrolment). |
| Participants (`/participants`, `/new`, `/[id]`, `/sessions/[id]`) | Registry, evidence, consent, response history | Pages implemented. The import screen (`/participants/import`) is linked from the Overview page but has no page file yet. |
| Psychological Library (`/library`, `/[id]`, `/versions/[id]`) | Instruments, versions, scales, scoring rules | Pages implemented (instrument, version, items, scales, algorithms). |
| Cohorts (`/cohorts`) | Rule builder, eligibility explanations, snapshots | Page implemented. |
| Forms & Mappings (`/forms`) | Form versions, field mapping, preflight | Page implemented (form versions, field mapping, preflight). |
| Agents & Tasks (`/agents`) | Registration, approvals, runs, retries | Page implemented. |
| Audit & Exports (`/audit`) | Provenance, retention, export jobs | NOT IMPLEMENTED as a page. Audit service, export job bookkeeping and retention assessment are complete. |
| Settings (`/settings`) | Roles, integrations, security configuration | NOT IMPLEMENTED as a page. Roles, permissions and access grants exist in the data layer. |

## Status: verified, partial, not implemented

Observation timestamp for every claim in this section: **2026-10-10 15:51 +05:00
(Asia/Tashkent)**, Node v24.21.0, pnpm 11.7.0, Windows. The application source was
under active construction by other workstreams while this file was written: pages,
lint findings and test counts changed several times during the session, and an
end-to-end integration suite added near the end of the session fails against the
current code (see the observed results below). Re-run the commands at the end of
this section rather than trusting a stale snapshot.

VERIFIED (code on disk, exercised by a command that was actually run):

| Area | Evidence |
| --- | --- |
| Schema and migrations | 3 migration files (`0001_core.sql` 42 tables, `0002_integrity_triggers.sql` 9 triggers, `0003_search_index.sql` FTS5 + 2 triggers); `tests/integration/migrations.test.ts` passes: it asserts that every required table exists, that re-running migrations is a no-op, that checksum drift is detected, and that the append-only triggers reject UPDATE and DELETE. |
| Pure domain layer | `lib/domain/cohort.ts`, `scoring.ts`, `mapping.ts`, `task-flow.ts`, `guards.ts`, `adapters/*`; covered by `tests/unit/*.test.ts`. |
| Import pipeline | `lib/import/parse-tabular.ts` (CSV/XLSX, ZIP/deflate, Excel date handling), `lib/import/plan.ts` (column inference, per-row issues, blockers/warnings), `lib/services/import-commit.ts`; covered by `tests/unit/parse-tabular.test.ts`. |
| Authentication and RBAC | scrypt password hashing (`lib/services/password.ts`), server-side sessions with hashed tokens, roles and permissions (`lib/services/authz.ts`), access grants; login page and first-run guidance implemented. |
| Audit, provenance and retention reporting | `lib/services/audit.ts` (redaction of sensitive keys, append-only check), `lib/repo/sources.ts` `provenanceCoverage()`, `lib/repo/exports.ts` `assessRetention()` (reports, never executes). |
| Task machine and adapters | `lib/domain/task-flow.ts` transitions, idempotency, contract validation; `local-deterministic` and `google-forms` adapters that refuse external submission. |
| Production build | `next build` exits 0. The most recent successful build emitted 14 routes: `/`, `/_not-found`, `/api/health`, `/cohorts`, `/library`, `/library/[id]`, `/library/versions/[id]`, `/login`, `/participants`, `/participants/[id]`, `/participants/new`, `/participants/sessions/[id]`, `/studies`, `/studies/[id]`. The `/forms` and `/agents` pages were added after that build. |

PARTIAL (works, with a stated gap):

| Area | Gap |
| --- | --- |
| Lint | 8 ESLint errors: unused bindings in `app/cohorts/page.tsx:22`, `app/library/page.tsx:19`, `lib/services/orchestration.ts:38` and `:366`, `tests/integration/pipeline.test.ts:56`; unnecessary regex escapes in `lib/import/plan.ts:48` and `:425` (two). |
| Integration test suite | `tests/integration/pipeline.test.ts` (11 tests) fails against the current code: inserting answers aborts with `SQLITE_CONSTRAINT_CHECK: missing_reason IS NULL OR missing_reason IN (...)`, i.e. a `missing_reason` value outside the documented list is being supplied. The database constraint is doing its job; the caller must use one of the seven documented reasons. |
| UI coverage | 7 of the 9 declared sections render; `/audit` and `/settings` have no page file yet. |
| Export | Job lifecycle, approval, checksum recording and retention assessment exist; no export content generator writes a file. |
| Retention | Records are assessed and reported; anonymisation and deletion are not implemented. |
| Google Forms | Capability facts are stored per form (`api_can_read_structure`, `api_can_read_responses`, `api_can_submit_responses`, evidence note); no OAuth client, HTTP client or response reader exists. |
| Server-only guard | `db/index.ts` states that server-only enforcement happens in `lib/services/guard.ts`; that file is not on disk and the declared `server-only` package is not imported anywhere. Treat the comment as a statement of intent. |
| pnpm scripts | In this environment `pnpm run <script>` aborts in pnpm's dependency check (`ERR_PNPM_IGNORED_BUILDS` for `better-sqlite3@13.0.3`). The underlying `node` commands work; see [docs/SETUP.md](docs/SETUP.md). |
| Import UI | `/participants/import` is linked from the Overview page but has no page file; the plan/commit layer behind it is implemented. |

NOT IMPLEMENTED (no code, or deliberately disabled):

| Area | Why it is absent |
| --- | --- |
| External form submission | The platform has no verified Google Forms response-submission API path, so `PLATFORM_SUBMISSION_PATH_VERIFIED` is false, `submissionAllowedByPlatform` is always false, and both adapters refuse rather than claim success. |
| Google Forms API integration | No HTTP calls, no OAuth, no response reading. Capability flags are recorded facts only. |
| Export file generation | No dataset builder; nothing selects research rows into an export payload. |
| Retention execution | Anonymisation and deletion require an audited human step that does not exist yet. |
| REST API for research data | The only HTTP endpoint is `GET /api/health`, which exposes migration state and an integrity check, never research data. |
| Password reset, e-mail, 2FA | No mail or identity-provider code; accounts are created by the bootstrap CLI or administrators. |
| Seed or demo data | `bootstrap` creates an organization, one administrator and retention defaults only, and states that no participants or responses were created. |
| Automated backup and multi-organization isolation | No backup tooling; tenancy relies on organization foreign keys plus the authorization layer. |

Verification commands (all run with the direct `node` binaries because of the
`pnpm run` issue above):

```bash
node --experimental-strip-types --test tests/unit/*.test.ts tests/integration/*.test.ts
node ./node_modules/typescript/bin/tsc --noEmit
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/next/dist/bin/next build
node --experimental-strip-types --test tests/http/smoke.test.ts   # requires a build
```

Observed results at the timestamp above:

| Command | Result |
| --- | --- |
| Unit + integration tests | 165 tests, 154 pass, 11 fail (exit 1). All 11 failures are in `tests/integration/pipeline.test.ts` and abort with `SQLITE_CONSTRAINT_CHECK` on `missing_reason`; every other suite passes. |
| Typecheck | exit 0, no diagnostics. |
| Lint | 8 errors, 0 warnings (exit 1); files listed above. |
| Production build | exit 0, 14 routes (the `/forms` and `/agents` pages were added after this build). |
| HTTP smoke suite | 9 tests, 8 pass, 1 fail: `/forms -> 404` against the build from 15:48, which predates the `/forms` page. Re-run after a rebuild. |

## Local setup

Requirements: Node.js >= 22 and pnpm. See [docs/SETUP.md](docs/SETUP.md) for the
full operational guide, including environment variables, database reset and
checksum drift.

```bash
pnpm install

# Apply the schema (creates data/respondent-platform.db on first run)
npm run db:migrate

# Create the first administrator and the retention defaults
npm run bootstrap -- --org "Example Research Lab" --email "pi@example.org" --password "<at least 10 characters>"

# Start the development server on http://localhost:4310
npm run dev
```

The application never creates its own first user: `/login` tells you to run the
bootstrap command when no organization or user exists. Bootstrap creates no
participants, responses or scores - those only arrive through documented sources.

Useful commands:

```bash
npm run db:status      # migration status; exits 1 on checksum drift
npm test               # unit + integration suites
npm run test:http      # HTTP smoke suite (needs a build first)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .
npm run build          # production build
npm run verify         # lint, typecheck, test, build (currently stops at lint)
```

## Google Forms capability limitation

Documented in `lib/repo/forms.ts` (`GOOGLE_FORMS_CAPABILITY_NOTE`) and enforced in
`lib/domain/adapters/google-forms.ts`:

- The Google Forms API can **read form structure**.
- With the responses scope it can **read submitted responses** of a form the
  caller owns.
- It does **not** expose a supported endpoint for **creating a response on behalf
  of a respondent**.

Therefore the platform never claims programmatic submission:

- `external_form.api_can_submit_responses` defaults to 0, with
  `capability_evidence` recorded next to it.
- `PLATFORM_SUBMISSION_PATH_VERIFIED` is `false`; `buildPreflight()` always reports
  `submissionAllowedByPlatform: false` with an explicit blocking reason and
  `auditNotes` explaining the missing path, while still producing a dry-run
  payload for researcher review.
- `permissions.maySubmitExternalResponse` on a task contract is derived from that
  preflight decision, so it is false in practice.
- The Google Forms adapter returns `needs_review` with `blockedByPolicy: true`
  when submission is attempted without a documented capability, credentials, or an
  injected authorized transport; it never performs a network call itself.
- The local deterministic adapter produces `externalReceipt.channel = "none"` and
  refuses `submit_external_response` and `verify_submission` outright.

External submission stays disabled until an authorized, evidenced path is
configured and recorded.

## Troubleshooting

The full list is in [docs/SETUP.md](docs/SETUP.md). The most common issues:

| Symptom | Action |
| --- | --- |
| `ERR_PNPM_IGNORED_BUILDS` / `better-sqlite3` fails to load | Run `pnpm approve-builds` (select `better-sqlite3`), re-run `pnpm install`, then `node -e "require('better-sqlite3')"`. |
| `pnpm run <script>` aborts before running the script | pnpm's dependency pre-check performs an install. Fix the ignored-builds issue, or run the binary directly: `node ./node_modules/typescript/bin/tsc --noEmit`, `node --experimental-strip-types --test ...`, `node ./node_modules/next/dist/bin/next build`. |
| Login says no organization exists | Run the bootstrap command above; the app does not self-provision. |
| `EADDRINUSE ... 4310` | Another instance is running; stop it or use `npx next dev --port 4311`. |
| `SQLITE_BUSY: database is locked` | One writer at a time; close other writers or servers. WAL with `busy_timeout = 5000` handles short contention only. |
| `next start` exits immediately | Build first: `npm run build` (`.next/BUILD_ID` must exist). |
| `db:status` exits 1 | Checksum drift or pending migrations; see the drift procedure in [docs/SETUP.md](docs/SETUP.md). |
| Lint fails | 8 pre-existing errors listed in the status table; `npm run verify` stops at lint until they are fixed by the owning workstream. |
| `SQLITE_CONSTRAINT_CHECK: missing_reason ...` | A code path is writing a `missing_reason` outside the seven documented values (`not_answered`, `skipped_by_branching`, `refused`, `illegible`, `not_administered`, `out_of_range_rejected`, `item_removed_in_version`). Use a documented reason; never invent a new one. |

## Documentation

| Document | Contents |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | Prerequisites, environment variables, database location, migration workflow, bootstrap, quality gates, database reset, checksum drift, troubleshooting. |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | All tables grouped by area, the seven schema invariants, the trigger that enforces each rule, and known schema-level gaps. |
| [docs/RESEARCH_INTEGRITY.md](docs/RESEARCH_INTEGRITY.md) | What the platform refuses to do and why, how missing data is represented, consent gating, instrument freezes, restricted item wording, agent execution integrity, honest limitations, verification log. |
| [.env.example](.env.example) | Every environment variable the code reads, with comments and no secret values. |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | CI: Node 22, frozen-lockfile install, native binding check, lint, typecheck, tests, production build. |

## Repository layout

```
app/                  routes, pages and server actions (actions/auth, studies, participants, library, cohorts, forms)
components/           SiteNav, panels/metrics/chips, form and action-form helpers
db/                   migrations (0001 core, 0002 triggers, 0003 FTS), pragmas.sql, connection factory and migration runner
lib/domain/           pure rules: types.ts (frozen contract), cohort.ts, scoring.ts, mapping.ts, task-flow.ts, guards.ts, adapters/
lib/import/           tabular parsing and import planning
lib/repo/             SQL repositories per area
lib/services/         use cases: session, authz, audit, cohorts, orchestration, import-commit, bootstrap, password
lib/util/             ids, hashing, canonical JSON, CSV helpers
scripts/              migrate.ts (db:migrate / db:status), bootstrap.ts
tests/                unit/, integration/, http/ and helpers/
docs/                 SETUP.md, DATA_MODEL.md, RESEARCH_INTEGRITY.md
```


### GitHub status correction (2026-10-10)

This app is tracked in `speway/research-respondent-platform`; PR #1 is merged and Issue #2 is closed. Historical verification counts and missing-route notes above predate current GitHub work. Issue #3 continuation source `06c608321c4a9f6c4cc557a213fdca3fb2f627f5` passes 173 unit/integration tests and 11 production HTTP checks; audit/settings routes exist. Current instructions, checked commits, permission boundaries and Vercel/persistence blockers are in `docs/WORK_CONTINUATION.md`. Preview authorization does not authorize production deployment or external form submission.

Issue #4 infrastructure Preview source `807f82dd09039f1edf5cb288a83263cbef8db99b` passes 175 tests, 15 HTTP checks and GitHub CI. Protected Preview: https://research-respondent-platform-hf3skhgcq-spw1.vercel.app (READY). Application sign-in and research data entry are disabled there; Vercel's service-level access protection remains enabled. Durable hosting is pending official storage integration access (HTTP 403). See `docs/PERSISTENCE_PLAN.md`; this is not a completed research workspace or an approved production release.

Usable first-trial workbench (PR #9): https://research-respondent-platform-lro81x47q-spw1.vercel.app/workbench . Source `cfe539dc6224399f1496c71cac9333996a974c13` passes 181 tests, 16 HTTP checks, all CI steps and a real browser workflow. Import CSV/TSV/JSON, filter/classify, map questions, download an agent packet and save/restore the project. The workbench processes files in tab memory without application sign-in or server uploads; Vercel protection remains enabled. It does not send Google Forms responses or provide cloud persistence. Operator guide: `docs/BROWSER_WORKBENCH.md`.
