# ChatGPT Work continuation

## Source of truth and current task

Repository: `speway/research-respondent-platform` (now public; verified 2026-10-10). App root: `research-respondent-platform/`.
PR #1 is merged; Issue #2 is closed. Do not repeat the seven historical pipeline fixes.
Current task branch: `feat/form-control-expansion` / PR #11, stacked on `feat/agent-workbench-automation` / PR #10, then `feat/browser-workbench` / PR #9, then `feat/issue-4-protected-preview` / PR #8 and `fix/issue-3-security-review` / PR #7. Main baseline is `dabed376d36080bc31e466f6907c7172faab2e06` (reverified 2026-10-10).
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
Vercel project `research-respondent-platform` / `prj_QImIDlAL2gWdBGOVUayiUjVkeO2r` was created in team `team_ztfiT5yPQ2DPmzYfb4ZWyp6W`, with Next.js, Node 24, app root and SSO protection for all deployments. Infrastructure Preview is now READY (see evidence below). Listing storage integrations returned HTTP 403 (forbidden); no authenticated Vercel CLI is installed. Do not assume a persistent resource exists.
Only prepare a preview without real research data; require human review of Issue #3 and a documented persistent store/recovery plan before production. Use official connected service authorization; never ask for tokens in chat. Do not change billing, deploy production or submit forms without explicit authorization.

## Verified infrastructure Preview batch — 2026-10-10 UTC

Checked source commit: `807f82dd09039f1edf5cb288a83263cbef8db99b`.
PR #7: https://github.com/speway/research-respondent-platform/pull/7; security CI SUCCESS: https://github.com/speway/research-respondent-platform/actions/runs/38052097626.
PR #8: https://github.com/speway/research-respondent-platform/pull/8 (stacked on #7; Issue #4 remains open).
Preview-source CI SUCCESS: https://github.com/speway/research-respondent-platform/actions/runs/38052752910; all install/native-binding/lint/typecheck/tests/build/HTTP steps succeeded.

Modified code: `lib/services/hosting-policy.ts`, `lib/db-context.ts`, `lib/services/session.ts`, `db/index.ts`, `next.config.ts`, `app/api/health/route.ts`, `app/login/page.tsx`, `tests/integration/hosting-policy.test.ts`, `tests/http/preview.test.ts`.

| Command | Actual local result |
| --- | --- |
| `pnpm run lint` | exit 0 |
| `pnpm run typecheck` | exit 0 |
| `pnpm test` | exit 0; 175/175 pass, 0 skipped |
| `pnpm run build` | exit 0; 19 routes |
| `pnpm run test:http` | exit 0; 15/15 pass, 0 skipped |

Preview ignores configured file storage, starts empty in memory and disables application sign-in before any cookie/database lookup. Valid cookies from an existing local database cannot grant Preview access. A real multipart write is denied without altering the file database. Vercel production database access fails closed with sanitized health 503. Persistent local behavior is retained. Migration SQL/checksums are unchanged; function tracing explicitly includes immutable migration assets.

Official Vercel deployment `dpl_4LAR9fCtjmRXddi8Yws5CbbtXNRn` is READY, from exact SHA above, `target: null` (Preview).
Verified URL: https://research-respondent-platform-hf3skhgcq-spw1.vercel.app
Actual authorized HTTP fetches: `/api/health` 200 with integrity `ok`, 4 applied migrations, no pending/drift, `isolated-preview`, `durable:false`, `signInEnabled:false`; `/login` 200 with the infrastructure notice and no email/password input; `/participants` followed its redirect to that same notice (final 200, no registry data). These are HTTP/content checks, not a browser usability test or an authenticated research flow.
Vercel protection readback: SSO enabled for `all`, password protection disabled. No bypass URL or secret was committed.

First deployment request failed with HTTP 400 because the API does not accept literal target `preview`. Corrected the request according to the official API: omit target to create Preview, then verified returned target null. Build log confirmed locked installation and successful build; Vercel used pnpm 10.28.0, unlike CI 11.7.0/local 11.25.0, and warned about the broad existing Node engine `>=22`. These differences are recorded, not hidden or reported as errors.

`docs/PERSISTENCE_PLAN.md` specifies provider evaluation, async driver/repository work, transaction and migration integrity, isolated stores, official authorization, backup/restore and release gates. No managed provider has been provisioned or tested. Issue #4 cannot be closed on infrastructure Preview alone. Public source visibility does not authorize research data exposure or production.

User requested `npx skills add smixs/pohuy` and `/pohuy ultra`. CLI installation exited 0; source `56a6277d44c91a8a102607f60fbc08aa0eaa99f2`, SKILL blob matched upstream and local validation passed. Project installation and lockfile are preserved with upstream MIT notice. Conversational style does not change code, permissions, provenance or safety gates. Separate user Skills-workspace push failed with HTTP 422; files are preserved locally, and Skills-page availability is not claimed.

Concurrent draft PR #6 (`codex/psychological-persona-integration`) is separate work. It has not been merged or overwritten; coordinate its documentation/schema changes before combining branches.

## Next three tasks

1. Review PR #7, then stacked PRs #8/#9/#10; retarget after accepted merges and coordinate overlap with PR #6. Do not overwrite its worker/schema; the dictionary copy remains byte-identical.
2. Obtain official storage integration/provider access, then implement and test the durable database, persistent worker/receipt boundary, multi-instance behavior and actual restore according to `PERSISTENCE_PLAN.md`. Current integration lookup is forbidden; do not infer billing or production approval.
3. With an explicitly authorized destination and source, verify the browser adapter on the actual form. Expand observed matrix/dropdown controls and documented instrument-item mappings in bounded tested slices; keep missing/ambiguous values blocked and no blind submission retries. Hosted AI dispatch/batch queues are still unimplemented.

## Working rules

Use one main agent. Work in bounded patches: inspect → patch → tests → documentation → commit → PR. Keep applied migrations immutable. Do not force push or write directly to main. No real responses may be replaced or filled with generated values. Every pass claim must name its tested source commit and actual command result.

## Browser workbench batch — 2026-10-10 UTC

Owner requested a usable first-trial site and linked the persona-skill shared chat. The shared URL was read successfully using HTTP and parsed shared messages; it describes PR #6 and the modeled-persona skill, not an attached empirical answer database. No records from the conversation or skill were substituted for actual answers.

Checked application source: `cfe539dc6224399f1496c71cac9333996a974c13`; PR #9: https://github.com/speway/research-respondent-platform/pull/9.
Modified/new: `app/workbench/page.tsx`, `app/page.tsx`, `app/login/page.tsx`, `components/{site-nav.tsx,workbench.tsx,workbench.module.css}`, `lib/domain/workbench.ts`, `tests/{unit/workbench.test.ts,http/preview.test.ts,browser/workbench.mjs}`, `tools/psychological-personas/references/dimensions.json`.

Preview home opens `/workbench`. This separate client workspace permits CSV/TSV/flat JSON import, criteria/classification, manual question mappings, a portable JSON agent packet and file-based project save/restore. Application sign-in is not required for this client workflow. Source records remain in tab memory and do not reach the server or research tables. Server research routes and production gates are preserved; no shared cloud persistence or actual Google Forms submission is claimed. See `BROWSER_WORKBENCH.md` for operator instructions and limits.

The dictionary is reused unchanged from PR #6 at `037bbbe1b0212d36627c51e51e5a094e17e2c861`; its Git blob `49846ebba67284f035a888dc6a646233fc6da9a7` was independently checked. 17 groups / 169 labels are searchable; selecting a label does not generate a measured response. PR #6 has not been merged/overwritten and its worker is not deployed by this batch.

