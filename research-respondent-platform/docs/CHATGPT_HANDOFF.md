# ChatGPT Project Handoff: Research Respondent Platform

> **Status: IMPLEMENTATION REPORT — evidence-backed snapshot.** Every claim below was produced by a command executed on this machine on 2026-10-10 (UTC), or by reading the named file. Anything that could not be verified is marked `[NOT VERIFIED]` / `[UNKNOWN]`. This file is append-only in its activity log (section 9): never delete an entry, correct errors with a new dated entry.

**Last updated (ISO 8601):** `2026-10-10T10:50Z`
**Last updating agent:** `DeepSeek (DSH teammate "cohort-engineer"; verification + documentation pass)`
**Original project context:** `RESEARCH_RESPONDENT_PLATFORM_HANDOFF.md` — `[NOT VERIFIED: no *.md file exists anywhere in this repository or its parent workspace]`
**Primary instructions:** `DEEPSEEK_CONTINUATION_PROMPT.md` — `[NOT VERIFIED: file not present in this workspace]`

## 1. Executive snapshot

- **Project goal:** A secure web application for organizing consenting real research participants, preserving their documented psychological assessment responses, deriving valid versioned scores, configuring research cohorts, mapping existing responses to approved forms, and orchestrating auditable authorized agent tasks.
- **Current overall status:** `IN PROGRESS` — the pure domain engines (scoring, cohort, mapping/preflight, task flow/adapters, guards) are implemented and covered by passing tests; the persistence, UI and deployment layers are partly implemented. **Snapshot volatility warning:** `app/` and `tests/` changed several times during this 7-minute verification window, so the numbers below are timestamped point-in-time results, not a stable baseline.
- **Most recent verified achievement:** `2026-10-10T10:47Z` — all six domain suites plus the migrations integration suite reported **153 tests / 153 pass / 0 fail**, and `tsc --noEmit` reported **0 errors**. Earlier the same day the migration CLI applied `0001_core`, `0002_integrity_triggers`, `0003_search_index` to a fresh file database with **0 pending, 0 checksum drift**.
- **Latest snapshot (2026-10-10T10:49Z, same command):** **165 tests / 154 pass / 11 fail** — a new end-to-end suite `tests/integration/pipeline.test.ts` (12 tests, 1 pass / 11 fail) and `tests/http/smoke.test.ts` (9 tests, 8 pass / 1 fail) appeared during this pass; both are owned by other agents and were still changing while being measured.
- **Main blocker:** No Git repository exists (`git status` → `fatal: not a git repository`, exit 128), so there is no commit SHA, no GitHub remote and no CI workflow; GitHub and Vercel authorization are unverified in this session; no production build artifact exists (`.next/BUILD_ID` absent); and the newly added end-to-end/HTTP suites are not yet green.
- **Next action:** Fix the verified `db:status` crash on an unmigrated database (section 7, defect D1), then clear the 6 ESLint errors, then stabilise the end-to-end suite, finish the HTTP smoke suite, and add the 3 navigation targets that have no page.

## 2. Project location and source-control status

| Item | Verified value | Evidence or notes |
|---|---|---|
| Local project root | `C:\Users\spw666\Documents\deepseek-harness\default-workspace\research-respondent-platform` | `pwsh` working directory for every command in section 7 |
| GitHub repository URL | `[NOT CONNECTED / UNKNOWN]` | No `.git` directory; `git -C . status --short --branch` → `fatal: not a git repository (or any of the parent directories): .git`, exit code 128 |
| Repo visibility | `[UNKNOWN]` | Prefer private until owner approves otherwise |
| Default branch | `[UNKNOWN]` | Not determinable without Git |
| Working branch | `[UNKNOWN]` | Same |
| Last checked commit SHA | `[UNKNOWN]` | `git rev-parse HEAD` → exit 128 |
| Last pushed commit SHA | `[UNKNOWN]` | No remote configured |
| Last merged PR / link | `[NONE VERIFIED]` | |
| Uncommitted work / conflicts | `ALL WORK IS UNCOMMITTED` | There is no repository, so the entire tree (app/, lib/, db/, tests/, docs/) is uncommitted by definition |
| GitHub authorization | `[NOT VERIFIED]` | No GitHub connection exists in this session; do not assume another agent's authorization transfers |

**Related-but-not-assumed repos:** An Obsidian vault or another psychology project is not automatically this web application's repository. Verify the owner-approved destination (open question Q1).

## 3. Deployment and infrastructure

| Item | Verified value | Evidence or notes |
|---|---|---|
| Vercel authorization | `[NOT VERIFIED]` | No Vercel connection in this session; no `vercel.json`, no `.vercel` directory (`Test-Path` → False, both) |
| Vercel team/account | `[UNKNOWN]` | |
| Vercel project | `[UNKNOWN]` | |
| Preview deployment URL | `[NONE VERIFIED]` | |
| Production URL | `[NONE VERIFIED]` | |
| Deployment SHA | `[UNKNOWN]` | No Git repository exists |
| Deployment state | `NOT VERIFIED` | Never label live without opening and testing the URL |
| Database provider | Local SQLite file via `better-sqlite3` 13.0.3 | `db/index.ts:31-37`; path = `DATABASE_FILE` ?? `DATABASE_PATH` ?? `<repo>/data/respondent-platform.db`. No hosted/managed database is referenced anywhere |
| Schema/migration state | 3 migrations, all applied to a throwaway file DB | `db/migrations/0001_core.sql`, `0002_integrity_triggers.sql`, `0003_search_index.sql`; CLI run 2026-10-10T10:45:29Z → `3 migration(s), 0 pending, 0 with checksum drift`. The repository's own `data/` directory does not exist yet (`Test-Path data` → False) |
| Authentication provider | Self-hosted cookie session, no external IdP | `lib/services/session.ts` (`SESSION_COOKIE = "rrp_session"`), `lib/services/password.ts` (Node `scrypt`, N=16384 r=8 p=1 keylen=64, minimum 10-character password) |
| Secret variable NAMES only | `DATABASE_FILE`, `DATABASE_PATH`, `NODE_ENV`, `GOOGLE_FORMS_SERVICE_ACCOUNT_JSON` (reference name only) | `db/index.ts:32`, `scripts/migrate.ts:10`, `app/actions/auth.ts:34`, `lib/domain/adapters/google-forms.ts:59`. **No secret values exist or were read in this session; never record values here** |
| Monitoring/rollback plan | `[UNKNOWN]` | No monitoring, alerting or rollback configuration found |

### Deployment verification log

| Time (UTC) | Environment | Commit SHA | Build result | Runtime smoke test | URL / proof |
|---|---|---|---|---|---|
| `2026-10-10T10:46Z` | local (no deployment) | `[UNKNOWN — no Git repo]` | `NOT RUN` (deliberate: the lead is actively editing `app/`, so a build failure would be uninformative; `.next/BUILD_ID` is absent, so no build artifact exists to serve) | `NOT RUN` | `docs/CHATGPT_HANDOFF.md` section 7 |

