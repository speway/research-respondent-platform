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

## Verified security batch: Issue #3 (2026-10-10 UTC)

Checked source commit: `06c608321c4a9f6c4cc557a213fdca3fb2f627f5` on `fix/issue-3-security-review`.
Modified: `app/actions/{agents,audit,cohorts,forms,import,library,participants,studies}.ts`, `app/api/health/route.ts`, `lib/domain/types.ts`, `lib/repo/{org,participants}.ts`, `lib/services/{authz,cohorts,exports-runner,orchestration,ownership,preflight-context}.ts`, `tests/integration/security.test.ts`, `tests/http/smoke.test.ts`.

- Consent gates now filter actual export rows per participant/study; withdrawal cannot fall back to an older grant or blanket consent. Invalid/equal expiry dates fail closed. Withdrawal returns its persisted record ID for audit.
- Shared provenance sources without participant-linked sessions are omitted conservatively; sources shared across studies are omitted from study-specific exports. Raw source metadata/free-text are not guaranteed anonymous; review content before sharing.
- Latest-session mapping keeps every item, scopes answers/scores to the requested study and avoids mixing scores from an older selected session.
- Fixed-query ownership guards protect supplied study/participant/form/library/cohort/agent/export IDs. Task mutations check organization ownership. Study roles no longer grant global study administration; consequential permissions retain their assigned study scope. Participant-wide edits require a grant in an enrolled study.
- Snapshot creation requires write permission. Export approval/read actions check ownership and permissions. JSONL is serialized as one object per line.
- Session expiry is validated; health errors no longer echo DB paths/errors. Cookie flags and tampered-session denial are checked over HTTP.
- Audit/settings routes already existed and rendered successfully; they were not recreated. Audit exports UI remains a read-only monitor; export actions not wired to that page are tested through services, not misreported as a live UI flow.

| Command on this source | Actual result |
| --- | --- |
| `pnpm run lint` | exit 0 |
| `pnpm run typecheck` | exit 0 |
| `pnpm test` | exit 0; 173/173, 0 skipped |
| `pnpm run build` | exit 0; 19 routes |
| `pnpm run test:http` | exit 0; 11/11, 0 skipped |

The HTTP suite now sends real multipart server-action requests. A foreign administrator's study update is denied without changing the record; identical arguments succeed for the owning administrator. An initial attempt to test export actions over HTTP failed because those actions are not registered in the current read-only audit page; the corrected test exercises the live study action. The first new security-fixture run failed from incomplete fixture attributes, then passed after fixing the fixture. No failed runs are claimed as successful.

Organization-scoped list/read pages remain the existing organization-sharing model; this batch does not claim per-study isolation for every aggregate read. Real-data deployment still requires the persistence and security review in Issue #4.

## Issue #4 boundary

Persistent storage on Vercel is unresolved. Current `better-sqlite3` file data is appropriate only on persistent infrastructure, not ordinary Vercel functions. Do not label an ephemeral preview DB durable.
Vercel project `research-respondent-platform` / `prj_QImIDlAL2gWdBGOVUayiUjVkeO2r` was created in team `team_ztfiT5yPQ2DPmzYfb4ZWyp6W`, with Next.js, Node 24, app root and SSO protection for all deployments. No deployment yet. Listing storage integrations returned HTTP 403 (forbidden); no authenticated Vercel CLI is installed. Do not assume a persistent resource exists.
Only prepare a preview without real research data; require human review of Issue #3 and a documented persistent store/recovery plan before production. Use official connected service authorization; never ask for tokens in chat. Do not change billing, deploy production or submit forms without explicit authorization.

## Next three tasks

1. Review/merge the Issue #3 PR after its GitHub CI passes.
2. Stage a fail-closed, read-only Vercel Preview with no participant records; verify its real URL.
3. Continue Issue #4: persistence/recovery plan and safe Vercel Preview; record verified URLs and precise remaining blockers. Keep production disabled.

## Working rules

Use one main agent. Work in bounded patches: inspect → patch → tests → documentation → commit → PR. Keep applied migrations immutable. Do not force push or write directly to main. No real responses may be replaced or filled with generated values. Every pass claim must name its tested source commit and actual command result.