| Check on source above | Actual result |
| --- | --- |
| Locked install with matching local Node headers | exit 0; lockfile unchanged |
| Lint / TypeScript | exit 0 / exit 0 |
| Unit and integration tests | exit 0; 181/181 pass, zero skips |
| Production build | exit 0; 20 routes |
| HTTP smoke on rebuilt artifact | exit 0; 16/16 pass, zero skips |
| Real Chromium/Playwright workflow | exit 0; full import/filter/map/download/hash/restore/origin/library/mobile flow; no page errors, POSTs or research writes |

Initial browser run timed out on the ID selector because a wrapped select label included its options; explicit accessible names fixed the boundary and the full run passed. The added MJS verifier initially failed lint on implicit globals; explicit Node imports and browser callback declarations fixed it. These failed initial runs are not reported as passing. Desktop/mobile captures were inspected; no horizontal page overflow at 390px.

Storage integration access is still HTTP 403. The client workbench provides immediate trials while the durable database and live form transport remain unresolved. Vercel SSO protection is retained; no production deployment was performed. Public GitHub source contains only disposable test fixtures and dictionary definitions, never actual participant records.

Application-source GitHub CI SUCCESS: https://github.com/speway/research-respondent-platform/actions/runs/38054284615. Actual job readback confirmed every install/native/lint/typecheck/test/build/HTTP step succeeded.
Protected Preview deployment `dpl_Hu5qCRMXDAt3w9XERiMbCrB2oJ8p` is READY on the checked application SHA, target null (Preview).
Stable deployment URL: https://research-respondent-platform-lro81x47q-spw1.vercel.app/workbench
Official protected fetch: workbench 200 with file-picker/menu and no password input; health 200 with integrity ok, four migrations, no drift, durable false and research sign-in disabled; participant route still redirects to the disabled research login (fetch final 200). Temporary official share access was prepared for the owner; its bearer URL is not recorded in GitHub.

## Agent automation batch — 2026-10-10 UTC

Owner requested a flow where an agent receives the source and form link and operates the panel itself. PR #10: https://github.com/speway/research-respondent-platform/pull/10 . Branch is `feat/agent-workbench-automation`, based on PR #9; PRs #6–#9 remain open and have not been overwritten or merged. Main is unchanged.

Initial executor source `19fd61eeba1f893a9bda94ad85800c610bcace5e` passed all local checks (190 unit/integration, 17 HTTP) and GitHub CI https://github.com/speway/research-respondent-platform/actions/runs/38056864815. Actual job readback confirmed both new browser-tool installation and browser workflows passed, in addition to locked install/native/lint/types/tests/build/HTTP.

Current checked application source: `9bf7661ae0987bc4651f029e1c9753479e6c3621`. The second slice adds published structural schemas, a contract-drift regression and the operator guide. Modified/new: `.github/workflows/ci.yml`, `components/{workbench.tsx,use-agent-workbench.ts}`, `lib/domain/{workbench.ts,agent-workbench.ts}`, `public/.well-known/{rrp-agent.json,rrp-agent-task.schema.json,rrp-observed-form.schema.json}`, `scripts/export-agent-schemas.ts`, `tools/browser-agent/{runner.mjs,file-journal.mjs}`, `tests/{unit/agent-workbench.test.ts,unit/agent-journal.test.ts,http/preview.test.ts,browser/agent-workbench.mjs}`; docs `AGENT_AUTOMATION.md`, `BROWSER_WORKBENCH.md`, README and historical handoff.

| Check | Actual local result |
| --- | --- |
| `pnpm install --frozen-lockfile` with matching local Node headers | exit 0; application dependency/lock files unchanged |
| `pnpm run lint` / `pnpm run typecheck` | exit 0 / exit 0 |
| `pnpm test` | exit 0; 191/191, zero skips |
| `pnpm run build` | exit 0; 20 app routes plus public manifest/schemas |
| `pnpm run test:http` on final rebuilt artifact | exit 0; 17/17, zero skips; manifest and both public schemas checked |
| Actual Chromium workbench regression | exit 0; existing source/filter/map/export/restore/origin/dictionary/mobile flow unchanged |
| Actual Chromium agent executor | exit 0; visible read → automatic mapping → literal two-section fill/verification → fixture confirmation; default no-write, missing-answer halt, malformed input preserving state, stale/concurrent commands, expired/out-of-scope grant denial, durable journal, uncertain result/repeat-submit denial, mobile; no page errors/POSTs/research writes |

The browser verifier uses an intercepted, explicitly isolated UI fixture, not a live Google Form. It was run against the production-built Next app and actual Chromium. No real source records, participant answers, credentials, cookie/session artifacts or receipt files were committed. The initial new JS lint failure was undeclared URL/window globals; explicit Node URL import and declared browser callback globals fixed it before passing verification.

`window.respondentWorkbench.execute` is a versioned same-tab bridge, not a remote public-data API. It accepts source tasks and visible-form observations, auto-selects an unambiguous ID header, matches exact IDs or qualified section/question labels, and validates literal answer/options/ranges. Bare headings are accepted only for a complete non-repeating map. No fuzzy match, topic-based answer inference or silently dropping incomplete records. CSV/restored-project modeled-origin denial closes the existing JSON-only gap. Every manual workspace edit invalidates the live observation; saved projects require a new read. See `AGENT_AUTOMATION.md` for shapes and behavior.

The portable browser executor supports text and single-choice questions and reobserves each section. An explicit grant binds recipient, one participant, source hash, expiry and authorization evidence reference. Submission also requires an atomic persistent journal; only visible response-recorded confirmation succeeds, and uncertain/reserved outcomes never automatically resubmit. This is local duplicate protection, not a distributed exactly-once guarantee; separate stores, changed hashes or URL variants are not reconciled.

Preview has no hosted model/background worker, multi-user persistence or batch queue. More complex controls/verified instrument-key mappings and live compatibility remain unverified. Existing server task permissions, migrations and production fail-closed gates are unchanged. Issue #4 and official storage-access HTTP 403 remain unresolved; no production or paid provisioning is authorized by this batch.

Final application-source CI SUCCESS: https://github.com/speway/research-respondent-platform/actions/runs/38057231467 . Actual job/step readback confirmed locked install, native SQLite, lint, TypeScript, unit/integration, production build, HTTP smoke, isolated browser install and both browser scripts succeeded.

Final protected deployment `dpl_4Re45WFV1EYUQz2XnnF9uTFb2eHo` is READY, target null (Preview), Git source `9bf7661ae0987bc4651f029e1c9753479e6c3621`.
URL: https://research-respondent-platform-p5gqj3uzd-spw1.vercel.app/workbench . Official protected fetches: workbench 200 with Automation menu/source picker and no password field; manifest and both schemas 200 with the expected protocol/strict object contracts; health 200 with integrity ok, four migrations/no pending/no drift, isolated-preview, durable false, research sign-in disabled; participant route still follows its denial redirect to the disabled login. These deployed checks are HTTP/content checks; actual interactive browser evidence is local and GitHub CI on this source.

Vercel protection readback remains SSO enabled for all deployments. An official temporary owner share link was prepared; its bearer URL is not committed. No production deployment, participant database, credentials or billing change occurred. Final documentation-only head CI must also be recorded in PR #10 after its actual completion.

## Form-control expansion and link reuse — 2026-10-10 UTC

PR #11: https://github.com/speway/research-respondent-platform/pull/11 . Branch
`feat/form-control-expansion` starts from PR #10 head
`dccc2e884a7c1b2553e262e2a6cad0fa7b821693`. Checked application source:
`4b67d35eacf771366398f2a661892e0a9759820a`. Existing stack #6–#10 remains
open; main and immutable migrations were not changed.

