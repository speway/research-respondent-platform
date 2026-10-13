# Psychological persona integration

The pinned `generate-psychological-personas` model now has a full private bank,
Python transport, managed Workflow, cabinet UI and reusable prediction adapter.
17 groups/169 author coordinates are uncalibrated model parameters, not test
scores, clinical diagnoses or measured participant answers. Full worker JSON is
retained, including uint64 string seeds, core fingerprints and episode history.

## Working components

| Component | Responsibility |
|---|---|
| `lib/domain/personas.ts` | Exact job/cohort validation, response binding, stable-core adaptation |
| `lib/services/persona-bank.ts` | Private immutable envelopes/indexes, parent checksum, account/environment scope, replay leases, status/cancellation, separate 24h revocable read keys |
| `lib/services/persona-worker.ts` | Verify pinned files, execute Python in ephemeral network-disabled Sandbox, file/CPU/memory/time bounds, finally stop |
| `workflows/persona-job.ts` | ID-only Workflow input/output, no automatic step retry |
| `components/persona-bank.tsx` | Import, generate, adapt, reload/poll, download original JSON, agent handoff/revocation |
| `/api/cabinet/personas` | Authenticated API, same-Origin JSON writes, no-store responses |
| `/api/personas/schema` | Public read-only dictionary, contains no profiles or execution |
| `lib/domain/persona-prediction.ts` | One prediction callback, exact Quorum question codes/ranges, baseline without profile, complete original envelope in separate modeled receipt |

Existing actual-source projects/Google Forms, lab and Quorum scopes remain
separate. This module does not enroll a persona as a consented human, write
observed/retest answers, increase actual N or activate Quorum Gateway processing.
Prediction callback output is an attestation, not provider proof. There is no
automatic named-model inference; callers choose their own declared execution.

## Activation and limits

Import/download/read grants work with the existing configured private cabinet.
Cloud generation/adaptation requires `VERCEL=1`, `RRP_PERSONA_WORKER=1` and an
explicit authenticated start/confirmation. No Python installation is assumed in
Next.js. Sandbox image `vercel/sandbox/python:3.14` contains Python; model needs
only its standard library. No network, source cloning, pip install, credentials
inside the VM or live model calls. Fixed file paths, no shell interpolation.

Limits: 100 personas/version, 2 MB cohort, 100 stored versions/account, 100 jobs,
5 cloud starts/environment/UTC day, 90 seconds/1 vCPU, 45 CPU seconds/512 MB
Python memory/3 MB output file. Version allocation is a monotonic CAS budget;
uncertain/failed allocations can consume a slot (never exceed the cap).
Catalog polling reads small indexes, not all cohort bodies. Original and child
cohorts are immutable; adaptation keeps IDs, seed, context, core and old history.
Same scenario is idempotent. Unknown measured facts remain null.

Request UUID binds exact parameters. Create-only dispatch and started leases
precede execution; concurrent replay cannot launch another Workflow or VM.
Unknown registration is execution_uncertain, no blind retry. Workflow step
maxRetries=0. Failed jobs require inspection/new intentional request. Closing a
tab does not stop execution; cancel blocks next command/result publication.
An in-flight Python command can finish before cancellation is observed; VM still
has the 90-second hard timeout. Cancellation/result publication races may yield
an already completed result, never a second run.

## Portable worker

From app root:

```bash
python3 tools/psychological-personas/scripts/worker.py < tools/psychological-personas/assets/worker-request.json
```

Wire protocol v1, model v1.0.0. Worker operations generate/adapt/validate;
`person_seed` is decimal uint64 STRING, never Number. Core digest follows Python
sorted UTF-8 float-coordinate JSON; TS independently checks the same digest.
The personal skill remains the source of the explicit snapshot. Update all files
and manifest hashes together; do not silently resample saved people on upgrade.

## Verification boundaries

Tests use actual Python and isolated persistence/Chromium routes. No real
respondent source, Quorum enrollment, paid inference or external form submission
is required. Cloud provisioning and private provider/Workflow writes require their
own independently verified run; local Sandbox lifecycle fixtures do not establish
that live deployment proof. See WORK_CONTINUATION for exact checks/commit/deploy.
Machine guide: `/agent-personas.md`.
