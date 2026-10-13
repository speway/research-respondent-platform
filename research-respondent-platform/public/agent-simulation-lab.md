# Respondent Lab: simulation and reliability contract

GET `/api/cabinet/lab` with `Authorization: Bearer <lab-key>` reads one saved
`rrp.simulation-cohort.v1` as `rrp.lab-bundle.v1`. Never put keys in URLs.
Keys expire after 24 hours and can be revoked by the owner. They grant no access
to observed sources, uploads, project creation, execution or external submission.
Cabinet cookie and same-Origin JSON are required for mutation commands.
Schemas: `/.well-known/rrp-lab-command.schema.json` and
`/.well-known/rrp-simulation-cohort.schema.json`.

The seeded `demo-battery-1` generator produces 39 + 18 numeric demonstration
items and 11 nominal culture categories. Its keys are not verified instrument
keys. Preserve `data_origin: modeled`, seed, version, parameters, attempts and
`targetReached`. Conditioning on alpha is explicit mathematical simulation,
not measured psychometric validity or population calibration. Exhausted search
returns `targetReached: false`, never a claimed success. No automatic live form
submission exists in this laboratory.

Reliability commands read a source by exact column names. They use complete
cases per scale and declared reverse keys (`low + high - value`) only during
analysis. Do not reverse actual answers when filling a form. Missing and invalid
rows are separately counted; zero total variance or insufficient data gives null
with a reason. Negative alpha is preserved. Never change real responses to meet
a target, fill missing values or replace them with a simulated cohort.

For any separately authorized UI test run: verify authority on the exact target
form, agreed count and test accounting. Accounting may be isolated storage,
a receiver test flag, or an owner-authorized run with an exact test-record log
and exclusion from research results. Provenance once in metadata/journal is
sufficient; no mandatory service text in every answer. A lab key is no authority
on a third-party form. Map exact section/question text and full option labels;
never guess a method from its button count, use numeric DOM positions as codes,
randomly answer unknown questions, clamp invalid answers or force clicks.
Respect branching, access controls and CAPTCHA. Use visible UI only, not hidden
formResponse requests. Verify selections before moving on. A Submit click is
not a receipt: success requires a newly visible response-recorded message.
Never blindly retry a send with an unknown outcome.
