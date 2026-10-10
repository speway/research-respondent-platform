# Durable deployment plan — Issue #4

Status: proposal, 2026-10-10 UTC. Durable hosting is not implemented or verified.
This plan continues the existing SQLite repositories and immutable migrations.

## Current deployment contract

| Environment | Database | Sign-in and research writes |
| --- | --- | --- |
| Persistent local Node process | Existing configured SQLite file | Existing authenticated workflow |
| Vercel Preview | Empty in-memory database per function instance; ignores `DATABASE_FILE` | Disabled, including valid cookies from another database |
| Vercel production | No database opened | Disabled; health returns a sanitized 503 |

The Preview validates routing, packaging and deployment protection. It is not a research workspace. No accounts, respondents or research records are seeded. Storage credentials must not be attached to this infrastructure preview.

## Proposed provider decision

Managed libSQL/Turso is the first candidate to evaluate because it retains SQLite SQL semantics. This is a recommendation to investigate, not an installed integration. The current synchronous `better-sqlite3` driver cannot be replaced by an asynchronous network client with a one-line connection-string change. Repository methods, transaction callbacks, services and their callers must be adapted in bounded patches; verify existing schema features, constraints and triggers against the selected provider before committing to it.

Managed PostgreSQL is an alternative if provider requirements justify the larger SQL/schema migration. Persistent Node hosting with a mounted volume could retain the current driver, but must independently verify disk durability, single-writer topology, encrypted backups and recovery. Ordinary Vercel function-local files do not provide that contract.

Provider selection must establish region, data residency, retention, access control, backup capability and cost with the owner. Do not provision a paid resource without authorization.

## Access prerequisite and authorization

The official connected Vercel operation to list account storage integration configurations returned HTTP 403 (`forbidden`). Project creation, protection and deployment operations were separately authorized and worked; those permissions do not prove storage permissions. No authenticated Vercel CLI was available. Do not request tokens in chat or retry the same forbidden operation unchanged.

The next owner action is to authorize the necessary storage integration through the connected service or connect an approved provider through its official flow. Until then, infrastructure Preview work can continue, but real-data hosting remains blocked.

## Implementation batches after provider authorization

1. Create separate preview and production databases. Load connection credentials from officially configured, environment-scoped secrets. Verify the connection without exporting secrets or participant data. Use separate migration and application credentials where supported; keep application permissions minimal.
2. Introduce a typed async database boundary with explicit transaction ownership. Port one repository/service slice at a time. Preserve atomicity for import, scoring, task state transitions and audit recording. Do not silently fall back to an empty local file on provider failure.
3. Apply existing migration contents without editing their checksums. Where provider compatibility needs a schema change, add a forward migration and record the mapping. Verify constraints, indexes, triggers, rollback behavior and concurrent updates on the actual service.
4. Move users, hashed sessions, consent records, source-backed responses, scores and audit data through the same durable boundary. Expiry and consent withdrawal must retain the security behavior covered by Issue #3. Do not add generated participant answers or fill missing responses during migration.
5. Validate an isolated fixture dataset across independent instances and a fresh deployment: record counts and IDs, source hashes, score equivalence, audit completeness, foreign-key integrity, concurrent mutations and failed-transaction behavior. Export gates must still filter each participant/study using current consent.
6. Add a restricted operator bootstrap mechanism. Never expose unauthenticated first-user creation or a public database management route. Keep infrastructure Preview sign-in disabled until this flow is reviewed.

## Backup, transfer and recovery acceptance

Choose measurable RPO/RTO with the owner. Backups must be encrypted with restricted access, and retention must be documented. A restore to a separate database must actually be tested; an enabled backup setting is not restore evidence.

For an approved real-data transfer: pause writes, take a verified consistent backup, record counts and hashes, transfer without modifying responses, validate referential/audit integrity, then enable the new store only after acceptance. Protect raw response data and identity mappings throughout the transfer. Consent withdrawal, retention and deletion need an explicit policy; do not bulk-delete records as an inferred migration step.

Rollback must retain the previous verified store and application artifact. Avoid simultaneous writes to two databases. Do not rewrite migration history or claim data recovery unless the restore test passed.

## Release gates

- Issue #3 security review accepted; document remaining organization-shared aggregate reads.
- Provider, region and cost approved; official connection available.
- Actual remote migration, multi-instance persistence, transaction and backup/restore checks pass.
- Frozen install, lint, TypeScript, all tests, production build and real HTTP smoke checks pass on the release commit.
- Protected Preview permits only the reviewed, durable workflow with isolated data.
- Owner explicitly authorizes production with personal data. A Preview approval is not production authorization.

References consulted: [Vercel function runtime filesystem](https://vercel.com/docs/functions/runtimes), [Vercel file tracing](https://vercel.com/kb/guide/how-can-i-use-files-in-serverless-functions), [official libSQL client](https://github.com/tursodatabase/libsql-client-ts).