## 4. Architecture and code map

**Stack confirmed from code and lockfiles:** Next.js 16.4.0 (App Router) + React 19.3.0 + TypeScript 5.9.3 (`strict`, `noUncheckedIndexedAccess`) on Node `>=22` (verified runtime **v24.21.0**, pnpm **11.7.0**); `better-sqlite3` 13.0.3 (declared in `next.config.ts` `serverExternalPackages`); `zod` 4.6.5 used **only** in `app/actions/*.ts`; Tailwind 4.3.3 via `@tailwindcss/postcss`; ESLint 9.39.5 with `typescript-eslint`; `server-only` 0.0.1. Tests run on the Node built-in runner with `--experimental-strip-types` (no Jest/Vitest).

**Application architecture:** Server-rendered App Router pages and server actions only; no client data fetching layer, no background worker, no queue.
`app/` (pages + `app/actions/*` server actions + `app/api/health/route.ts`) → `lib/services/*` (session, authz, audit, cohorts, orchestration, import-commit, bootstrap, password) → `lib/repo/*` (SQL over the single SQLite connection from `lib/db-context.ts`) → `db/index.ts` (connection, pragmas, migrations).
`lib/domain/*` is framework-free, I/O-free decision logic (`types.ts` frozen contracts, `cohort.ts`, `guards.ts`, `scoring.ts`, `mapping.ts`, `task-flow.ts`, `adapters/*`); `lib/import/*` parses CSV/TSV/XLSX bytes into a reviewable import plan.
Agent tasks never execute directly in a page: `lib/services/orchestration.ts` builds/validates a task contract, the repo persists it, and an adapter from `lib/domain/adapters/index.ts` (`local-deterministic`, `google-forms`) produces evidence. The Google Forms transport must be injected; the module itself performs no network call.

**Key files/directories:**

| Path | Role | Status |
|---|---|---|
| `lib/domain/types.ts` | Frozen framework-free contracts for every module | verified (typechecks; imported by all domain modules) |
| `lib/domain/scoring.ts` | Versioned psychometric scoring, 4 missing-data policies, band/percentile lookup | verified — 36 tests pass |
| `lib/domain/cohort.ts` | Cohort rule evaluation, `indeterminate` semantics, preview counts, rule validation/parsing | verified — 31 tests pass |
| `lib/domain/guards.ts` | Dependency-free runtime input guards (dates, numbers, enums) | verified — 12 tests pass |
| `lib/domain/mapping.ts` | Field-mapping validation, dry-run preflight, version drift, mapping suggestions | verified — 28 tests pass |
| `lib/domain/task-flow.ts` + `lib/domain/adapters/*` | Task state machine, contract validation, idempotency, adapter registry | verified — 32 tests pass |
| `lib/import/parse-tabular.ts` | CSV/TSV/XLSX/ZIP parsing, Excel serial dates | verified — 8 tests pass |
| `lib/import/plan.ts`, `lib/services/import-commit.ts` | Import plan building and commit path | `[NOT VERIFIED]` — no test imports these modules |
| `lib/repo/*.ts` (10 modules) | SQLite persistence for org, studies, participants, sources, assessments, cohorts, forms, tasks, exports | `[NOT VERIFIED]` — no test imports the repo layer |
| `lib/services/*.ts` (9 modules) | Session/authz/audit/cohort/orchestration/bootstrap/password/import-commit services | `partially verified` — only `bootstrap.ts` and `studies.ts` are imported by the HTTP smoke suite (in progress) |
| `app/` (23 files, 13 pages + 1 route handler) | Server-rendered UI and server actions | `partial` — `app/` itself typechecked cleanly at 10:47Z; the 3 TS errors at 10:49Z are in test files, not in `app/`. No page has been proven to render by a passing test yet |
| `tests/integration/pipeline.test.ts` | New end-to-end suite (study → participant → scoring → cohort → preflight → task orchestration → audit) | `[NOT VERIFIED]` — 1 pass / 11 fail when first observed at 2026-10-10T10:49Z; owner and intent are outside this pass |
| `tests/http/smoke.test.ts`, `tests/helpers/server.ts` | Production-server smoke suite over a throwaway SQLite file | `IN PROGRESS` — 8 pass / 1 fail at 2026-10-10T10:49Z; requires a build artifact that does not exist yet |
| `db/migrations/0001_core.sql` | 42 `CREATE TABLE` statements | verified — migration test + CLI apply |
| `db/migrations/0002_integrity_triggers.sql` | 9 append-only/frozen-row triggers | verified — `observed_answer`, `derived_score`, `audit_event` immutability asserted by tests |
| `db/migrations/0003_search_index.sql` | FTS5 `participant_search` table + sync triggers | verified (applies cleanly); search behaviour `[NOT VERIFIED]` |
| `scripts/migrate.ts`, `scripts/bootstrap.ts` | Migration CLI and first-organization CLI | verified — migrate applied 3/3 to a fresh file DB; bootstrap invoked by the in-progress HTTP suite |

**Database tables and important invariants:** `0001_core.sql` creates **42 tables**: organization, app_user, role_assignment, access_grant, auth_session, study, study_protocol_version, recruitment_criterion, study_participant, participant, participant_private_identity, consent_record, documented_source, evidence_link, instrument, instrument_version, item_definition, scale_definition, score_algorithm, assessment_session, observed_answer, derived_score, interpretation_annotation, segment, segment_rule, segment_snapshot, eligibility_decision, external_form, external_form_version, external_form_field, field_mapping, mapping_validation, agent, agent_capability, agent_task, task_attempt, execution_evidence, audit_event, export_job, retention_policy, system_setting, schema_migration.
Invariants verified by `tests/integration/migrations.test.ts` (6/6 pass): migrations apply cleanly and are idempotent; checksum drift is detected; `observed_answer` rows cannot be updated or deleted; `audit_event` is append-only; `derived_score` cannot be rewritten (superseding is allowed); `participant_private_identity` requires a non-empty `lawful_basis`. Additional triggers exist (not individually asserted): `trg_documented_source_required_for_answers`, `trg_instrument_version_frozen_items`, participant FTS sync.

**Integration contracts:** Google Forms — `PLATFORM_SUBMISSION_PATH_VERIFIED = false` (`lib/domain/mapping.ts:45`); the Google adapter refuses to submit without `api_can_submit_responses` **and** an injected transport (`lib/domain/adapters/google-forms.ts`), uses only the secret *reference* `GOOGLE_FORMS_SERVICE_ACCOUNT_JSON`, and redacts credential-shaped text from errors. No live Google Forms connection exists or was tested. Agent adapters — `ADAPTER_REGISTRY` / `resolveAdapter` fail closed on unknown or unconfigured adapters. Auth — cookie session `rrp_session`, scrypt password hashes. There is no message queue, cron, webhook receiver or external cache.

