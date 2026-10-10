# ChatGPT Work continuation plan

> **Current operational handoff (2026-10-10).** This file supersedes stale repository/deployment status inside `docs/CHATGPT_HANDOFF.md`. No unexecuted test or release is described as successful.

## Current verified acceptance result (2026-10-10 UTC)

- **Validated source commit:** `146991f741f92d552f1d53b8d988af9cf42e2eea`
- **GitHub Actions evidence:** https://github.com/speway/research-respondent-platform/actions/runs/38050032327
- `pnpm install --frozen-lockfile`: PASS
- Native `better-sqlite3` check: PASS
- `pnpm run lint`: PASS
- `pnpm run typecheck`: PASS
- `pnpm test`: **165/165 PASS**
- `pnpm run build`: PASS
- `pnpm run test:http`: **9/9 PASS** (authenticated production app on temporary DB)
- Status: all automated CI gates satisfied **for the tested commit**. This is not equivalent to a production security review.
- Issue #2 (pipeline integration failures): resolved on this branch. Next focus: Issue #3 (migration status, authorization review), then Issue #4 (persistent production database and Vercel preview).
- No deployment, user-data import or external Google Forms submissions were performed.
- Recent fixes: persisted agent task ID now matches the validated task-contract ID; derived-score cohort SQL joins the assessment session; identity lawful-basis validation rejects whitespace; tests distinguish missing mapped values from unmapped fields; remaining test expectations now match actual persisted IDs and absence of external receipts; `/audit` and `/settings` are authenticated read-only operational pages.
- Keep `main` and private research data protected. Before real participant data is used, perform a security review and implement durable storage / backup.

## Tracked GitHub issues

- **P0:** https://github.com/speway/research-respondent-platform/issues/2 — restore seven failing pipeline integration tests.
- **P1:** https://github.com/speway/research-respondent-platform/issues/3 — migration status regression, missing UI routes, authorization checks.
- **P2:** https://github.com/speway/research-respondent-platform/issues/4 — durable database and safe Vercel preview.

Issue #2 has passing CI on the branch; next start with Issue #3. The cleanup PR is https://github.com/speway/research-respondent-platform/pull/1; it is a draft and should remain unmerged until the acceptance checks pass.

## Latest verified GitHub Actions result (2026-10-10 UTC)

- CI run: https://github.com/speway/research-respondent-platform/actions/runs/38049379130
- Source commit tested: `87792568eb49f117b6501d87cf7fb95add3d1224`
- `pnpm install --frozen-lockfile` **PASS**; native `better-sqlite3` load **PASS**.
- `pnpm run lint` **PASS** (after correcting 8 ESLint errors on this branch).
- `pnpm run typecheck` **PASS** (after correcting 2 integration-test typing errors).
- `pnpm test` **FAIL**: 165 tests, **158 pass and 7 fail**, all seven in `tests/integration/pipeline.test.ts`.
- Production build and HTTP smoke test: **NOT RUN** (skipped because integration tests failed).
- Failing cases and reported symptoms:
  1. Study/protocol/criterion creation: unexpected strict equality assertion.
  2. Private identity lawful basis: SQLite trigger rejects the write (must preserve the consent/legal-basis invariant).
  3. Cohort with consent: SQL error `no such column: ds.instrument_version_id`.
  4. Form preflight with missing source: strict equality assertion mismatch.
  5. Orchestration blocked external submission: expected block outcome differs (`failed` observed).
  6. Agent authorization: test asserts agentWrite is not study-scoped; authorization rejects it.
  7. Append-only answer/audit event: assertion failed.
- **Next concrete action:** reproduce failures one at a time. Compare test expectations with the protocol, schema and authorization invariants. Repair incorrect SQL and test fixtures as needed; do **not** weaken identity, consent, provenance or submission restrictions to make a test pass. Then rerun all acceptance gates.

## Verified source-control baseline

- GitHub repository: `speway/research-respondent-platform` (private as inspected on 2026-10-10).
- Default branch: `main`; initial code snapshot inspected at commit `127fa2540752d80d25b062dfb6ed32929c3debe1`.
- Project is inside `research-respondent-platform/`, **not** the GitHub repository root. Deliberately keep that app layout for now. Vercel root directory must point to the nested app if preview deployment is attempted.
- Baseline has 105 tracked files, Next.js 16 / React 19 / TypeScript, pnpm 11, native `better-sqlite3`, migrations, UI routes, domain engines, agent orchestration and tests. These are code-presence observations, not proof that every feature works.
- Original CI path was nested under `research-respondent-platform/.github/workflows/ci.yml` and therefore was not a working GitHub workflow at repository root. The repository-cleanup PR moves the workflow to `.github/workflows/ci.yml` and gives its commands the correct working directory.
- The `pnpm-workspace.yaml` baseline contained the placeholder value `allowBuilds.better-sqlite3 = "set this to true or false"`; this PR replaces it with explicit boolean policy and removes the unsupported pnpm 11 `onlyBuiltDependencies` key.
- The earlier handoff was created in a local workspace **before GitHub initialization**. Its claims about missing git, workflow, pages and 3 migrations are historical, not necessarily true of this current commit. The repository currently contains 4 migration files and an `/agents` page.

## What changed in repository-cleanup PR

