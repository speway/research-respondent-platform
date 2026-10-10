# Instructions for AI coding agents

Repository: `speway/research-respondent-platform`
Application root: `research-respondent-platform/`
Default branch: `main`

1. Read `README.md`, `research-respondent-platform/docs/WORK_CONTINUATION.md`, `research-respondent-platform/docs/CHATGPT_HANDOFF.md`, and `research-respondent-platform/docs/RESEARCH_INTEGRITY.md` before editing. The historical handoff predates GitHub and contains stale state: re-verify all assertions.
2. Inspect the current branch/HEAD and open PRs. Create a task branch; do not force-push or commit directly to `main`. Avoid parallel agents editing the same files.
3. Run checks from `research-respondent-platform/`: `pnpm install --frozen-lockfile`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`, `pnpm run build`, and, once built, `pnpm run test:http`. Record actual exit codes and failures. Do not invent a passing test result.
4. Prioritize restoring CI and a working local app before cosmetic refactors, adding agents, or deploying. Treat network integrations as unverified until independently tested.
5. Preserve SQLite migrations, their checksums, historical handoff records, and domain tests. Add forward-only migrations for schema changes.
6. Protect participant privacy and research integrity. Only verified, consented, source-backed responses may enter empirical datasets. Never fabricate participants, fill gaps, manipulate measured outcomes, or conceal provenance. Restrict mock data to tests and demos.
7. Never commit `.env`, service-account files, API keys, session cookies, real respondent data, or local SQLite databases. Require explicit permission before real external submissions, paid services, or production deployment. Do not expose secrets in logs.
8. For Vercel: repository Root Directory = `research-respondent-platform`; current local SQLite must be replaced or an explicitly persistent compatible hosting solution adopted **before** using production data.
9. At the end of each coding batch, update `research-respondent-platform/docs/WORK_CONTINUATION.md` with checked commit SHA, modified files, commands run, verified results, blockers, and next three tasks. Append to the historical activity log only with new dated entries; do not rewrite history.
10. Use bounded iterations: inspect → select one task → patch → test → document → commit → PR. Stay within budget: one primary agent by default; spawn specialist agents only for independently scoped work with defined time/token budgets.
