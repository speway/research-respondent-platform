# Persistent file cabinet and agent handoff

This continues the existing workbench/runner. `/cabinet` provides issued-account
sign-in without email registration, private source/questionnaire uploads, immutable
project revisions, opening a stored source in `/workbench?project=<id>`, and a
project-scoped agent prompt/key. The original local research database stays gated.

## Storage and authentication

The cabinet is a **private Blob file catalog**, not a PostgreSQL migration of the
legacy SQLite schema. Original file bytes, SHA-256, source/version/rights declarations,
project settings, hashed session/key references and revocation records are private.
Private content is read uncached on the server; public Blob links are not returned.
The owner and shared accounts have separate prefixes, as do Preview/production.
Shared-account users share that account's projects; individual attribution among
colleagues is not implemented. Do not describe this as organization RBAC migration.

`RRP_CABINET_STORE_ID` selects the separate private store through the installed
Blob SDK's official OIDC authentication. `RRP_CABINET_ACCOUNTS` is a sensitive
server-only environment JSON array with `{id,login,label,password:{hash,salt,params}}`.
Only the existing scrypt parameters are accepted; no plaintext password is stored
or included in browser props. IDs are `owner`/`team`; there is no public signup.
The existing hashing/token primitives are reused. SQL session cookies cannot grant
cabinet access, and cabinet credentials cannot bypass the legacy hosting policy.

Sessions last eight hours and use HttpOnly/SameSite cookies with Secure on deployed
production. Tokens are 256-bit random values; only SHA-256 references are persisted.
Logout and key revocation append immutable tombstones. Password-hash rotation
invalidates previous sessions and keys. Login uses durable 15-minute counters
(100 global / 20 per exact login), provider ETag conditional updates and fail-closed
handling of uncertain writes. Cookie-authenticated mutations require matching
Origin and JSON. JSON bodies are streamed with a 3 MiB ceiling. API responses use
private/no-store, nosniff and no-referrer. No API logs source cells or credentials.

## Sources, instruments and projects

Files: 2 MiB each. Sources: CSV/TSV/JSON, valid UTF-8, existing 5,000-record /
250,000-cell importer, at most 2,000 headers and a bounded task JSON. BOM is
preserved for the byte digest; the existing CSV parser handles it. The existing
modeled-provenance refusal is reused. Rights/consent declarations are operator
statements, not automatically verified participant evidence.

Questionnaires also accept TXT, PDF and DOCX. PDF/DOCX are stored as originals;
**document extraction, scoring-key parsing and clinical interpretation are not
implemented by this upload path**. The receiving agent needs a document reader.
Item mappings still come from exact source headers and visible form observations.
Uploads publish an index only after a private byte/hash readback. An interrupted
upload can leave an unindexed private orphan; no fabricated success is reported.

Projects require a stored source, exact ID header, purpose, Google Forms URL and
optional linked questionnaires. Initial selection is explicitly all records;
filters are edited in the existing workbench and saved as a new immutable revision.
The snapshot request carries settings only. The server always reloads original
source bytes; browser-side cell changes cannot replace source answers. Revisions
do not overwrite previous projects/keys. Catalog guardrails: 100 assets and 250
project revisions per account; 20 active keys. These are bounded catalog checks,
not transactionally exact simultaneous quotas. Provider pagination over 1,000
entries fails closed instead of silently omitting records.

## Agent access

The cabinet generates a complete prompt. `GET /api/cabinet/agent` requires
`Authorization: Bearer <key>` and returns `rrp.cabinet-bundle.v1`: frozen project,
source metadata, an existing-format `rrp.agent-task.v1` and questionnaire metadata
with authenticated `downloadPath` values. Files are downloaded separately to stay
within Function response limits. `?asset=<uuid>` only permits the source or
questionnaires linked to the key's project. Raw keys are shown once, valid for
24 hours, and can be revoked from the catalog after a reload. Other project IDs
or account IDs are not accepted as a way to expand a grant.

This key is **read-only** and does not authorize form submission. It never creates
participant answers or consent. Existing exact mappings, required-field checks,
recipient/participant/source-bound execution grants and durable receipt requirements
remain. No continuously running hosted participant executor is enabled here.
The site-served guide is `/agent-cabinet.md`; the manifest advertises the cabinet
contract and continues the existing same-tab workbench protocol.

## Verification and operational limits

`tests/integration/cabinet.test.ts` uses isolated in-memory provider fixtures to
test credential/session controls, ETag contention, uncertain writes, byte integrity,
account isolation, project key scope/expiry/revocation and immutable settings.
HTTP tests cover discovery, unavailable configuration, auth/origin refusal and
production diagnostic denial. These are software fixtures, never real respondents.

`RRP_CABINET_PROOF=1` is branch-scoped protected Preview only. Its single create-only
reservation protects `/cloud/cabinet-check/run`; it performs real provider
write/read/login/key checks in `isolated-verification`, inaccessible through normal
cabinet account prefixes, then persists a small status report. A failed or uncertain
reservation must be inspected before manual recovery; the route does not rerun it.
The proof code and page return 404 in production. Consult WORK_CONTINUATION for
actual cloud/CI readbacks; implementation is not proof of provider execution.

Deletion, expiry cleanup, individual coworker invitations, participant-level consent
enforcement on external export, relational database migration, full live transfer
and background participant filling remain future work. Issue #4 remains open.
No real participant source was provided during this coding stage; production
deployment contains the cabinet implementation and empty account catalogs.
