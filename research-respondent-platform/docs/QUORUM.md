# Quorum pilot

Quorum adds invitation-based participant accounts, native questionnaire exchange,
transparent virtual credits, independently consented profiles and blind
person–agent evaluation to the existing cabinet. Existing bank versions, private
source uploads, Google Forms mappings/executor and simulation lab remain separate.
The public hosted entry now opens `/quorum`; `/workbench` stays available.

## Actual supported flow

1. Owner creates an invitation in cabinet: unique pseudonymous login/group,
   explicit 0–20 starter credits. One-use token, 7 days; participant chooses own
   password and confirms 18+/participation rules. No shared operator password.
2. Participant creates a native study: goal/reference, recipient/retention/contact
   consent information, declared review rules, groups, duration, questions,
   target and reward. Exact target × reward is reserved atomically. Operator
   reviews before publication. No five-for-fifty or completion-time guarantee.
3. Eligible non-author participant personally submits once. Native receipt binds
   response ID, immutable study hash, participant, answers, time and consent
   version. Pending responses occupy only funded places. Operator accepts or
   rejects with reason; accepted payment is once, rejection supports appeal.
   Closing after pending review refunds only unused reserve. Source export is
   observed-only JSON accepted by the existing importer, with receipt references.
4. Participant separately records their profile and modeling consent, then consents
   to each experiment's frozen profile version and declared model/settings.
   Creating a profile alone is not permission for every future model or purpose.
5. Owner freezes an experiment's questions, hypothesis, model/prompt/settings,
   participant IDs and retest interval. Personal/baseline keys are separately
   scoped. Both predictions must commit before participant answers. The baseline
   gets no profile; neither receives human/retest data. Replays with the same
   answer are safe; changes are refused. Exact semantic independence of a
   free-form profile from holdout questions requires researcher review; technical
   separation cannot detect every paraphrase or an untrustworthy operator.
6. After first/retest answers, report actual N and individual/aggregate agreement
   and error. Paired differences use common items; intervals resample participants.
   Text needs independent rating; alpha is not imitation accuracy. The default
   14-day interval is a design choice, not an established optimum for every study.

Participant withdrawal erases their stored comparison data and disables keys.
Separate response withdrawal removes that response from future study exports
without confiscating earned credits. Preserve audit/credit metadata and original
receipt hashes, not erased answer content. Previously downloaded recipient
copies require that recipient's own handling; the platform does not recall them.
No automatic source-answer adjustment, missing imputation or human response
fabrication. Versioned profiles describe supplied self-reports, not diagnoses.

## Model execution

External agents use /agent-quorum.md and one 24-hour bearer key per arm/row.
Their model/prompt/settings declaration is checked but independently supplied
JSON cannot prove the named model ran. Optional hosted adapter uses current AI
Gateway catalog and Chat Completions HTTP; actual generation metadata is saved.
Enable only after data-processing and model-spend setup: `RRP_QUORUM_AI=1`,
production target, `AI_GATEWAY_API_KEY` or deployment `VERCEL_OIDC_TOKEN`.
It uses one attempt/arm, 5 attempts per environment UTC day, temperature 0,
max_tokens 4096, JSON object output, 40 seconds, no tools/fallback loops or
artificial answer noise. Failed/unknown attempts are recorded and cannot be
silently retried. Inspect saved state before creating a revised protocol.
No live model execution is implied by mock transport tests or a stored forecast.
No provider-specific key is introduced, and no paid request is made at build time.

## Persistence and boundaries

Reuse existing private Blob/store configuration, isolated by environment under
rrp/quorum/v1. A bounded state object commits accounts, escrow, ledger, responses,
consents, grants and experiment rows with a provider ETag/create-only lease.
Concurrent conflict fails 409; no automatic transaction retry. Each write checks
credit conservation, balances reconstructed from the ledger, content/receipt
hashes, journal chain and durable readback. Auth sessions are separately hashed.
Passwords use existing scrypt; raw invitation/session/comparison tokens are never
persisted in state. Private API responses are no-store; browser writes require
same Origin/JSON; agent prediction uses its exact bearer capability and rejects
foreign Origin if supplied. Owner, team, participant and arm scopes differ.

Pilot limits: 100 participant accounts, 25 studies, 2500 submissions, 100
person–experiment rows, 1000 grants, 5000 journal entries, 2.8 MB state. Hitting a
limit fails before mutation and needs export/migration. This is a small invited
pilot, not a nationwide recruitment service or migration of legacy SQLite.
No person was recruited or profile created automatically by deployment. Expanding
public registration/recruitment needs independent identity, retention/processor
operations and a database suitable for higher concurrency.

## Research rationale

[Park et al., updated June 2026](https://arxiv.org/abs/2411.10109)
compare held-out responses with participants' own retest consistency; this is
not a percentage of replicated identity.
[Jia et al., updated October 2026](https://arxiv.org/abs/2605.10659)
illustrate why matching aggregate distributions is insufficient for individual
prediction and multivariate structure. N=50 is a proposed pilot, not proof that
agents can replace respondents across tasks. Current platform is profile-based
conditioning and evaluation; it does not claim fine-tuned model weights.

The portable JS client `tools/quorum-agent/client.mjs` reads a scoped task and
invokes a caller-supplied model callback exactly once before committing. It rejects
unexpected permission expansion, baseline profile leaks, credentials in URLs,
redirects and hidden human/retest fields; it does not evaluate code from a task.
Use secrets in process/session memory, not command arguments or committed files.