## 5. Feature implementation matrix

Status vocabulary: `DONE (verified)` = the code was read **and** a test executed in this session exercises the behaviour; `IN PROGRESS` = code exists but the behaviour is not covered by a test that was run; `NOT VERIFIED` = no evidence.

| Feature | Status | Files | Evidence / known gaps |
|---|---|---|---|
| Navigation and layout | IN PROGRESS | `app/layout.tsx`, `components/site-nav.tsx`, `components/ui.tsx`, 13 `page.tsx` files | Layout + nav + shared UI primitives exist and typecheck. `components/site-nav.tsx` advertises 9 destinations; as of 10:49Z `/agents`, `/audit` and `/settings` still have no `page.tsx` (verified with `Get-ChildItem -Recurse app -Filter page.tsx`), so they currently 404 (`/cohorts` and `/forms` were added during this pass). No render-level test has passed |
| Login, roles and permissions | IN PROGRESS | `app/login/page.tsx`, `app/actions/auth.ts`, `components/login-form.tsx`, `lib/services/session.ts`, `lib/services/authz.ts`, `lib/services/password.ts`, `lib/repo/org.ts` | Six roles (`principal_investigator`, `researcher`, `data_steward`, `reviewer`, `agent_operator`, `viewer`) with a `PERMISSIONS` map, `authorize`/`assertAuthorized`, `requireActiveConsent`, scrypt hashing, cookie sessions. No unit test imports these modules; the HTTP login test belongs to the in-progress smoke suite (7/9 passing when observed, 2 failing) |
| Studies and protocol versions | IN PROGRESS | `lib/repo/studies.ts`, `app/studies/page.tsx`, `app/studies/[id]/page.tsx`, `app/actions/studies.ts` | Study/protocol/criterion/enrolment functions and the `study`, `study_protocol_version`, `recruitment_criterion`, `study_participant` tables exist. No test exercises the repo layer |
| Consenting real-participant registry | IN PROGRESS | `lib/repo/participants.ts`, `lib/repo/sources.ts`, `app/participants/**`, `app/actions/participants.ts` | Schema-level guarantees verified by 6 migration tests (`participant`, `consent_record`, identity requires `lawful_basis`, observed answers immutable). Pseudonym generation, consent recording and the registry UI have no test |
| Evidence/source provenance | IN PROGRESS | `lib/repo/sources.ts`, `db/migrations/0001_core.sql`, `db/migrations/0002_integrity_triggers.sql` | `documented_source`, `evidence_link`, checksum helpers, `provenanceCoverage`, and the trigger `assessment_session requires an existing documented_source` exist. `provenanceCoverage` itself is untested |
| Assessment item import and versioning | IN PROGRESS | `lib/import/parse-tabular.ts` (verified), `lib/import/plan.ts`, `lib/services/import-commit.ts`, `lib/repo/assessments.ts` | Tabular parsing verified by 8 tests (quoted CSV, embedded newlines, delimiter sniffing, XLSX shared/inline strings, date serials, ZIP, out-of-range serial rejection). Plan building, commit, and instrument/version/scale persistence are untested |
| Psychometric scoring | DONE (verified) | `lib/domain/scoring.ts`, `tests/unit/scoring.test.ts` | 36/36 tests pass on 2026-10-10: reverse-keyed sums, weighted sums, mean, subscale chains, linear transform, z-score, percentile table, band lookup, all four missing-data policies, out-of-range treated as missing, open-text exclusion, provisional flagging, clinical-band guard, reproducibility, purity. Gap: persistence via `lib/repo/assessments.ts:scoreAndPersistSession` is untested |
| Cohort filters and eligibility explanations | DONE (verified) | `lib/domain/cohort.ts`, `tests/unit/cohort.test.ts` | 31/31 tests pass: include/exclude/indeterminate/not-applicable semantics, `missingBehaviour`, consent/study status, numeric bounds, score rules with `not_computable`, missingness thresholds, counts and summaries, deterministic purity, and an explicit test that unknown data is never counted as included. Gap: `lib/services/cohorts.ts` and `lib/repo/cohorts.ts` persistence/UI are untested |
| Form schema import and field mapping | IN PROGRESS | `lib/domain/mapping.ts` (verified), `lib/repo/forms.ts` (untested), `app/actions/library.ts` | Mapping engine verified by 28 tests (option/type/range checks, drift detection, deterministic suggestions). External form version capture (`captureFormVersion`, `external_form*` tables) has no test |
| Dry-run and preflight validation | DONE (verified) | `lib/domain/mapping.ts`, `tests/unit/mapping.test.ts` | 28/28 tests pass, including: withdrawn consent blocks submission and assembles no payload; without a verifiable platform submission path the payload stays a dry run; every payload key carries provenance; a documented-missing source never receives a value; `generatedAt` is injected and repeated runs are identical. `PreflightReport.dryRun` is always `true` |
| Multi-agent task orchestration | DONE (verified) | `lib/domain/task-flow.ts`, `lib/domain/adapters/*`, `tests/unit/task-flow.test.ts` | 32/32 tests pass: full transition table, approval gating, attempt budget, expiry, canonical contract hashing, idempotency-key stability/sensitivity, forbidden-contract rejections, exponential backoff cap, deterministic local adapter, Google adapter refusal paths, adapter registry fail-closed, and no wall clock / no network inside domain modules. Gap: `lib/services/orchestration.ts` and `lib/repo/tasks.ts` are untested |
| Submission authorization and auditing | IN PROGRESS | `lib/domain/adapters/*`, `lib/services/audit.ts`, `lib/services/authz.ts`, `db/migrations/0002_integrity_triggers.sql` | Verified: adapters never claim an external submission (`externalReceipt.channel: "none"`, `blockedByPolicy` for `submit_external_response`), Google adapter refuses without capability + transport + credentials. Unverified: the audit service (`recordAudit`, `listAuditEvents`, `auditIntegrityReport`) has no test; only the `audit_event` append-only trigger is covered (migration test) |
| Audit log and exports | IN PROGRESS | `lib/services/audit.ts`, `lib/repo/exports.ts`, `tests/integration/migrations.test.ts` | `audit_event` append-only is verified (migration test 6/6). Export jobs, retention assessment and CSV rendering (`requestExport`, `approveExport`, `assessRetention`, `toExportCsv`) are untested and no export has been produced |
| CI and automated tests | IN PROGRESS | `package.json` scripts, `tests/**`, `eslint.config.mjs` | At 10:47Z: 153/153 pass (6 domain suites + migrations) and `tsc --noEmit` 0 errors. At 10:49Z, after new suites appeared: **165 tests / 154 pass / 11 fail** (`tests/integration/pipeline.test.ts` 1/12 and `tests/http/smoke.test.ts` 8/9 account for all 11 failures) and `tsc --noEmit` 3 errors, all inside those two in-progress test files. Lint fails with 6 errors. CI is `NOT VERIFIED`: there is no `.github` directory (`Test-Path .github` → False), so no workflow file exists and nothing has ever run in CI. `pnpm lint` additionally fails in this runtime (section 7, defect D2) |
| GitHub publication | NOT VERIFIED | — | `git status` exit 128: not a repository. No remote, no SHA, nothing pushed |
| Vercel preview deployment | NOT VERIFIED | — | No Vercel authorization in this session; no `vercel.json`/`.vercel`; no deployment URL exists |
| Security-reviewed production release | NOT VERIFIED | — | No security review, penetration test, dependency audit or production deployment has been performed. `[NONE EVALUATED]` for legal/licensing review |