Modified: `.github/workflows/ci.yml`, `components/{workbench.tsx,use-agent-workbench.ts}`,
`lib/domain/agent-workbench.ts`, public agent manifest/observation schema,
`tools/browser-agent/runner.mjs`, package/lock. New:
`tests/{unit/agent-controls.test.ts,unit/cloud-audit.test.ts,browser/agent-controls.mjs}`,
`lib/services/cloud-form-audit.ts`, `tools/cloud-agent/audit-entry.mjs`,
`scripts/audit-cloud-form.ts`, `docs/CLOUD_AGENT.md`; agent/workbench guides,
README and historical handoff updated.

| Check | Actual local result on application source |
| --- | --- |
| Frozen install with matching local Node headers | exit 0; pinned `@vercel/sandbox@3.6.1` added with lock update |
| `pnpm run lint` / `pnpm run typecheck` | exit 0 / exit 0 |
| `pnpm test` | exit 0; 197/197 pass, zero skips |
| `pnpm run build` | exit 0; existing 20 routes, no new anonymous submission/start endpoint |
| `pnpm run test:http` against final production build | exit 0; 17/17 pass, zero skips |
| Actual Chromium: existing workbench and executor scripts | both exit 0; previous receipts/grants/uncertain-submit defenses retained |
| Actual Chromium: new controls script | exit 0; intro traversal/read-only audit, labeled radio/checkbox rows, clearing extra checkbox draft selections, exact comma-containing options, native/accessible dropdowns, number bounds, known finite radios alongside Other, missing-draft refusal, link-only reuse/stale-map invalidation, accessible URL action, 390px no overflow; no fixture submit |
| `git diff --check` | exit 0 |

Initial verification failures were an escaped-quote fixture lint error and missing
local Chromium; fixed before passing. Direct Playwright browser CDN retrieval
returned invalid/truncated archives in this environment. A pinned reputable npm
Chromium distribution was used outside the application for local browser checks
(Playwright 1.62.1, Chromium 153). CI retains standard Playwright Chromium install;
its result must be read independently. No runtime browser package was added to
the application. Sandbox setup/browser-install tests use injected lifecycle
fixtures, not a real provider VM.

`target` retains configured source/hash/ID/reference/purpose/criteria and removes
old fields/observations, even for the same URL. It refuses an unconfigured source.
The external executor can receive `formUrl` instead of reloading a task. A link
still cannot supply participant answers, select a different person or authorize
a new recipient. Multi-choice cells use explicit nonempty JSON-array strings;
raw cells are preserved. Matrix row labels must be explicit/unique, and each row
maps separately. Unlabeled/custom layouts, free Other text, hidden validation and
one-per-column restrictions remain unsupported or stop on UI validation.

Live UI audit, using the already provided form link: read the introductory page
and clicked Next without entering answers; reached page 2/6, first factual
section containing six questions. Visible DOM readback confirmed level-3 headings,
listitem containers, exact radio labels and two Other-text alternatives. No
factual answers were available for the subsequent required questions, so no
values were entered and no response was recorded. This verifies live access and
structure inspection, not a complete production-executor submission or matrices
on that particular live form. No account sign-in/CAPTCHA bypass was attempted.

Cloud reader: bounded 5-minute/one-vCPU/nonpersistent VM, no exposed port/source
records/model credentials; official deployment OIDC; pinned browser setup;
network tightened before form reading; atomic one-run budget reservation before
allocation; cleanup on success/failure; invalid/oversized/foreign result rejection.
No permanent hosted agent, queue or paid resource was provisioned. Official
metadata lists zero named sandboxes and zero project envs; team metadata does not
expose quota/billing plan. AGENTS.md rule 7 requires explicit permission for paid
services. The prepared run is documented in `CLOUD_AGENT.md`. Current production
fail-closed and Preview disabled research sign-in remain unchanged; Issue #4's
durable source/receipt storage remains unresolved.

Application-source CI started: https://github.com/speway/research-respondent-platform/actions/runs/38075275395
(currently in progress; do not treat this as success). Protected Preview build
`dpl_6AwG991KcnWRKKvyhAszP3XKvRdG` targets null/Preview at
https://research-respondent-platform-77lkhzfh8-spw1.vercel.app/workbench , pinned to
the application SHA above. Actual final CI/Preview readbacks will be appended.

Next three tasks:
1. Obtain a concrete owner-approved budget and run the prepared read-only cloud
   audit through official auth; verify boot/install/Google read/VM stop and record
   actual evidence before claiming hosted runtime readiness.
2. Configure approved durable storage plus authenticated source/consent selection,
   atomic shared receipts/budget reservations and a bounded on-demand queue worker;
   keep participant sources encrypted with explicit retention.
3. Verify complete live filling/submission only with provided factual responses
   and explicit recipient/participant permission; extend the reader only from
   independently observed unsupported control layouts.

Final application-source CI SUCCESS:
https://github.com/speway/research-respondent-platform/actions/runs/38075275395 .
Actual job readback confirmed every step, including locked/native install,
lint/types/tests/build/HTTP, standard Chromium install and all three browser
scripts. Preview `dpl_6AwG991KcnWRKKvyhAszP3XKvRdG` is READY, target null, Git
source `4b67d35eacf771366398f2a661892e0a9759820a`.
Official protected HTTP checks: workbench 200 with Automation and no application
password input; manifest 200 with link reuse/matrix/multiple-choice capabilities
and hosted worker/source upload/submission still false; observation schema 200
with matrix and multiple-choice fields; health 200 with integrity ok, four
migrations/no pending/no drift, isolated-preview, durable false, research sign-in
false. Project readback: SSO enabled on all deployments; password protection
explicitly disabled (the metadata object itself is not an enabled boolean).

Auto-review rejected the protected deployed `/participants` request as a
potentially sensitive participant-data route through temporary auth access.
The initial non-JSON rejection was inspected as a parse failure and the request
was inadvertently repeated once; both rejected, no data returned. No bypass or
further retry was attempted. Local production HTTP tests independently verified
this route's disabled Preview access. Do not report the deployed participant
route as tested in this batch. No paid provisioning, live response submission,
production publish or respondent source upload occurred.

Cloud Browser also opened the protected workbench through official temporary owner access: the actual Preview rendered Respondent Lab, all six navigation items and source picker, with no application email/password fields and no loaded participant data. The owner link expires according to the provider and is not committed. Final documentation-only head CI will be recorded in PR #11 after completion.

## Follow-up: freeze source context throughout execution — 2026-10-10 UTC

