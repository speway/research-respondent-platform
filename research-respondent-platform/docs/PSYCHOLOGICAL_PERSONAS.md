# Psychological persona integration

This module connects the personal skill `generate-psychological-personas` to the platform as an **isolated educational simulation/test tool**. The research registry continues to require consenting real participants and documented observed answers. Model coordinates are authored, uncalibrated 0–100 values, not psychometric scores, percentiles, diagnoses or empirical observations.

## Implemented boundary

| Component | Use |
|---|---|
| `lib/domain/personas.ts` | Typed jobs/cohorts, runtime validation, SHA-256 core integrity, injected transport, response binding, immutable adaptation |
| `GET /api/personas/schema` | Authenticated model dictionary; requires `agent:read`; read-only, no participant data |
| `tools/psychological-personas/scripts/worker.py` | Python JSON stdin/stdout worker for generate/adapt/validate, standard library only |
| `tools/psychological-personas/manifest.json` | Explicit source snapshot hashes, model/protocol version |
| `tests/integration/personas.test.ts` | Real Python↔JavaScript round-trip, all adapters, provenance and tampering checks |

There is no generation HTTP endpoint, simulation database, automatic worker registration or form-submission adapter. The module is ready for an application worker connection; it does not claim that a deployed site has that connection. Existing research tasks and `ADAPTER_REGISTRY` keep their current contract. Do not map this result to `participant`, `consent_record`, `assessment_session`, `observed_answer`, `derived_score`, empirical exports or external responses.

## Run now

From the application root, Python 3.10+:

```bash
pnpm run personas:worker < tools/psychological-personas/assets/worker-request.json
# For a process transport, invoke Python directly: package-manager messages
# are not part of the JSON protocol.
python3 tools/psychological-personas/scripts/worker.py < tools/psychological-personas/assets/worker-request.json
```

Worker receives one job and returns one result; exit 0 = verified success, exit 1 = protocol/model rejection with a generic error. It does not write output files, open network connections or create a research database. `personas.py` also exposes the original file-based CLI for Python-only use.

## Connect from the site

```ts
import { runPersonaJob, type PersonaTransport } from "./lib/domain/personas.ts";

// Supply your approved worker transport. Return the parsed worker JSON only.
// Apply request authorization, concurrency, timeout and input/output size limits
// in the service layer. Do not shell-interpolate user input.
const transport: PersonaTransport = approvedPersonaWorkerTransport;
const result = await runPersonaJob({
  protocol_version: "1", request_id: "education-001", operation: "generate",
  data_origin: "modeled",
  parameters: {
    count: 4, seed: 42, age_min: 18, age_max: 25, topic: "education",
    conditions: { stress: 50, support: 50, fatigue: 30 },
  },
}, transport);
// Persist only to a separately labeled simulation store, if one is introduced.
```

`approvedPersonaWorkerTransport` in this example is an application-supplied function, not an exported implementation. For a local process use fixed executable/script paths and JSON stdin; for Vercel use a separate worker/service rather than assuming Python or persistent file-backed SQLite in a Next.js function. Transport exceptions propagate; rejected/mismatched worker responses raise `DomainError("persona.invalid", ...)`. No fallback generates answers silently.

Job fields are exact. `generate` parameters: count (1–1000), safe-integer seed, adult age bounds 18–100, topic, conditions. `adapt` accepts a wire-cohort plus topic/conditions; `validate` accepts a wire-cohort only. Supported initial topics: general, gaming, ai-decisions, education, work, relationships. A new topic requires an explicit versioned adapter; an arbitrary UI label alone does not install one.

For adaptation reuse the returned `cohort` with `operation: "adapt"`. ID, person seed, fictional context, core, unmeasured facts and existing episodes must remain unchanged. The same scenario is idempotent; history is bounded at 100 episodes/persona. New conditions affect state, not the stable core. `narrative_starter` is intentionally brief: the skill adds contextual biographies and behavioral examples; the worker alone does not produce a full psychological report.

## JSON precision and provenance

`person_seed` is a decimal uint64 **string**. Do not coerce it to JavaScript Number. The outer generator seed is restricted to safe integers. Python canonical core JSON contains floats including `.0`; the bridge restores that encoding before checking `core_fingerprint`. TS checks the same digest. A digest proves byte/coordinate consistency, not respondent authenticity.

Retain `data_origin: modeled` on job/cohort/person; purpose, coordinate semantics, model/protocol version, `calibration: none`, source registry and assumptions. Clinical, trauma, measured intelligence, real identity and observed performance remain unknown. MMPI/СМИЛ is a conceptual reference in the skill, not fabricated clinical test output. The 17 groups/169 dimensions are partial conceptual models, not a complete administration of each test.

Worker stdin limit: 25 MB. Services must also bound stdout, runtime, memory and concurrency (test transport: 15 seconds/25 MB). Schema GET is private and uncached. It cannot invoke Python or accept writes.

## Update the source snapshot

The personal skill is the canonical modeling source; the repository contains an explicit portable snapshot, with no dependency on a user's private skill directory at runtime. Copy `scripts/personas.py`, `scripts/worker.py`, `references/dimensions.json`, `references/sources.json`, `assets/worker-request.json` together and refresh SHA-256 in the manifest. Review changes through a task branch and run the full gates. Pinning hashes prevents unnoticed drift; it does not implement automatic updates.

If model semantics change, update versions and migration policy for stored simulations. Revalidate old cohorts explicitly; do not silently resample their identities. This work is based on main `dabed376d36080bc31e466f6907c7172faab2e06` and does not change migrations or the production hosting decision tracked by issues #3/#4.