## 6. Research integrity, privacy and authorization rules

- Real participants and observed answers must originate from verifiable data with appropriate informed consent and provenance. Do not invent participants or responses to populate a research dataset.
- Never infer missing questionnaire answers, rewrite observed values to obtain desired findings, or submit simulated data as real survey responses.
- Use clearly labeled isolated fixtures exclusively for local development and automated tests; keep them out of production research records, form submissions and reports of empirical results.
- Store instrument metadata, licensed scoring algorithms, item/version provenance, consent state, access decisions and audit events.
- Record known legal, licensing, security and privacy gaps here: `[NONE EVALUATED]` — no DPIA, no retention schedule review, no licensing review of any instrument, and no security review have been performed. `retention_policy` exists as a table only.
- Never paste secrets or raw personal data into this Markdown file, commits, logs, issue trackers or agent prompts.
- Any external form submissions must have verified permission, factual source answers, appropriate consent and auditable approval.

**How these rules are enforced in code today (verified):**
- Cohort eligibility: absent/unknown data can never satisfy a criterion — the default outcome is `indeterminate` with an observed/expected/why explanation, and a participant is never counted as included while an unresolved criterion remains (`tests/unit/cohort.test.ts`, 31 tests).
- Mapping/preflight: a source answer documented as missing never receives a value, placeholder or default; it becomes a blocking reason (required field) or is omitted with a warning (optional), and the payload is a dry run (`tests/unit/mapping.test.ts`, 28 tests).
- Scoring: no imputation; partial data is flagged provisional; a clinical scale without `clinicalUsePermitted` never yields a band (`tests/unit/scoring.test.ts`, 36 tests).
- Agent tasks: contracts are rejected when they contain identity keys (`full_name`, `contact_email`, `contact_phone`), credential-shaped keys, an e-mail-like pseudonym, or a submission permission without a callback; credential-shaped text is redacted from transport errors (`tests/unit/task-flow.test.ts`, 32 tests).
- Identity separation: `participant_private_identity` requires a lawful basis, and analytic participant attributes carry no names/e-mails/phones (`db/migrations/0001_core.sql`, migration test).

## 7. How to run and test the current code

**Prerequisites verified:** Node **v24.21.0** (satisfies `engines.node >=22`), pnpm **11.7.0**, `node_modules/` already installed with a working native `better-sqlite3` 13.0.3 (all 153 tests execute real SQLite). `[NOT VERIFIED]`: a clean `pnpm install` from scratch (not run — it was out of scope for this pass).

Working environment helper used for every command below:
```powershell
. "C:\Users\spw666\Documents\deepseek-harness\default-workspace\tools\dsh-env.ps1"   # provides nodejs + pnpm
```

```powershell
# Test suite (the acceptance command)
nodejs --experimental-strip-types --test tests/unit/*.test.ts tests/integration/*.test.ts

# Type check
nodejs ./node_modules/typescript/bin/tsc --noEmit

# Lint (direct binary: `pnpm lint` currently fails in this runtime, see D2)
nodejs ./node_modules/eslint/bin/eslint.js .

# Migrations against a throwaway database
$env:DATABASE_FILE = "$env:TEMP\respondent-handoff.db"
nodejs --experimental-strip-types scripts/migrate.ts            # apply
nodejs --experimental-strip-types scripts/migrate.ts --status   # inspect

# First organization + administrator (writes to DATABASE_FILE)
nodejs --experimental-strip-types scripts/bootstrap.ts --org "Lab name" --email you@example.org --password "<min 10 chars>"

# Dev server / production server (not run in this pass)
pnpm dev        # next dev --port 4310
pnpm build      # next build   (NOT RUN this pass)
pnpm start      # next start --port 4310
```

