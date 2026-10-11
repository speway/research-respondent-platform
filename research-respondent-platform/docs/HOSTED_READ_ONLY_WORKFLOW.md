# Hosted read-only form audit

This bounded Preview workflow reads the first available question section of one
owner-approved Google Form. It does not load participant records, infer answers,
fill fields or submit a response. The public workbench remains available at
https://research-respondent-platform.vercel.app/workbench.

`workflow@5.2.0` integrates with Next through `withWorkflow`. Vercel World uses
official deployment OIDC and managed queues/state. Enable access to System
Environment Variables in the existing project's settings before deploying;
`VERCEL_DEPLOYMENT_ID` is mandatory. Never override a missing deployment ID with
`WORKFLOW_TARGET_WORLD` or copy a service token into this project.

The existing private Blob store is connected only to Preview. Configure these
non-secret variables only for the task branch's protected Preview:

- `RRP_CLOUD_DIAGNOSTICS=1`
- `RRP_CLOUD_AUDIT_FORM_URL`: one unfilled, approved Google Forms link
- `RRP_CLOUD_AUDIT_APPROVAL_REF`: immutable ASCII reference to the owner's scope
- `RRP_CLOUD_AUDIT_EXPIRES_AT`: future UTC ISO expiry

After the private storage probe has succeeded, `/cloud/setup` shows the scoped
launch. Its POST to `/cloud/audit` requires same origin, ignores client bodies,
checks scope/expiry/store evidence and reserves an immutable marker before
enqueueing. A create-only private receipt records the run ID and form hash and
is read back before acknowledging. Concurrent or uncertain requests never
enqueue a second run; a missing receipt after reservation requires investigation,
not automatic repair by relaunching. Renewing expiry preserves the approval
reference and all existing reservations.

The workflow is pinned to its initiating deployment and uses one step with
`maxRetries=0` plus FatalError on failure. The step repeats configuration and
storage evidence checks, then calls the existing cloud reader. The reader has its
own independent immutable allocation reservation, one CPU, no exposed ports,
no persistent VM and a five-minute provider timeout. It stops the VM in finally.
Only trusted pinned browser code and the approved URL enter the VM. Browser
network policy restricts reading; prefilled links and submission endpoints are
refused. Existing files are traced into the Function output.

Close or leave the page after registration; the queue continues independently.
`GET /cloud/audit` is read-only, uncached, protected by Vercel Preview SSO, and
returns completion data only for the configured persisted run. Production and
unconfigured routes return 404. This is not an anonymous arbitrary-URL endpoint,
participant database, general agent queue or verified live submission service.

## Recovery

Inspect the private receipt and official provider Workflow/Sandbox records.
Do not erase budget markers, mint a new reference, or restart an uncertain run.
Do not log tokens, private URLs, source rows or psychological answers. The VM
timeout bounds execution even if the calling Function dies before cleanup.
Actual provider run status and cleanup evidence must be recorded separately
from local lifecycle fixtures and build success.
