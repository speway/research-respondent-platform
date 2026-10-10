# ChatGPT Work continuation

## Source of truth and current task

Repository: `speway/research-respondent-platform` (private). App root: `research-respondent-platform/`.
PR #1 is merged; Issue #2 is closed. Do not repeat the seven historical pipeline fixes.
Current task branch: `fix/issue-3-security-review`, based on main `dabed376d36080bc31e466f6907c7172faab2e06`.
Main CI evidence: https://github.com/speway/research-respondent-platform/actions/runs/38050403851 (SUCCESS).

`CHATGPT_HANDOFF.md`, app README status tables and `RESEARCH_INTEGRITY.md` contain dated pre-GitHub observations. They are historical evidence, not the current repository/deployment state. Append corrections to the historical activity log; do not remove old entries.

## Verified batch: fresh database status (2026-10-10 UTC)

Checked source commit: `c693186e39145cdc2b9b42ff374225db7885a241` (official GitHub commit on the task branch).
Files: `db/index.ts`, `tests/integration/migrations.test.ts`.
`migrationStatus()` reports all migrations pending on an unmigrated DB without creating schema metadata.
Existing migration SQL and checksums are unchanged. Repository files were fetched using the official GitHub connection and verified byte-for-byte against their Git blob SHA before edits.

Local runtime: Node 24.19.0; pnpm 11.25.0 (CI remains Node 24 / pnpm 11.7.0).
The first native SQLite install failed because the restricted environment could not retrieve Node headers; installation succeeded with matching 24.19.0 headers from the Node binary npm package, without repository or lockfile changes.

| Command | Actual result |
| --- | --- |
| `pnpm install --frozen-lockfile` with local matching Node headers | exit 0 |
| `pnpm run lint` | exit 0 |
| `pnpm run typecheck` | exit 0 |
| `pnpm test` | exit 0; 166/166 pass, 0 skipped (165 original + 1 regression) |
| `pnpm run build` | exit 0; 19 app routes including audit/settings |
| `pnpm run test:http` | exit 0; 9/9 pass, 0 skipped; production server on a disposable DB |
| `DATABASE_FILE=<fresh temporary path> pnpm run db:status` | exit 0; 4 pending, 0 drift |

No actual participant records, credentials, local databases or exports were committed. No external forms were submitted. No deployment was performed in this batch.

## Open findings for Issue #3

- Export runner computes an excluded-consent list but currently does not filter those participants from export content. Fix and add regression tests before using real data.
- Mapping source loader ignores study scope and currently keeps only one answer per instrument rather than all answers in its latest session. Check multiple sessions/items and cross-study isolation.
- Review organization ownership at server-action boundaries, scoped role grants, export approval, session expiry, and consent expiry/revocation.
- `/audit` and `/settings` already exist; do not recreate them. Extend permission/HTTP checks.

## Issue #4 boundary

Persistent storage on Vercel is unresolved. Current `better-sqlite3` file data is appropriate only on persistent infrastructure, not ordinary Vercel functions. Do not label an ephemeral preview DB durable.
Only prepare a preview without real research data; require human review of Issue #3 and a documented persistent store/recovery plan before production. Use official connected service authorization; never ask for tokens in chat. Do not change billing, deploy production or submit forms without explicit authorization.

## Next three tasks

1. Fix the verified consent/export and mapping-scope defects with focused security regression tests.
2. Run lint, TypeScript, all unit/integration tests, production build and HTTP smoke again; update this file and open an Issue #3 PR.
3. Continue Issue #4: persistence/recovery plan and safe Vercel Preview; record verified URLs and precise remaining blockers. Keep production disabled.

## Working rules

Use one main agent. Work in bounded patches: inspect → patch → tests → documentation → commit → PR. Keep applied migrations immutable. Do not force push or write directly to main. No real responses may be replaced or filled with generated values. Every pass claim must name its tested source commit and actual command result.