| Date (UTC) | Command / scenario | Result | Evidence / failing reason |
|---|---|---|---|
| 2026-10-10T10:43Z | `git -C . status --short --branch` / `log --oneline -5` / `rev-parse HEAD` | FAIL (exit 128) | `fatal: not a git repository (or any of the parent directories): .git` — no Git repository exists |
| 2026-10-10T10:44Z | `nodejs --version` | PASS | `v24.21.0` |
| 2026-10-10T10:44Z | `nodejs <pnpm.mjs> --version` | PASS | `11.7.0` |
| 2026-10-10T10:44Z | `nodejs --experimental-strip-types --test tests/unit/*.test.ts tests/integration/*.test.ts` | PASS | `# tests 153  # pass 153  # fail 0  # skipped 0` (per file: cohort 31, guards 12, mapping 28, parse-tabular 8, scoring 36, task-flow 32, migrations 6) |
| 2026-10-10T10:46Z | same command, re-run after the lint/migration checks | PASS | `# tests 153  # pass 153  # fail 0  # skipped 0` |
| 2026-10-10T10:44Z | `nodejs ./node_modules/typescript/bin/tsc --noEmit` | FAIL (10 errors) | All 10 errors were in `tests/helpers/server.ts` (the in-progress HTTP suite), none in `lib/` or `app/` |
| 2026-10-10T10:46Z | `nodejs ./node_modules/typescript/bin/tsc --noEmit` | FAIL (6 errors) | All 6 now in `app/library/[id]/page.tsx` (a file added while this pass was running): 5 × TS2307 wrong relative import depth (`../../../../lib/...`) and 1 × TS7006 implicit `any`. `tests/helpers/server.ts` errors were fixed by their owner in between. Point-in-time snapshot; `app/` is under active edit |
| 2026-10-10T10:45Z | `pnpm lint` | FAIL (exit 1) | pnpm performed an implicit dependency check and aborted: `Run "pnpm approve-builds" ... Command failed with exit code 1: ... pnpm install`. `pnpm run <script>` is therefore unreliable in this runtime; use the direct binaries — see D2 |
| 2026-10-10T10:45Z | `nodejs ./node_modules/eslint/bin/eslint.js .` | FAIL (6 errors) | `app/library/page.tsx:19` unused `actor`; `lib/import/plan.ts:48,425` `no-useless-escape`; `lib/services/orchestration.ts:38,366` unused vars |
| 2026-10-10T10:45Z | `DATABASE_FILE=<temp> nodejs --experimental-strip-types scripts/migrate.ts` | PASS | `applied 0001_core`, `applied 0002_integrity_triggers`, `applied 0003_search_index`, exit 0 |
| 2026-10-10T10:45Z | `DATABASE_FILE=<temp> nodejs --experimental-strip-types scripts/migrate.ts --status` | PASS | `3 migration(s), 0 pending, 0 with checksum drift`, exit 0, real timestamps recorded |
| 2026-10-10T10:45Z | `DATABASE_FILE=<new temp path> nodejs --experimental-strip-types scripts/migrate.ts --status` **before** any migration | FAIL (exit 1) | `SqliteError: no such table: schema_migration` at `db/index.ts:177` — see defect D1 |
| 2026-10-10T10:44Z | `nodejs --experimental-strip-types --test tests/http/smoke.test.ts` | FAIL (9 tests, 7 pass / 2 fail) | Suite owned by another teammate and still being written; a later invocation in the same window collected 0 tests while the file was mid-edit. Not part of the acceptance run |
| 2026-10-10T10:47Z | `nodejs ./node_modules/typescript/bin/tsc --noEmit` | PASS (0 errors) | Tree is type-clean: the 10 errors seen at 10:44Z (`tests/helpers/server.ts`) and the 6 seen at 10:46Z (`app/library/[id]/page.tsx`) were fixed by their owners while this pass was running |
| 2026-10-10T10:47Z | `nodejs --experimental-strip-types --test tests/unit/*.test.ts tests/integration/*.test.ts` | PASS | `# tests 153  # pass 153  # fail 0` (final re-run confirming the numbers above) |
| 2026-10-10T10:46Z | `pnpm build` / `next build` | NOT RUN | Deliberate: the lead is actively editing `app/`, so a build failure would be uninformative. `.next/BUILD_ID` is absent, so no production artifact exists |
| 2026-10-10T10:46Z | `Get-ChildItem -Recurse app -Filter page.tsx` / `route.ts` | PASS (informational) | At that moment: 8 pages + `app/api/health/route.ts`, with `/cohorts`, `/forms`, `/agents`, `/audit`, `/settings` advertised in the nav but absent |
| 2026-10-10T10:44Z | `Get-ChildItem -Recurse tests -Filter *.test.ts` | PASS (informational) | At that moment: 6 unit suites + 1 integration suite + the in-progress `tests/http/smoke.test.ts` |
| 2026-10-10T10:49Z | `nodejs --experimental-strip-types --test tests/unit/*.test.ts tests/integration/*.test.ts` | FAIL (165 tests, 154 pass / 11 fail) | A new suite `tests/integration/pipeline.test.ts` appeared during the pass; run separately it reports 1 pass / 11 fail. All 6 domain suites and the migrations suite stayed green |
| 2026-10-10T10:49Z | `nodejs --experimental-strip-types --test tests/http/smoke.test.ts` | FAIL (9 tests, 8 pass / 1 fail) | Improved from 7/2 to 8/1 during the pass; suite still under active edit by its owner and requires a build artifact that does not exist |
| 2026-10-10T10:49Z | `nodejs ./node_modules/typescript/bin/tsc --noEmit` | FAIL (3 errors) | All 3 in test files under active edit: `tests/http/smoke.test.ts:169` (`builtPageRoutes` undefined) and `tests/integration/pipeline.test.ts:493,890` (type mismatches). `app/` and `lib/` were clean |
| 2026-10-10T10:49Z | `Get-ChildItem -Recurse app -Filter page.tsx` / `route.ts` | PASS (informational) | 13 pages (`/cohorts` and `/forms` added during the pass) + `app/api/health/route.ts`; `app/` now holds 23 files. `/agents`, `/audit`, `/settings` remain advertised without a page |

**Open defects and reproduction steps:**
- **D1 (functional, verified):** `db:status` crashes on a database that has never been migrated. Reproduce: `$env:DATABASE_FILE="$env:TEMP\new.db"; nodejs --experimental-strip-types scripts/migrate.ts --status` → `SqliteError: no such table: schema_migration` (`db/index.ts:174-178` queries the table that only `runMigrations` creates). Expected: report `0 applied / 3 pending`, exit 0.
- **D2 (environment/tooling, verified):** `pnpm run <script>` aborts because pnpm's dependency status check runs `pnpm install`, which needs build-script approval (`pnpm approve-builds`) for the native `better-sqlite3`. Workaround used here: invoke the tools directly with `nodejs ./node_modules/<tool>/bin/...`.
- **D3 (lint, verified):** 6 ESLint errors (list above); `pnpm lint`/`eslint .` exits 1.
- **D4 (UI completeness, verified):** 3 of 9 navigation destinations have no page and will 404 (`/agents`, `/audit`, `/settings` as of 10:49Z, down from 5 at 10:46Z).
- **D5 (typecheck, RESOLVED, then re-opened by new test files):** 10 TS errors at 10:44Z (`tests/helpers/server.ts`) and 6 at 10:46Z (`app/library/[id]/page.tsx`) were fixed by their owners → `tsc --noEmit` exited 0 at 10:47Z. At 10:49Z, 3 new errors appeared in test files added during the pass (`tests/http/smoke.test.ts:169`, `tests/integration/pipeline.test.ts:493,890`). This tree changes during verification; always re-run the typecheck before trusting a number here.
- **D6 (project hygiene, verified):** no Git repository, no CI workflow, no `README.md`, no `docs/` beyond this file, no `.env.example`, no `data/` directory.
- **D7 (unverified runtime):** no page has been proven to render 200 by a passing test; the HTTP smoke suite that would prove it is in progress (8/9 at 10:49Z) and cannot pass until a production build exists.
- **D8 (end-to-end suite, observed 10:49Z):** `tests/integration/pipeline.test.ts` reports 1 pass / 11 fail (study/protocol creation, participant provenance, lawful basis, scoring supersession, out-of-range answers, cohort consent gating, preflight, orchestration approval, authorization denials, append-only live DB, enrolment/evidence links). The suite was created during this verification window and its owner is still editing it, so these failures are reported as observed, not as a diagnosis.

## 8. Decisions and constraints