- New root `README.md`: navigable index, correct setup commands and deployment boundary.
- New root `AGENTS.md`: durable cross-agent operating instructions.
- New root `.gitignore`: excludes node modules, build output, local SQLite/exports, secrets and credentials.
- Relocated GitHub Actions workflow to repository root, adjusted pnpm lockfile cache key and command working directories.
- Updated `pnpm-workspace.yaml` for pnpm 11 build-script allowlist.
- Removed abandoned `scratch-sqlite-test/` dependency probe and empty `.Rhistory`.
- Added this document for Work and future AI agents.
- Did **not** relocate `app/`, `db/`, `lib/`, or rewrite the existing historical handoff; no silent mass refactors.

## Priority queue (one completed task per iteration)

### P0: Verify CI end-to-end

1. Check out this PR branch locally or in ChatGPT Work.
2. Execute `pnpm install --frozen-lockfile` from the nested application directory.
3. Run `pnpm run lint`, `pnpm run typecheck`, `pnpm test`, `pnpm run build`, `pnpm run test:http`.
4. Record failure output and fix root causes, **not** blanket-disable tests or lint rules.
5. Check GitHub Actions for this PR; only merge after reviewing CI. The PR's existence and correct workflow path do not guarantee green checks.

### P1: Repair verified and likely functional blockers

1. Reproduce `db:status` on an absent/new SQLite database: previous DeepSeek logs reported a `no such table: schema_migration` failure. Add a regression test and make missing migration metadata report migrations as pending.
2. Re-run the integration pipeline and HTTP smoke tests: historical snapshot showed failures during concurrent agent editing. Revalidate them on the current **stable** code before trusting old error counts.
3. Compare `components/site-nav.tsx` destinations to actual `app/**/page.tsx` routes. Current tree has `app/agents/page.tsx` but no `app/audit/page.tsx` or `app/settings/page.tsx`. Either implement the pages fully or remove disabled links until ready.
4. Check all server-action authorization boundaries, session-cookie handling, input validation, per-study scope, personal-data exposure, and export permissions. Add focused tests.

### P2: Product data integrity and observability

- Verify consent, participant identity separation, immutable observed answers and audit event logging at database AND action boundaries.
- Confirm that psychometric item wording, scoring keys and interpretation thresholds are versioned and legally/licensably sourced; do not infer psychometric validity from code unit tests alone.
- Confirm imports reject missing provenance and unsupported free-text outcomes rather than silently filling them.
- Add reliable run-level summaries and exportable structured audit results, including failure causes, idempotency and explicit human approvals.
- Integrate external form structure/response reads only through authorized provider APIs; keep submission blocked unless an independently verified official provider capability and participant authorization exist.

### P3: Production architecture and deployment

1. Before hosting real data, select a persistent managed database (e.g., hosted PostgreSQL) or suitable persistent infrastructure; current `better-sqlite3` file database is for local development, not durable Vercel serverless storage.
2. Plan SQL migrations, backup/restore, retention/deletion, data minimization, security review, role enforcement and encryption/secret management.
3. Connect GitHub and Vercel using the **user's official permission/authorization flow**, never collect personal access tokens in chat.
4. Create a preview environment with Vercel Root Directory = `research-respondent-platform`. Verify actual deployment URL, health endpoint, sign-in and smoke tests; don't label preview production.
5. Ask for explicit owner approval before deploying with real participants, enabling any external submission, changing billing or exposing a public site.

## The Work workflow

Start ChatGPT **Work mode** with the instruction below; connect the GitHub app already linked where authorized and connect Vercel through its official connection if needed.

```text
Continue development of GitHub repository speway/research-respondent-platform.
First read AGENTS.md, README.md, research-respondent-platform/docs/WORK_CONTINUATION.md, and docs/CHATGPT_HANDOFF.md inside the app. Inspect current main, open PRs, and recent commits. The historical DeepSeek handoff predates GitHub and is NOT the source of truth for repo status.
Do not rebuild from zero or repeat completed work. Take the highest-priority unresolved item in WORK_CONTINUATION.md, implement a narrowly scoped code fix on a new branch, execute real lint/typecheck/unit/integration/build/HTTP checks, document observed results and remaining failures, and open a PR. Update WORK_CONTINUATION.md with the commit and next three tasks. Work iteratively until the acceptance checks are green.
Use one primary coding agent by default; spawn more only for independent modules with defined budgets. Never share or log secrets. Keep participant responses empirical, documented and consented; never substitute generated data for actual participants.
Do not deploy to Vercel production or incur costs without explicit user approval. Once local and CI gates pass, ask for official Vercel connection and propose a preview deployment with a persistent database plan.
```

## Hand-off checklist after each Work batch

- Current branch / exact commit and PR URL.
- Modified and removed file paths; rationale.
- Commands executed and real pass/fail counts with error excerpts.
- Database migration state including source of truth.
- Security or privacy issues found, with severity and mitigation.
- Preview URL and logs **only if deployed and verified**.
- Top three next tasks, blockers, and required human decisions.
- Updated `docs/WORK_CONTINUATION.md` committed with changes.

## Budget control

Avoid speculative parallel teams. Separate each task into a bounded patch and acceptance criteria. Reuse existing functions and tests. Avoid repeatedly pasting the entire codebase into agent context. Stop and report a clear blocker when authorization or an external resource is actually required.
