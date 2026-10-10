# Cloud executor continuation

2026-10-10 UTC. This slice supplies an executable **read-only** Vercel Sandbox
adapter, not a connected permanent service or a participant-submission worker.
The current Preview still has `hostedBackgroundWorker: false`.

## Reviewable first cloud run

`lib/services/cloud-form-audit.ts` creates one VM using official Vercel SDK
3.6.1 / deployment OIDC, copies the checked reader and fixed entry point, installs
Playwright 1.62.1, narrows network access, reads the first question section and
stops the VM in `finally`. It traverses introductory information pages only; no
participant database, cookie jar, model key or answer is sent to the VM.

Hard resource limits: one vCPU (provider assigns 2 GB), five-minute session,
no exposed ports, `persistent: false`, no snapshots, 1 MiB maximum returned
observation. No service subscription or recurring schedule is created. Setup
allows only package/browser/Ubuntu mirrors; execution allows Google Forms and
static assets, excluding Google account sign-in. Browser request interception
blocks writes except an empty intro navigation without `entry.*` answer keys.
CAPTCHA, required answers, unknown controls and failed navigation stop the read.
Google anti-bot safeguards are never bypassed.

A strict approval object is required:

```json
{
  "purpose": "read_only_form_audit",
  "evidenceReference": "reference-to-owner-approved-single-run-budget",
  "expiresAt": "2026-10-11T12:00:00Z",
  "maxRuns": 1
}
```

The caller must supply a **durable atomic budget journal**. Its reservation is
made before allocation and never released after an error, so concurrent calls or
an uncertain provisioning outcome cannot silently consume another approved run.
A changed expiry/recipient with the same evidence reference does not renew the
reservation. The SDK adapter does not prove that an approval string was actually
issued by the owner: only a trusted authenticated caller may invoke it.
No anonymous web endpoint is exposed.

Operator entry point, after actual approval and official authentication:

```bash
node --experimental-strip-types scripts/audit-cloud-form.ts \
  'https://docs.google.com/forms/d/e/FORM_ID/viewform' \
  /private/approval.json /private/durable-budget-journal /private/form-observation.json
```

Output uses exclusive creation and mode 0600 outside Git. Do not put approval,
private observations, journals or OIDC values in the repository. Local OIDC is
obtained with the official Vercel login/link/env-pull flow, not chat credentials.
SDK auth is automatic inside a Vercel Function; this code has not exposed a
Function without an authenticated durable budget store.

## Evidence and remaining gates

Local tests use an injected Sandbox fixture: bounded creation, network policy
ordering, cleanup after command/foreign/oversized evidence failure, expired
approval rejection, simultaneous reservations and no automatic retry. They do
**not** establish a successful real Sandbox boot or browser installation.
The local actual-Chromium fixture independently exercises the same portable
reader's intro and question handling. Live UI readback reached page 2 of the
owner's supplied Google Form and inspected six question containers without
entering answers; no full live submission was attempted.

Official connected-project metadata: named sandbox list is empty and project env
list is empty. The connector team view exposes no billing plan or allowance, so
remaining free quota cannot be asserted. Sandbox is metered; consult the current
provider pricing https://vercel.com/docs/sandbox/pricing before the owner approves
the one-run test. The resource timeout is a compute limit, not a dollar ceiling:
network charges and provider regional rates are separate. Configure a provider
spend limit before recurring execution.

AGENTS.md rule 7 requires explicit approval before paid services and real
external submissions. No billable Sandbox or production deployment was created
in this slice. Storage integration authorization was previously blocked (403);
there is still no configured durable multi-user source/receipt/queue store.

Next implementation after the one-run audit: authenticated source selection and
consent lookup backed by durable storage; atomic per-participant submission
receipts and budget reservations; durable queue/Workflow with a bounded on-demand
Sandbox worker. Keep sources encrypted with a declared retention period. A
permanently idle VM is unnecessary: the service can accept a link continuously
and allocate the browser only for a authorized job. A link cannot supply actual
missing participant answers or automatically authorize another recipient.

## Approved runtime evidence and current adapter — 2026-10-10

The historical unprovisioned state above is superseded by the one owner-approved
cloud run recorded in `CLOUD_RUNTIME_VERIFICATION.md`: official API creation,
sandboxed Chromium reading the supplied live form's first question section,
audit exit 0, no answers/submission, stopped VM verified independently.
The command path needed directory creation, HTTPS-only Ubuntu sources, the
observed browser download redirect domain, and separate root dependency/user
binary installs. The final adapter incorporates these repairs, refuses decoded
prefill/answer parameters, reads traced assets before allocation and rechecks
approval expiry after the durable reservation. Its final stricter network guard
has fixture coverage, not a second live cloud run. Run the CLI from the app root.

`createPrivateCloudBudgetJournal` uses private Blob create-only writes with
explicit deterministic paths and `allowOverwrite:false`. Any unsuccessful or
uncertain acknowledgment throws before VM allocation. Markers contain only a
schema constant, with the budget hash in the path, and must never be deleted or
expired to renew an approval. SDK auth is official OIDC/linked store credentials;
no token is returned or included in client assets. The injected-provider tests
do not establish real distributed storage concurrency. A Blob journal is not
the participant database, submission ledger or general durable queue.

The owner reauthorized storage/public-panel work after the auto-review rejection.
The newly allowed official Blob create request returned provider 403; no store
exists. The primary browser panel may be published without app registration and
without server data, while Preview/deployment protection and research access
controls remain. No hosted participant worker or public paid start route is
enabled. No additional permission question is required for the already authorized
step; official service access and empirical source/consent records are required.