| Date | Decision | Reason / supporting evidence | Revisit condition |
|---|---|---|---|
| 2026-10-10 | SQLite via `better-sqlite3` as the only datastore, path from `DATABASE_FILE`/`DATABASE_PATH` with a repository-local default | `db/index.ts:31-37`; keeps the app self-contained and testable in-memory | When multi-instance/serverless hosting is required (SQLite file is not shareable across Vercel lambdas) |
| 2026-10-10 | Domain logic lives in `lib/domain/*` as pure, clock-free, network-free modules | Verified by the passing test `domain modules contain no wall clock and no network call`; enables deterministic unit testing | If a domain rule needs I/O, it belongs in `lib/services` instead |
| 2026-10-10 | Tests run on the Node built-in runner with `--experimental-strip-types` (no Jest/Vitest) | `package.json` scripts; 153/153 pass on Node v24.21.0 | When the experimental flag is removed or a coverage reporter is required |
| 2026-10-10 | Missing/unknown data must never satisfy a criterion; default outcome `indeterminate` with observed/expected/why | Enforced and tested in `lib/domain/cohort.ts` (31 tests) and `lib/domain/mapping.ts` (28 tests) | Only with explicit owner approval of a different methodology |
| 2026-10-10 | No imputation in scoring; partial results are flagged provisional | `lib/domain/scoring.ts` (36 tests) | Never without a documented, approved psychometric justification |
| 2026-10-10 | External form submission stays dry-run only until a provider path is verified (`PLATFORM_SUBMISSION_PATH_VERIFIED = false`) | `lib/domain/mapping.ts:45`; adapters return `blockedByPolicy`/`needs_review` instead of success | When Google Forms submission capability is verified with real credentials and owner approval |
| 2026-10-10 | Identity data is separated from analytic data and requires a documented lawful basis | `db/migrations/0001_core.sql`, trigger `trg_private_identity_requires_basis`, migration test | Never weaken without legal review |
| 2026-10-10 | `zod` is used only at the server-action boundary; `lib/domain` stays dependency-free | `grep 'from "zod"'` matches only `app/actions/{participants,library,studies}.ts` | If domain validation should share the same schema source |

**Decisions requiring owner approval:** Git repository initialization and destination (a fresh private repo vs. an existing one), GitHub authorization, Vercel authorization and which project/team, preview vs. production deployment, whether any real participant data may be processed at all yet, Google Forms/OAuth credentials and data-processing scope, retention and DPIA requirements, and any paid infrastructure.

## 9. Activity log (append-only)

| Timestamp (UTC) | Agent | What changed | Paths / commit / deployment | Verified result |
|---|---|---|---|---|
| 2026-10-10T10:43Z | DeepSeek (cohort-engineer) | Verified source-control state | working tree, no `.git` | `git status/log/rev-parse` all exit 128, `fatal: not a git repository` |
| 2026-10-10T10:44Z | DeepSeek (cohort-engineer) | Verified toolchain | Node v24.21.0, pnpm 11.7.0 | both versions printed |
| 2026-10-10T10:44Z | DeepSeek (cohort-engineer) | Ran the full unit + integration suite | `tests/unit/*.test.ts`, `tests/integration/*.test.ts` | 153 tests, 153 pass, 0 fail |
| 2026-10-10T10:44Z | DeepSeek (cohort-engineer) | Ran typecheck (first snapshot) | `tsc --noEmit` | 10 errors, all in `tests/helpers/server.ts` |
| 2026-10-10T10:45Z | DeepSeek (cohort-engineer) | Verified migration CLI against a fresh file DB | `scripts/migrate.ts`, temp `DATABASE_FILE` | 3 migrations applied; status: 0 pending, 0 checksum drift |
| 2026-10-10T10:45Z | DeepSeek (cohort-engineer) | Found defect D1 | `db/index.ts:174-178` | `--status` on unmigrated DB → `SqliteError: no such table: schema_migration` |
| 2026-10-10T10:45Z | DeepSeek (cohort-engineer) | Ran lint | `eslint .` (direct binary) | 6 errors across `app/library/page.tsx`, `lib/import/plan.ts`, `lib/services/orchestration.ts`; `pnpm lint` aborts on an implicit install (D2) |
| 2026-10-10T10:46Z | DeepSeek (cohort-engineer) | Re-ran acceptance commands after other teammates' edits | tests + `tsc --noEmit` | 153/153 pass; 6 TS errors, all in newly added `app/library/[id]/page.tsx` |
| 2026-10-10T10:47Z | DeepSeek (cohort-engineer) | Created this evidence-backed handoff | `docs/CHATGPT_HANDOFF.md` (new file; no other file modified) | Sections 1-13 populated from the commands above; unverifiable items marked `[NOT VERIFIED]` |
| 2026-10-10T10:47Z | DeepSeek (cohort-engineer) | Final re-verification after other teammates' concurrent edits | `tsc --noEmit`, unit + integration suite | `tsc --noEmit` → 0 errors; tests → 153/153 pass; document updated so the snapshot matches (D5 marked resolved) |
| 2026-10-10T10:49Z | DeepSeek (cohort-engineer) | Captured the final snapshot of a moving tree | acceptance command + `tsc --noEmit` + app listing | 165 tests / 154 pass / 11 fail (new `tests/integration/pipeline.test.ts` 1/12, `tests/http/smoke.test.ts` 8/9); `tsc` 3 errors in those test files; `app/` = 23 files / 13 pages, leaving `/agents`, `/audit`, `/settings` without pages |
| 2026-10-10T10:50Z | DeepSeek (cohort-engineer) | Revised this handoff to the latest snapshot (no source files touched) | `docs/CHATGPT_HANDOFF.md` | Sections 1, 4, 5, 7, 9, 10 updated; defects D4-D8 recorded with the commands and timestamps that produced them |
| `[pending]` | `[next agent]` | Fix D1, clear D3, return D8 to green | `[paths]` | `[command output]` |

## 10. Next three executable tasks

1. **P0: Make `--status` safe on an unmigrated database (defect D1).** Acceptance criteria: with `DATABASE_FILE` pointing at a path that does not exist, `nodejs --experimental-strip-types scripts/migrate.ts --status` prints all three migrations as `pending` (`0 applied`) and exits 0, instead of throwing `no such table: schema_migration`. Files: `db/index.ts` (`migrationStatus` should treat a missing `schema_migration` table as "nothing applied"). Dependencies/permissions: none — source is owned by the lead.
2. **P1: Get lint back to zero errors (defect D3).** Acceptance criteria: `nodejs ./node_modules/eslint/bin/eslint.js .` exits 0 with no errors, and `tsc --noEmit` stays clean (3 errors currently sit in in-progress test files, defect D5). Files: `app/library/page.tsx:19` (unused `actor`), `lib/import/plan.ts:48,425` (`no-useless-escape`), `lib/services/orchestration.ts:38,366` (unused vars), `tests/http/smoke.test.ts:169`, `tests/integration/pipeline.test.ts:493,890`. Dependencies/permissions: none, but avoid overwriting other agents' in-flight edits.
3. **P2: Return the acceptance command to zero failures and prove the running application (defects D4, D7, D8).** Acceptance criteria: `nodejs --experimental-strip-types --test tests/unit/*.test.ts tests/integration/*.test.ts` reports 0 failures (all 6 domain suites + migrations + the new `tests/integration/pipeline.test.ts`), `tsc --noEmit` is clean, a production build produces `.next/BUILD_ID`, `tests/http/smoke.test.ts` reports 9/9, and every `href` in `components/site-nav.tsx` returns 200 or is removed/disabled. Files: `tests/integration/pipeline.test.ts`, `tests/http/smoke.test.ts`, `tests/helpers/server.ts`, `components/site-nav.tsx`, plus the missing `app/agents`, `app/audit`, `app/settings` pages. Dependencies/permissions: running `next build` at a moment when `app/` is stable, and coordination with the agents currently editing those test files.