Documentation head `19dd5c9e4d1752c4de55ef25881983bd7d17406a` also passed
all CI steps (https://github.com/speway/research-respondent-platform/actions/runs/38075572646).
Final review found a real race: a source changed between section reads could be
adopted by the next observation, while the grant still referred to the original
source. The executor now binds the run to its starting source hash, URL and
revision, permits only its own observation revision increments, freezes its
local grant copy and checks context after progress callbacks before fill/Next.
Async progress callbacks are awaited. Any external load/target/clear/filter/map
edit stops the run. Actual Chromium regression changes the source during intro,
preparation and verified-fill callbacks and verifies failure before subsequent
navigation/submission; no fixture submit. Existing grant/receipt behavior remains.

Modified `tools/browser-agent/runner.mjs`, `tests/browser/agent-controls.mjs` and
this continuation. Rechecked frozen install, lint, TypeScript, 197/197 tests,
production build, 17/17 HTTP and all three actual Chromium scripts: exit 0,
zero skips. This follow-up must be saved/deployed and its official commit/CI
read back before referring to the final Preview as including the context guard.
No additional resources, participant values or live submissions were used.

Final checked application source (including the context guard):
`385ff58363e4859c587ce5bea10014a98f730f90`.
CI https://github.com/speway/research-respondent-platform/actions/runs/38075783934
SUCCESS; actual job readback confirmed every step including all three standard
Chromium workflows. Final protected Preview `dpl_8TJ8nGC3eKg3ncmjU3TQWi7P6v8K`
is READY, target null, pinned to this source:
https://research-respondent-platform-cq60fyy2n-spw1.vercel.app/workbench .
Authorized workbench/manifest/observation-schema/health fetches all returned 200;
manifest retains `hostedBackgroundWorker:false`, upload/submission false;
health retains integrity ok, 4 migrations/no drift, durable false, sign-in false.
Actual Cloud Browser rendered the final empty-source panel and all six menu
items without application registration fields. Official owner access is temporary
and its bearer URL is not committed. Sensitive-route checks were not retried.

PR #11 is ready for review and based on PR #10; main still
`dabed376d36080bc31e466f6907c7172faab2e06`. No merge, production deployment,
paid provisioning, source upload or live response submission occurred. Final
documentation-head CI outcome will be recorded in the PR body after completion,
without triggering a further documentation commit solely to record that commit's
own CI. Next tasks remain the owner-approved one-run cloud audit, durable
protected queue/source/receipt integration, and a consented full live form test.

## Cloud runtime verified; open primary panel requested — 2026-10-10 UTC

Continuation branch `feat/cloud-runtime-validation` starts from PR #11 head `349cd0d30f5442db387e2966eda55b636f17e861`; GitHub reservation commit `89c4eca565671886b3f58494507686af006cb778` preceded one explicitly approved VM allocation. `docs/CLOUD_RUNTIME_VERIFICATION.md` records actual command failures/repairs, successful sandboxed browser read of section 2 of the live supplied form, exit 0, no answer writes/submission, and independently verified cleanup in 239781 ms. This is real provider/browser evidence; it is not a hosted SDK/OIDC Function, participant worker or full live-form compatibility claim.

Changes: `lib/services/cloud-form-audit.ts`, new `tools/cloud-agent/prepare-ubuntu.mjs`, new `read-only-policy.mjs` and declarations, `audit-entry.mjs`, traced tool assets in `next.config.ts`, new private budget journal, pinned `@vercel/blob` 2.8.1/lock, cloud/setup/network/budget tests. The deployment path uses static policy imports and files under application cwd. Approval expiry is rechecked after a slow reservation before allocating. Provider create-only journal failures stop allocation; no distributed provider claim is asserted without a real storage collision test.

The owner explicitly requested an open primary site and reauthorized all project work after the infrastructure permission rejection. Public cloud homepage now redirects to `/workbench`; that data-free client panel is accessible in production as well as Preview. Server session/RBAC and SQLite production blocking remain intact; no participant source is uploaded or automatically stored. Production HTTP tests verify panel 200/no password fields/home redirect, protected research redirect and DB health 503. Public release will use only the checked Git commit and the existing project/team/domain; Preview and unique deployment URLs should remain protected.

Actual local final application checks: frozen install exit 0; lint and TypeScript exit 0; 204/204 unit/integration tests, zero skips; production build exit 0; 17/17 HTTP tests, zero skips; all three actual Chromium scripts exit 0 on isolated fixtures. Initial lint found missing Node console/URL globals and was corrected through explicit Node imports/stdout; no ignored failures. Chromium was restored from verified pinned npm package after scratch `/tmp` cleanup. The React review retains cheap hosting guards before auth awaits, adds no client/backend SDK imports, and preserves UI/hooks/accessibility.

Storage: initial new-store request was rejected by auto-review for separate billing scope; after the owner's explicit reauthorization, the official request returned Vercel 403. No Blob store, anonymous paid route or recurring resource was created. CLI unavailable; dashboard shows sign-in, with no credential entry. Permission is already granted; service access is the remaining blocker. The prepared journal contains only immutable budget hashes, not answers or identities. Hosted background execution and server source storage remain false.

Next three tasks: (1) verify GitHub CI and protected Preview, then publish/read back the data-free primary panel with protected preview/unique URLs; (2) complete official storage authorization and test immutable private reservations under actual concurrency before enabling an authenticated queue; (3) connect durable source/consent/receipt lookup and run an explicitly consented full live-form task using factual answers.

### Verified primary release and source CI

Checked application commit: `92912a389e5819c050870d89b146e39b9322bb3c`.
GitHub CI https://github.com/speway/research-respondent-platform/actions/runs/38080225043
SUCCESS: actual job readback confirms locked install/native binding, lint/types,
204 tests, production build, 17 HTTP checks, browser installation and all three
actual Chromium workflows succeeded. PR #12 is ready and mergeable, based on
PR #11: https://github.com/speway/research-respondent-platform/pull/12 .
Main branch was not changed; the owner-authorized public release is pinned to
the reviewed task-branch application source.

Protected Preview `dpl_Bdx7NHduZ2nZxA6gGfYraD8mBz4t` is READY, target null, pinned
to that source: https://research-respondent-platform-4cjnlbwjs-spw1.vercel.app/workbench .
Official protected panel/manifest/schema/health checks returned 200; health
confirmed isolated-preview, durable false, sign-in false, integrity ok and four
migrations with no drift. Sensitive research routes were not fetched remotely.

At the owner's explicit request, data-free production panel deployment
`dpl_91rXUEvZnKBkMw5vzmdVCo8Df394` is READY, target production, same source.
The existing primary alias was assigned and official readback binds it to this
deployment/project. Project SSO is enabled with
`prod_deployment_urls_and_all_previews`: primary aliases public, previews and
unique production deployment URLs protected; password protection disabled.
Canonical site: https://research-respondent-platform.vercel.app/workbench .
Fresh unsigned Cloud Browser navigation from `/` reached that exact URL and
rendered the six-item menu/source picker, no application/Vercel login. Automation
tab rendered the live protocol controls; no data loaded or writes performed.
Independent curl with no cookie/auth/bypass returned HTTP 200 at the same
post-redirect URL, panel text present, password fields and Vercel login absent.
No participant database or responses were published. Production research DB
health remains intentionally unavailable (public panel works without it).

Only a documentation commit follows this application source; its CI will be
recorded in PR metadata after actual completion. Existing owner authorization
for storage and further development persists; the remaining blocker is provider
403/service sign-in, not missing blanket permission.

### Official authentication continuation — after primary release

Documentation head `b04ce05e80a32c0b093a32c59243a14ec47134ba` CI run
38080517227 SUCCESS; every job step independently read back. Unauthenticated
Preview curl returned 302 to protection, while canonical primary panel returned
200; public production DB health returned the intended 503 generic refusal.
The owner selected Google using secure browserAuth. Identifier/password entry
was handled by the native protected credential surface; no values were read,
stored or logged by the agent. Google reported an incorrect password, so Vercel
service sign-in is not established. An official browser handoff is being
prepared for this specific authentication blocker; do not retry credentials or
switch methods automatically. Storage and hosted background queue remain
unconfigured; the primary site continues to work without registration.
The following documentation-only commit does not change deployed app source.

## Private cloud journal continuation — 2026-10-11 Asia/Tashkent

Owner completed official Vercel sign-in and reauthorized project continuation.
The existing handed-off browser visibly opened the authenticated Storage page.
Created `rrp-cloud-audit-private`, private, IAD1, ID `store_F58ZIfpJrCilBpT3`;
connection readback confirms exactly `research-respondent-platform`, Preview only,
OIDC, BLOB_STORE_ID/BLOB_WEBHOOK_PUBLIC_KEY, no read-write token env requested.
Official env metadata independently confirms the two Preview variables. Provider
catalog GET still returns 404 for the visible store; do not call that success or
create a duplicate store. Native UI checkbox hit testing failed; visual targeting
and refreshed state confirmed Production unchecked before connection.

Branch `feat/private-cloud-journal` is stacked on PR #12 official head
`cda304ceed923cd2674f77423a36c0c9653d3d3c`; local checkout preserves that source.
New preview policy requires VERCEL=1, VERCEL_ENV=preview, an explicit diagnostic
flag and a valid store ID. `/cloud/setup` is absent in production/unconfigured
Preview; server action repeats the guard and Next enforces same-origin POST.
Only this branch's Preview flag is configured; official first env request failed
because the branch did not exist, then succeeded after official branch creation.
The existing project must retain SSO protection for Preview deployments.

The bounded probe reserves one immutable marker before eight concurrent claims,
requires exactly one acknowledgement/seven rejections, reads the marker back,
checks anonymous private-URL denial and repeat rejection, persists and rereads a
strict small report. Existing reports are read-only; failed/uncertain probes do
not allocate a VM or retry. No respondent source, answer, cookie, token or raw
provider error is returned. This is not a participant database or a background
worker; manifest capabilities remain false until those paths are verified.

Files: new cloud-preview-policy/private-cloud-probe services, cloud setup page
and action, Preview-only workbench link, unit fault/concurrency tests and HTTP
route/direct-action denial tests. Initial TypeScript nullable-return and misplaced
HTTP-test variable errors were fixed before final checks. Frozen install exit 0;
final lint/types exit 0; 208 unit/integration tests and 18 HTTP checks, zero skips;
production build exit 0. All three existing actual Chromium fixture scripts
passed (no live response submissions). Provider probe/deployment/CI remain pending
at this commit; their actual results will be appended after readback.

Next three tasks: (1) deploy protected Preview and execute/read back the actual
OIDC storage probe; (2) connect and verify bounded durable hosted read-only form
execution; (3) integrate a protected consented source/receipt store before any
factual participant form submission. Main remains the last verified public,
data-free workbench. No participant data was published.

### Actual provider probe and CI readback

Checked application SHA `a32fdd1b38d35446601894257cf2663266dbdc40`.
CI run 38081968153 SUCCESS; every job step, including the three Chromium
workflows, independently read back. Protected Preview
`dpl_qgcxsb57nGmeuxkBCSJ5EbNuqCms` READY, target null, same pinned source:
https://research-respondent-platform-90o7zl4x5-spw1.vercel.app/cloud/setup .
The already authenticated owner browser opened this page directly, clicked the
one-time server action, and observed the persisted report at
2026-10-10T20:00:55.628Z: contenders=8, acknowledged=1, rejected=7, privateRead,
anonymousReadDenied, repeatDenied all true. A subsequent browser DOM observation
read the report from the refreshed page, not the action return value alone.
Screenshot `docs/evidence/private-storage-probe.jpg` contains only operational
status (no credentials, private URLs or respondent records).

An additional connector HTTP check was rejected by auto-review because that tool
would create a temporary authentication-bypass link. No bypass was created or
retried. This does not invalidate the actual official-login browser evidence.
The owner then requested fewer repeated checks; subsequent stages use one final
check pass and one actual deployed flow, with further runs only to fix failures.

Hosted Workflow SDK setup is the next separate coding batch, not yet deployed
by this verified store change. Installing pinned workflow 5.2.0 identified three
compiler build scripts requiring explicit package-manager allowBuilds entries;
that repair and its application code belong to the next branch/PR.

## Hosted read-only Workflow batch — 2026-10-11 UTC

Continues Issue #4 on `feat/hosted-read-only-workflow`, based on verified PR #13
head `beb4b2831282946a5c570508e6711d24e394055f`. On resumption the scratch checkout
contained older PR #11, with none of the uncommitted Workflow files or logs from
the prior runtime. Recovered the exact GitHub branch through authorized git
fetch, then restored this bounded implementation; earlier check claims were not
reused as verification of different files.

Pinned Workflow 5.2.0 and compiler build approvals, wrapped the existing Next
configuration without changing SQLite or migrations, added one non-retrying
read-only Workflow step and owner-configured Preview launch/status routes.
Immutable private launch markers/receipts prevent concurrent or uncertain
enqueue retries. The independently verified storage report is required before
launch. Production/unconfigured routes stay 404; same-origin POST ignores
client-supplied scope. The worker repeats configuration/store gates before the
existing bounded 5-minute/1-CPU/nonpersistent sandbox reader. No participant
answers, filling or external response submissions are enabled.

The same branch-scoped approval reference `owner-2026-10-11-hosted-reader-1` is
retained; its expired value was renewed to 2026-10-11T09:00:00Z following owner
continuation. No budget marker was deleted and no additional allocation scope
was created. Preview SSO remains enabled. Public main panel was opened in the
actual browser without registration; the authenticated browser also read the
saved storage proof directly from PR #13 Preview.

Changed: generated ignores; package/lock/compiler approvals; next.config;
hosted-cloud-audit service; workflows/cloud-form-audit; app/cloud/audit route;
cloud/setup launch/status UI; four concurrency/expiry/uncertainty unit tests;
HTTP refusal coverage; README and hosted/external-agent trial docs.

| Actual check on restored application source | Result |
| --- | --- |
| Frozen install | exit 0 after explicitly allowing compiler scripts; initial add exited 1 on approvals |
| Lint / TypeScript | exit 0 / exit 0 |
| Unit and integration tests | exit 0; 212/212, zero skips/failures |
| Production build | exit 0; 24 routes including Workflow and scoped audit routes |
| Production HTTP smoke | exit 0; 18/18, zero skips/failures |

Do not call this a verified hosted runtime until provider execution, actual
Google read, result readback and VM cleanup are observed. CI will run the three
canonical Chromium fixture checks once; no extra local browser repetition was
done for these server-only changes. Manifest's general hosted worker/source
upload/submission capabilities remain false.

Next three tasks: (1) save/open stacked PR, deploy pinned protected Preview and
verify one actual hosted read-only run; (2) implement a protected durable consented
source/receipt store and recovery before participant submission; (3) verify full
live transfer using an actual supplied source and recipient scope. Factual
records for this form have not been supplied. The standalone agent prompt is in
`docs/AGENT_TRIAL_PROMPT.md`.

### Actual hosted execution and cleanup

Checked official application SHA `bbdbf0d819d7b9f76e472df72b3e2c2a2143bcbd`;
Git tree `0e4704de84e68d0ef97638650640852dfde2c743` exactly matches the locally
tested source. Ordinary git push could not access username credentials; no token
was requested or copied. Published this same tree through the connected GitHub
create-tree/commit/ref tools, then opened PR #14 stacked on #13:
https://github.com/speway/research-respondent-platform/pull/14 .
The initial PR/deployment attempts before that official publication were rejected
as no commits/unknown SHA; corrected publication, not an unchanged retry.

CI run 38119160588 SUCCESS; actual jobs readback confirms every step including
locked/native install, lint/types/212 tests/build/18 HTTP and all three canonical
Chromium scripts. Protected Preview `dpl_GYUvrEMwkF1dN5DXG9okGJjcTs5x` READY,
target null, pinned to the same SHA:
https://research-respondent-platform-irw1ibrds-spw1.vercel.app/cloud/setup .
Official Settings UI confirmed System Environment Variables enabled. The owner
browser read persisted private store evidence and `not_started`, clicked launch
once, then read `pending` and closed the launch tab. No auth bypass was used.

Official runtime logs register `wrun_41M4MVJA5T0GYDSD337QJP5V9K` at
2026-10-11T06:49:23.258Z, start the queue-driven step at 06:49:24.563Z and
complete it at 06:50:11.250Z with section=2/questions=6. A new browser tab after
closure read the persisted receipt/managed run and rendered `completed`, section
2, six questions. The controlled reader returns externalSubmission=false and
never receives actual source records. This verifies live hosted SDK/OIDC read
of the supplied Google Form independently of browser tab lifetime.

Provider Sandbox detail shows `olive-thirsty-raven-Au65tE`, Stopped, ephemeral,
IAD1, one CPU/2 GiB, five-minute timeout, 45-second total duration, 38-second CPU
time, no mounted drives; its activity records requested stop and successful
completion at 06:50:09Z, before the Workflow's return. No repeat allocation was
made. Screenshot `docs/evidence/hosted-workflow-proof.jpg` records only operational
status, no source rows, secrets or private Blob URLs.

An attempt to open the raw JSON result in Cloud Browser was blocked by its URL
protocol policy. It was not retried via a workaround or alternate transport.
Do not claim that raw JSON navigation was verified. The HTML summary and official
runtime/Sandbox readbacks above are the observed result and cleanup evidence.

General hosted filling, source/consent storage, participant database recovery and
full live submissions remain unresolved; Issue #4 stays open. Main public panel
is unchanged and accessible without registration; no production participant
data was deployed. Next three tasks: durable protected source/consent/receipt
integration; authenticated source selection plus scoped multi-section execution;
complete live transfer once actual source records/recipient consent are provided.

## 2026-10-11 — Persistent cabinet and scoped server source handoff

Branch `feat/shared-scenario-cabinet` continues canonical PR #14 documentation
head `2183e2701eba22d7fcce5a2d344fc3c75a94bbc1`; no project restart or SQLite
migration edits. Latest screenshot showed the external agent had no source in
its own tab. A private file cabinet now addresses cross-tab/source handoff:
owner/shared issued-account login, original source and questionnaire upload,
immutable project settings, existing workbench restore/filter revision, scoped
24-hour read keys and revocation. Exact endpoint/storage boundaries are in
CABINET.md and site-served agent-cabinet.md. Questionnaire extraction is not
claimed; originals are supplied to a capable agent.

Files: new cabinet domain/store/auth/http/proof services, cabinet UI/CSS/page,
three authenticated API routes, Preview-only bounded provider proof routes,
isolated integration tests and HTTP refusal checks; small existing workbench,
bridge/navigation, manifest, ESLint generated-file exclusion and env-example
updates. Original importer, form executor, research gating and migrations remain.

Actual local checks: frozen install exit 0; lint exit 0; standalone TypeScript
exit 0; 221/221 unit/integration tests exit 0, no skips/failures; production build
exit 0 (30 routes); 19/19 production HTTP smoke tests exit 0, no skips/failures;
diff whitespace check exit 0. Initial lint exposed generated Workflow routes
(previously Git-ignored but not ESLint-ignored), now explicitly excluded. Initial
types/build failed on the proof fixture hash literal type and an HTTP helper
without a headers property; both corrected and final checks passed. Manifest's
source-upload capability is now authenticated-cabinet only; general hosted
participant execution/submission remains false. CI/provider readback pending.

Official Vercel create-store connector returned 403; no local authenticated CLI
was available. The already authorized owner dashboard created the separate
private IAD1 `rrp-cabinet-private` store `store_PosjkntwlBmxdQZu`, initially empty.
Connected only the existing research-respondent-platform project to Preview and
production through official OIDC, sensitive prefixed variables, no permanent
read-write token, no old-store overwrite. Metadata readback confirms prefixed
store variables on these targets. Sensitive account configuration contains only
scrypt hashes; Preview is branch-scoped and separate from production. Plaintext
access values are returned privately to the owner, never Git or logs. Preview
proof flag is branch-scoped; it never exposes a production verification route.

No real participant base was supplied or uploaded. The provider proof uses a
separate isolated verification prefix, not user cabinet rows or live forms. This
is a private source/file catalog, not a completed relational migration; Issue #4
remains open. Next three tasks: publish this tested tree and verify the single
protected cloud proof; update the primary empty-data deployment and verify both
issued accounts; integrate source-bound consent/receipt storage with hosted
participant execution after actual source data and recipient scope are available.

### Actual cabinet provider, CI and primary deployment readback

Checked application SHA `1d4985ae08b55bcd83839c70950cc00a8f2c5590`; Git tree
`536fcc430db2380f0f08cc00247da977e8585b7a` exactly matches the checked local source.
Published through official GitHub tree/commit/ref tools, PR #15 stacked on #14:
https://github.com/speway/research-respondent-platform/pull/15 . PR mergeable=true.
Local Git was reconciled to this official head only after asserting identical
trees and a clean worktree; the local signature-different checkpoint is retained.
CI run `38121711092` succeeded on every step, including the locked/native install,
lint/types/221 tests/build/19 HTTP and all three canonical Chromium checks.

Vercel automatically started the exact Git SHA. The additional manual queued
Preview `dpl_Buqg969pwMxUMxXmLTxi2vpekSXt` was canceled before building to avoid a
duplicate. Actual READY protected Preview is `dpl_BAymqmj1aQJsxu2dfRf5DHfQGXAB`,
target null, pinned to the application SHA above:
https://research-respondent-platform-lb7p3p0tz-spw1.vercel.app/cloud/cabinet-check .
The owner browser launched the single bounded proof once. At
`2026-10-11T07:34:47.447Z` it persisted status verified with nine checks: private
source persistence, literal source readback, questionnaire download, project key,
new service instance readback, account isolation, key revocation, session login/
logout and provider ETag updates. Closed the launch tab; a newly opened tab read
the persisted result. No external form was contacted or submitted. Software
fixtures live only under isolated-verification and cannot be loaded by ordinary
owner/team cabinet accounts. Operational screenshot: docs/evidence/cabinet-cloud-proof.jpg.

Production `dpl_4oitzYStTr64Jt4uqKd3jHY2ajPy` is READY, target production, pinned
to the same checked application SHA. Its generated aliases were updated, but the
previous manually assigned primary alias initially still pointed to the old
`dpl_91rXUEvZnKBkMw5vzmdVCo8Df394` (actual /cabinet 404). Read ownership through
get-alias, assigned the existing primary alias to the new owned deployment via
official API, then independently read back the matching project/deployment IDs.
The browser reloaded and rendered the issued-access cabinet login at:
https://research-respondent-platform.vercel.app/cabinet .
No Vercel protection was disabled and no auth-bypass link was used.

Actual HTTPS verification on that primary alias, exit 0: both issued owner/team
credentials sign in (200), a new request recognizes the session (200), private
catalogs return 200/no-store and contain zero assets/projects/keys, logout returns
200 and the previous cookie then returns 401. Both cookies have HttpOnly/Secure/
SameSite=lax. Public workbench/cabinet/manifest/site guide return 200; anonymous
catalog and agent API return 401; production cloud proof page returns 404. No
participant file was uploaded in production. Passwords were returned only to the
owner, never committed, persisted as plaintext or printed by the verifier.
Screenshot docs/evidence/cabinet-main.jpg records the public login UI, no secrets.

The resulting flow is one-time upload → project → scoped key/generated prompt →
agent reads saved source and questionnaires. The file catalog is operational;
legacy relational migration, individual collaborator attribution, document
extraction, receipt/consent recovery and hosted participant execution remain open.
No factual source dataset for the supplied Google Form has been provided. Issue
#4 remains open; Issue #2 is already closed and Issue #3's implementation is in
the earlier stacked PR. Next three tasks: integrate source-bound consent/receipt
persistence with execution; verify a complete live transfer after actual records
and recipient scope are provided; complete relational migration and per-user roles.

## 2026-10-11 — respondent bank accumulation and agent source readiness

Checked starting commit: `3275ee2de69ab2ffe4fe74ed8447646c3d171be9`, PR #15
open/mergeable. Task branch `feat/respondent-bank-versions` continues it; no
project restart, migration/checksum changes or participant data. The owner asks
for accumulating previous respondents and easier agent access, then explicitly
steers toward improvements to site functionality and agent interaction.

Added pure `respondent-bank.ts` planning: exact merge, profile left join, stable
participant/session tuple keys, identical intra-file deduplication, explicit
conflicts, missingness preservation and combined limits. Existing importer is
reused. Private service commits reload original source bytes and bind the preview
hash to specification/parent hashes/result. One create-only approval reservation
publishes at most one version. Successful replay returns it; uncertain incomplete
publication stops. Original files/projects stay immutable. Lineage is persisted,
hashed/read back before indexing, scoped to the selected source for agent reads;
parent files are not granted. Original downloads require cabinet authentication.

New cabinet bank component supports file/ID/session-key selection, preview counts,
conflict blockers and immutable creation, selects the result for a new project,
with CSV header-only templates. The file list allows downloads/history. Agent
bundles add readiness counts/blocker codes, source download and lineage links.
Public manifest/JSON schema/site guide and RESPONDENT_BANK.md describe contract,
formats and boundaries. The existing browser executor is preserved, including
per-section observation, exact mapping, source-bound grants and receipt rules.

Actual local results: `pnpm install --frozen-lockfile` exit 0; standalone types
exit 0; final lint exit 0; 234/234 unit/integration tests exit 0, no skips/failures;
production build exit 0, 30 routes; 20/20 HTTP tests exit 0, no skips/failures.
Initial lint found browser-test globals and redundant test string escapes, fixed.
Initial new unit assertion expected an empty CSV string, but existing importer
correctly represents empty cells as null; assertion corrected, importer preserved.
New integration cases prove preview no writes, exact provenance/reopened readback,
conflict/stale/account refusal, failure before publication, concurrent replay-safe
commit, agent scope and tampered lineage refusal. New Chromium UI scenario covers
upload/merge/edit-invalidation/project/agent/conflicts/profile join/mobile. Local
launch was blocked before UI by absent Chromium; CI installs its pinned browser.
No claim of a local browser pass, deployed merge pass or live form submission.

New files: domain planner, UI component, public command schema/two templates,
RESPONDENT_BANK.md, unit suite and browser scenario. Modified: private cabinet
service/domain/API, cabinet UI/CSS, agent manifest/guide, HTTP/integration suites,
CI browser step and continuation/handoff documents. Final tiny prompt change and
documentation are being validated by the pending exact-head CI; do not interpret
these local counts as proof of a later unchecked Git head.

The bank is immutable versioned tabular files, not a global editable participant
registry or PostgreSQL migration. No factual response base has been supplied in
this coding turn. Individual invitations, document extraction, verified consent,
full live response transfer and always-running submission remain unimplemented;
Issue #4 stays open. Next three tasks: verify exact-head CI and Preview, release
the checked application to the existing site, then integrate consent/receipts
with hosted execution after documented actual responses and recipient scope.

### First exact-head CI and accessibility repair

Published application/checkpoint SHA `66dd7dfad8370a57d431a5523c44ea1055d7d70a`,
tree `56156178730b7cded13bac1684c1a5a36af06d62`, PR #16 stacked on #15. CI
`38140059491` passed install/native module/lint/types/234 tests/build/20 HTTP and
all three existing Chromium scenarios. The new cabinet scenario failed waiting
for an exact label on the first source select, before merge. Added explicit
accessible labels to dynamic bank/project selects, a per-upload visible-file
wait and redacted isolated-fixture diagnostics. The failure is recorded; the
new flow is not claimed verified until repaired-head browser CI succeeds.

One exact-SHA Preview `dpl_Eit3ctoyxfAzBvkJuyeZMPsTxxMM` is READY at
https://research-respondent-platform-d5axmtt7v-spw1.vercel.app/cabinet . Official
env metadata showed cabinet account hashes only on the prior Preview branch;
moved that existing sensitive Preview configuration to the active task branch
via metadata-only edit, without reading/changing its value or production hashes.
Normal owner browser reached the protected cabinet HTML; primary still points
to the previous verified application. No protection/bypass changes. Local
Playwright installation could not obtain a valid vendor archive, so no local
Chromium run was achieved; no network-path workaround was attempted.

### Verified respondent bank release

Checked application SHA `e2e1d75b84c25ef3f3b922825ee0aa5e65193033`, tree
`064b73bcfaad09627aa08b4bdfbc2de8bc302c81`. CI `38140457025` / job
`114473090696` succeeded on every step: install/native module/lint/types/234
unit-integration tests/build/20 HTTP and all four actual Chromium scenarios.
Job log independently confirms the new cabinet flow: upload → preview edit
invalidation → persisted bank version → project → scoped agent/lineage;
conflicts, profile join and mobile passed. The new browser transport is an
isolated in-memory service fixture, not a live provider merge or Google Forms
submission. Previous three browser scenarios also passed.

Actual exact-SHA protected Preview `dpl_7wfndkJXrECaDrx55y7ivq8zMCm9` READY,
target null, owner browser cabinet HTML verified at
https://research-respondent-platform-9c4qpxjbc-spw1.vercel.app/cabinet . No bypass
or protection weakening. Production `dpl_9LtUDFDRKwptSYr6ZczXMkNs8u6Y` READY,
target production, same checked application SHA, released through the official
API. Existing primary alias assigned to it and independently read back matching
project/deployment IDs. Production account configuration/passwords were unchanged.

Actual HTTPS verification on https://research-respondent-platform.vercel.app,
exit 0: cabinet/workbench/two CSV templates/command schema/agent guide return 200;
manifest advertises this branch and bank/readiness features. Both issued accounts
login, maintain Secure/HttpOnly sessions and read private/no-store catalogs;
logout invalidates each session. Owner catalog contains four previously uploaded
source files, shared catalog zero; neither contains a project at this observation.
No file contents/answers or credentials were printed, uploaded or overwritten by
this verifier. Valid bank-preview commands for nonexistent source UUIDs return
404 in both accounts without creating data. Anonymous catalog and lineage API
return 401; production proof stays 404. These facts supersede the earlier empty
owner-catalog observation, which predates the owner's uploads.

Owner's existing browser session independently rendered the new bank section,
with the four source files still listed. Screenshot docs/evidence/respondent-bank-main.jpg
contains unselected controls/templates only, no source names, rows or keys. It
records deployed UI presence, not evidence of a completed merge. Main cabinet
left open for the user. Real source provenance, cross-study participant identity,
consent evidence, full cloud merge with actual selected sources and live form
transfer have not been independently validated by this stage. Source uploads are
not automatically treated as verified consent or compatibility.

This follow-up changes only Git documentation and the operational screenshot;
application deployment remains pinned to the fully verified SHA above. CI is
not rerun for this evidence-only follow-up. PR #16 remains open, stacked on #15;
Issue #4 remains open. Next three tasks: inspect/document uploaded source schemas
and instrument versions without inferring answers; prepare a compatible scoped
project and consent/receipt persistence; verify a bounded live transfer only with
actual source-backed answers and evidenced recipient/participant authorization.

### 2026-10-12 — Cabinet cloud form automation (implementation checkpoint)

Continues PR #16 documentation head `28798e7b29dc7ea765c6eb7e5db8832c38e8ef9e`
on `feat/cabinet-form-automation`; preserves existing bank, workbench, migrations,
private Blob/OIDC configuration and original source files. Adds authenticated
cabinet automation API/UI, durable Workflow execution (only account/job IDs in
workflow arguments), one-participant Sandbox browser worker, persisted status,
cancellation and progress. Preparation never enters answers. Fill/submit require
linked questionnaire evidence, explicit participant/recipient confirmation and
production write activation. Operator attestation is not independently verified
participant consent. Preview cannot write to external forms.

One source row is intersected with the original cohort; original bytes/SHA remain
unchanged. JSON task downloads and scoped agent job reads avoid repeated file
handoffs. A global canonical-form/participant receipt is privately reserved and
read back before Submit; uncertain dispatch/send is not retried automatically.
The runner rejects pre-existing success text and requires a new confirmation
without a remaining submit control. No direct Google formResponse POST, account
bypass, generated respondent answers, Cronbach-alpha adjustment or new SQL migration.

Pilot bounds: one selected participant per job, five-minute/one-CPU ephemeral VM,
three dispatches per UTC day/environment, 100 historical jobs/account. Every VM
is stopped in finally. Network switches from pinned browser installation to the
fixed public workbench, exact form destination and Google static assets; provider
credentials are never placed in the browser VM. Fill-only creates a temporary
browser draft; it cannot resume as a later submission. Preparation audits the
first available question section, not the complete form. See FORM_AUTOMATION.md.

Modified code: cabinet/workbench contracts, authenticated catalog/agent routes,
new form-automation service/domain/route/panel/workflow and cloud runner/policy;
public machine schemas/guide, existing browser runner confirmation checks and
unit/integration/HTTP/Chromium scenarios. Tests use isolated fixtures, not actual
participant submissions. Locked install passed; 246 unit/integration tests passed
with no skips/failures, lint and TypeScript completed. Earlier TypeScript fixture
annotation was repaired. One build failed on a corrupted generated Turbopack
cache; moving that generated cache aside restored the build. A subsequent
literal-path file trace fix removes the whole-project trace warning. 21 HTTP
checks passed on the built server before final progress/UI refinements. Final
head build/HTTP, actual Chromium CI, exact-SHA deployment and one read-only live
cloud launch are still pending at this checkpoint; do not claim they happened.

Next three tasks: complete exact-head checks and publish a stacked PR; release
the checked application through official Vercel authorization and verify the
primary alias; perform one read-only live cloud preparation and record actual
status/limitations without entering source answers. Issue #4 remains open.

Final local verification on the recovered implementation (2026-10-12): lint,
TypeScript and production build exit 0; 246 unit/integration tests pass with no
skips. A pnpm HTTP run returned an incomplete log and is not counted as proof.
The direct Node HTTP run with test concurrency 1 completed: 21/21 pass, no skips,
exit 0. No further full local repeats are needed absent code changes. Reviewed
React effects, accessible labels, active-only polling and authenticated routes.
Browser CI, provider launch and production release remain to be recorded against
the commit created from this working tree. No live Google response was sent.


### Verified automation checkpoint and release boundary (2026-10-12)

Application commit `068720c5d246a05d51619434308b2e232949e19d` / tree
`11f605ba50fda4c389ec2477cab85a83dcfcd5eb` is saved in PR #17, stacked on
PR #16. Local staged tree matched the connector-created GitHub tree exactly;
local branch was aligned to that fetched commit without overwriting files.
CI run `38254885718`, job `114830278146` completed SUCCESS. Every step passed,
including locked/native install, lint, types, 246 unit/integration tests,
build, 21 HTTP checks and four actual Chromium scenarios. Browser log explicitly
verified two-section source-backed fixture fill/verification, durable receipt and
uncertain-send refusal; cabinet fixture verified launch/replay and persisted
result. No live research response was involved.

Protected Preview `dpl_BoPvwjcMyP8FZxt2cvYesXb85ESQ` is READY on that exact
application SHA and branch, at
https://research-respondent-platform-53mp0fcag-spw1.vercel.app/cabinet . Initial
SHA-only Preview request created `dpl_683T1R1y9R7qEaMUh8MySmGtd6vB` without the
branch-scoped configuration. It was replaced by the correctly branch-scoped
request; cancellation returned 400 because the initial build was no longer
cancelable. Only the branch-scoped Preview above is the verification target.

Official browser entry passed Vercel protection. Secure browserAuth sign-in
returned submitted and a fresh visible cabinet state positively showed sign-in,
zero Preview assets/projects and the automation panel. A later file-chooser
operation was rejected before execution by retained native-credential protection.
The tool-directed fresh tab and fresh runtime recovery remained unavailable.
No fixture was uploaded, no project/job was created and no live cloud form task
was launched by this batch. Do not claim an actual cabinet cloud run or Google
Forms fill/send from successful CI or the signed-in page. No screenshot could be
captured after the browser protection block.

Automatic permission review rejected production fill/send activation and the
production deployment, each because exact production authorization was not
explicit in the current request. No alternative release/alias/security bypass
was attempted. A materially safer read-only production feature flag
`RRP_FORM_AUTOMATION=1` was accepted; metadata readback confirms the production
write flag is absent. The current deployed production application ignores this
new flag, so the primary website remains on the previous application version.
Preview has read-only automation enabled. Existing accounts/source files are
unchanged. New release remains pending explicit owner authorization, and actual
external entry/send additionally needs a verified compatible source and
participant/destination basis. Docs-only evidence follow-up uses [skip ci].

Next three tasks: obtain explicit release and production-write authorization;
release the tested application SHA through official Vercel access and read back
the primary alias; perform one read-only cabinet cloud run after browser access
is available, then an explicitly authorized source-backed transfer if complete
answers/basis exist. Issue #4 and the relational migration remain open.


### Owner-authorized production automation release (2026-10-12)

Owner explicitly approved the release and production fill/send activation in
response to the prior exact approval question. This authorization persists;
do not ask again for this same release/capability. Both flags are now configured
as 1 for production; Preview remains read-only. The activation and deployment
passed automatic review after that authorization.

Two Git-sourced production requests (`dpl_G7NXghR9idVwxutP6XtyHvX4Gfx1` by SHA,
`dpl_4w5fpVGgCYgDUSsDwkbefH8ggJQL` by pinned release branch) failed before build
with `git_info_fail`, without changing the primary alias. A release branch
`release/cabinet-automation-20261012` pins the tested application commit and has
not changed main. Official redeployment of the successful Preview source with
production target and production environment variables succeeded:
`dpl_9ihFdPUBpr3A6X2e11i3sHtfBZTX`, READY, application SHA
`068720c5d246a05d51619434308b2e232949e19d` (same checked code). Build log reports
Build Completed and Deployment completed. Primary alias assignment replaced
`dpl_9LtUDFDRKwptSYr6ZczXMkNs8u6Y`; independent alias readback confirms the new
production deployment at https://research-respondent-platform.vercel.app/cabinet .

Actual public HTTPS verification completed with exit 0: cabinet/workbench,
manifest, automation command schema and agent guide 200; automation/catalog/agent
APIs deny anonymous access with 401/no-store; foreign-Origin launch 403;
anonymous same-Origin launch 401; provider proof route 404. The initial probe
incorrectly expected root additionalProperties rather than oneOf member rules;
only that verifier expectation was corrected. Application code/build/CI was
unchanged, and the completed verification is the passing evidence. Flags were
independently read back by metadata only; no password hashes were decrypted or
changed. No source files, projects, participant answers or live forms were written.

The native browser still refuses observation after its prior credential delivery,
including its documented same-browser runtime recovery. Production authenticated
launch and the new live cloud task remain unverified; this is not a site-served
bot block and does not invalidate the successful public HTTPS checks. Existing
fixture CI evidence remains valid, but no actual Google response-recorded receipt
exists for this new cabinet workflow. Do not claim an end-to-end live send.
No further full tests were repeated for this deployment or docs-only record.

Next three tasks: complete one authenticated read-only cloud cabinet launch once
the native browser is available; verify an exact instrument-item/source map and
participant/destination basis; execute one explicitly permitted compatible
source-backed response and retain its visible receipt before expanding batches.