## 11. Agent resume protocol

1. Read this handoff, the project brief, and the repository's README and agent-specific instructions. (Note: `README.md` does not exist yet — treat its absence as a documented gap, not as a reason to stop.)
2. Check the current Git branch, HEAD, status and latest remote state. There is currently no Git repository: if one has been created since, compare this handoff against actual files and recent commits and correct stale claims.
3. Verify GitHub/Vercel permissions in the *current* agent runtime; do not assume another AI's authorization transfers. As of this snapshot neither is authorized.
4. Run the documented install, lint, typecheck, test, migration and build steps as applicable — the exact commands and their last observed results are in section 7. Expect `pnpm run <script>` to fail in the DSH runtime (defect D2); use the direct `nodejs ./node_modules/...` invocations.
5. Select the highest-priority unblocked task from section 10. Implement it in actual code. Test it; fix failures.
6. Update this handoff, including file paths, real results, commit SHA and deployment results if relevant. Append to section 9; never delete earlier entries. Commit and push with the code when authorized.
7. Continue with the next priority. Do not replace implementation work with another speculative roadmap.

## 12. Ready-to-use prompt for a new ChatGPT session

> Continue the Research Respondent Platform project from `docs/CHATGPT_HANDOFF.md` in this repository (`C:\Users\spw666\Documents\deepseek-harness\default-workspace\research-respondent-platform` in the current workspace; adjust to wherever the repository is checked out). Read the whole handoff first, then inspect the working tree and run the documented commands: `nodejs --experimental-strip-types --test tests/unit/*.test.ts tests/integration/*.test.ts`, `nodejs ./node_modules/typescript/bin/tsc --noEmit`, `nodejs ./node_modules/eslint/bin/eslint.js .`, and `nodejs --experimental-strip-types scripts/migrate.ts --status` against a throwaway `DATABASE_FILE`. This is a Next.js 16 App Router + TypeScript + better-sqlite3 application whose pure decision logic lives in `lib/domain/*` (contracts in `lib/domain/types.ts`), persistence in `lib/repo/*`, services in `lib/services/*`, UI in `app/*`, and migrations in `db/migrations/*`. Treat only evidence-backed features as implemented — the handoff's feature matrix records what is verified. Preserve existing code, research integrity, consent, provenance and security requirements: never invent participant data or impute answers, keep external form submission dry-run only (`PLATFORM_SUBMISSION_PATH_VERIFIED` is false), and keep identity data separate. Implement and test the highest-priority unblocked task from section 10, fix errors, then update `docs/CHATGPT_HANDOFF.md` with exact changed paths, real command output, commit hashes, deployment details and the next three tasks. Use connected GitHub and Vercel tools only when authorized in this session; otherwise request connection through official flows. Do not claim unverified implementation, pushes, tests or deployments. Continue making real code changes rather than starting the design from scratch.

## 13. Open questions requiring action

- `[ ]` Has the owner approved the target application repository and branch? (No Git repository exists yet; the destination is not decided.)
- `[ ]` Is GitHub authorized to this agent through an official connection? (Not authorized in the session that produced this document.)
- `[ ]` Is Vercel authorized to this agent through an official connection? (Not authorized; no team, project or deployment URL is known.)
- `[ ]` Is preview deployment permitted? Is public production release separately approved? (SQLite files are not shareable across serverless instances — hosting model needs an explicit decision.)
- `[ ]` Which data sources and form destinations have participant consent and operator permission? (No Google Forms connection, OAuth client or service account exists in this session.)
- `[ ]` Are all external services, costs and sensitive-data handling requirements approved? (No DPIA, retention schedule review or instrument licensing review has been performed.)
- `[ ]` Which 5 navigation destinations (`/cohorts`, `/forms`, `/agents`, `/audit`, `/settings`) are in scope for the next batch, and should the nav hide them until they exist?
- `[ ]` May a production build (`pnpm build`) be run in a batch where `app/` is stable, so the HTTP smoke suite can be executed against a real build artifact?


## 14. GitHub continuation — 2026-10-10 UTC

Repository is now `speway/research-respondent-platform` (private), app root `research-respondent-platform/`. PR #1 is merged and Issue #2 is closed; its seven historical failures are already fixed. Main source `dabed376d36080bc31e466f6907c7172faab2e06` has successful CI. GitHub and Vercel are officially connected and preview preparation is authorized; production with participant data is not authorized. These facts supersede the pre-GitHub open questions above.

Issue #3 source `06c608321c4a9f6c4cc557a213fdca3fb2f627f5`: fresh-db migration status regression; consent/export filtering; study-scoped source loading; ownership and role guards; session-expiry validation; JSONL serialization. Local checks: lint 0, TypeScript 0, 173 tests passed, build 0, 11 HTTP tests passed using a disposable DB. HTTP actions use multipart envelopes; owning-admin mutation succeeds while foreign-admin mutation does not. All navigation destinations including audit/settings exist. Vercel project created with all-deployment SSO, no deployment yet; storage integration lookup is blocked by HTTP 403. See `WORK_CONTINUATION.md` for current state, blockers and next tasks. No real answers were generated or externally submitted.

## 15. Protected infrastructure Preview — 2026-10-10 UTC

Repository is now public (official metadata readback after the owner's update). PR #7 security CI passed; review is pending. Stacked PR #8 continues Issue #4. Source `807f82dd09039f1edf5cb288a83263cbef8db99b` passed local lint/typecheck, 175 tests, production build and 15 HTTP checks; GitHub CI run 38052752910 succeeded on all steps.

Protected Preview is READY at https://research-respondent-platform-hf3skhgcq-spw1.vercel.app (deployment `dpl_4LAR9fCtjmRXddi8Yws5CbbtXNRn`, target null). Official authorized HTTP fetch verified health 200 with `durable:false` and `signInEnabled:false`, login notice without email/password inputs, and participant route redirect to that notice. Vercel SSO protects all deployments; this service-level sign-in differs from the existing application's local email/password login. Opening repository source does not grant access to research records.

Preview uses an empty per-instance in-memory store and cannot accept research data; Vercel production fails closed. Local SQLite behavior and immutable migrations remain intact. Durable storage access is still blocked by HTTP 403. `PERSISTENCE_PLAN.md` records the concrete next implementation/restore gates; Issue #4 remains incomplete. No production version, real participant records or external form submissions were published. New `pohuy` style skill is installed in the project as requested; its separate Skills-workspace save failed with HTTP 422 and is not reported as completed.

## 16. Usable browser workbench — 2026-10-10 UTC

PR #9 (`feat/browser-workbench`) is stacked on #8. Checked application source `cfe539dc6224399f1496c71cac9333996a974c13`: locked install, lint, TypeScript and production build passed; 181 unit/integration and 16 HTTP tests passed with zero skips. The actual Chromium/Playwright workflow passed file import, filtering, missing-answer denial, exact mapping/export/hash, project save/restore, origin rejection, dictionary search and 390px layout; no page errors, POSTs or research-table writes. Initial select-label and MJS lint failures were corrected before the verified run.

Preview is READY at https://research-respondent-platform-lro81x47q-spw1.vercel.app/workbench; deployment `dpl_Hu5qCRMXDAt3w9XERiMbCrB2oJ8p`, target null, source SHA above. GitHub CI: https://github.com/speway/research-respondent-platform/actions/runs/38054284615 (SUCCESS). Protected deployed HTTP checks passed for the workbench and health; server research pages still require disabled Preview sign-in. Home now opens the workbench. The owner received access via an official temporary share link; its bearer token is not committed.

The shared persona-skill chat was read. It describes modeled-persona tooling, not an attached empirical answer database. The 17-group/169-label dictionary was reused byte-for-byte from PR #6; it only labels criteria. Actual answers must come from a supplied source file. Data processing remains in browser memory; project persistence is a downloaded local file, not cloud storage. External submissions, automatic Google Forms structure extraction, Python worker deployment and durable multi-user hosting remain unimplemented. See `BROWSER_WORKBENCH.md` and `WORK_CONTINUATION.md`. Issue #4 stays open.

## 17. External browser-agent automation — 2026-10-10 UTC

PR #10 continues the existing workbench on branch `feat/agent-workbench-automation`, stacked on PR #9. Initial source `19fd61eeba1f893a9bda94ad85800c610bcace5e` passed GitHub CI run 38056864815 including both real browser workflows. Checked source `9bf7661ae0987bc4651f029e1c9753479e6c3621` additionally publishes structural task/observation schemas and an input-contract drift test. Local locked install, lint, TypeScript and production build passed; 191 unit/integration and 17 HTTP checks passed with zero skips.

The Automation tab and same-tab command bridge let external agents load a source, read visible form questions, map exact source headings, validate values and prepare a browser plan without manual panel clicks. A portable Playwright executor handles text/single-choice sections, checks every filled value, uses recipient/participant/source-bound grants, and requires a persistent atomic receipt journal before submission. Visible response-recorded confirmation is required; uncertain results cannot auto-retry. The actual browser path passed on an explicitly isolated two-section fixture, including missing/stale/concurrent/permission/uncertain-repeat cases. This is not evidence of a live Google Forms submission.

There is no continuously running hosted AI agent, multi-user cloud database or batch queue. Complex controls and documented item-key mappings still need a more capable reader and independent live checks. No actual participant data or external live submission is included. Existing research authorization and production gates remain; Issue #4 stays open. Read `AGENT_AUTOMATION.md` and `WORK_CONTINUATION.md` for current contracts, evidence and deployment readbacks. This entry supersedes the prior blanket absence of an external browser executor while preserving its historical record.

Application-source CI https://github.com/speway/research-respondent-platform/actions/runs/38057231467 succeeded on every step including actual browser verification. Protected Preview is READY at https://research-respondent-platform-p5gqj3uzd-spw1.vercel.app/workbench (deployment `dpl_4Re45WFV1EYUQz2XnnF9uTFb2eHo`, target null, checked Git SHA above). Authorized deployed HTTP verified the Automation menu without password fields, manifest and both input schemas 200, healthy isolated storage and unchanged research-route denial. Official temporary owner access was prepared; no bearer link is committed. Production remains disabled.

## 18. Form controls and source reuse — 2026-10-10 UTC

Branch `feat/form-control-expansion` continues PR #10. Existing components/migrations were preserved. Introductory pages, row-scoped radio/checkbox matrices, exact multiple-choice sets, dropdowns and native number limits are handled by the portable adapter. A new `target` command/Automation URL input reuses the loaded base and criteria while invalidating the previous observation/map. Actual Chromium checks include draft leakage refusal, row isolation, numbers, lists and link reuse; see WORK_CONTINUATION.md for the checked source and CI/Preview readbacks.

Read-only live inspection reached page 2 of the supplied Google Form and inspected six question containers without filling or submitting. The bounded official-SDK cloud audit adapter is written/tested with injected Sandbox lifecycle fixtures, but real provisioning/install remains unverified and no hosted background service was activated. Its five-minute one-vCPU nonpersistent run requires a durable atomic budget journal and an evidenced one-run approval. Project metadata lists no sandboxes or envs; billing allowance is not exposed. Production and real-data submission remain unapproved.

### 19. Verified cloud runtime and public main panel continuation (2026-10-10)

One explicitly approved Vercel Sandbox run actually launched sandboxed Chromium
and read the supplied Google Form's second page after its empty introduction.
Audit exit 0; no source records, answers or submission; stop verified after
239781 ms. Runtime repairs and provider counters are in
`CLOUD_RUNTIME_VERIFICATION.md`; final stricter guards are fixture-tested and
not yet re-run in a cloud Function. Adapter OIDC hosting/queue remain incomplete.
The latest owner message explicitly authorizes all project work and requests a
normal main site URL. Workbench/home routing now permits the data-free public
panel in production; research/SQLite access remains blocked. Local checks:
204 tests, 17 HTTP, lint/types/build and all three Chromium scripts pass.
A new private Blob budget adapter is prepared; after reauthorization, provider
create returned 403. No store/anonymous paid endpoint exists. Use the latest
WORK_CONTINUATION/PR records for final commit, CI and deployment URLs. Do not ask
for blanket permission again; proceed through official service authorization and
require actual participant sources/consent before empirical submissions.

### 20. Owner authenticated; private Preview storage (2026-10-11 +05:00)

Vercel Storage login is now completed. A private IAD1 Blob store is connected
through OIDC to the existing application's Preview only, without copying secrets.
Branch feat/private-cloud-journal adds a bounded provider concurrency/read/access
probe and protected Preview setup page; no participant uploads or background
worker are enabled. Read WORK_CONTINUATION and current PR/CI for real probe
results; the prior credential blocker is historical, not a request for permission.

### 21. Hosted read-only Workflow continuation (2026-10-11 UTC)

Restored pending unsaved code atop GitHub PR #13 without rewriting existing
components. Pinned Workflow 5.2.0 adds scoped Preview-only managed execution,
immutable private launch receipts and a non-retrying bounded read-only step.
Actual restored-source checks: frozen install, lint, types, build exit 0;
212 unit/integration and 18 HTTP tests pass with zero skips. Provider execution
is pending; no participant records were supplied or sent. Consult current
WORK_CONTINUATION and HOSTED_READ_ONLY_WORKFLOW rather than assuming readiness
from a successful build. External-agent prompt is in AGENT_TRIAL_PROMPT.md.
