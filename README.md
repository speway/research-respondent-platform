# Research Respondent Platform

A research operations workspace for managing documented participant records, consent, psychometric scoring, cohort selection, external form mappings, and auditable agent tasks.

> **Development status:** Active implementation. Not verified for production use with personal or research data. Do not interpret the presence of a page or module as proof it works.

## Repository layout

The application currently lives in [`research-respondent-platform/`](research-respondent-platform/). This layout is deliberately preserved until a green build and migration plan justify restructuring.

| Location | Purpose |
| --- | --- |
| [`research-respondent-platform/README.md`](research-respondent-platform/README.md) | Product overview and feature-level documentation |
| [`research-respondent-platform/docs/CHATGPT_HANDOFF.md`](research-respondent-platform/docs/CHATGPT_HANDOFF.md) | Historical DeepSeek implementation record (includes stale pre-GitHub status) |
| [`research-respondent-platform/docs/WORK_CONTINUATION.md`](research-respondent-platform/docs/WORK_CONTINUATION.md) | **Current handoff and prioritized plan for ChatGPT Work or another coding agent** |
| [`research-respondent-platform/docs/RESEARCH_INTEGRITY.md`](research-respondent-platform/docs/RESEARCH_INTEGRITY.md) | Requirements for data provenance, participant consent and research integrity |
| [`research-respondent-platform/docs/SETUP.md`](research-respondent-platform/docs/SETUP.md) | Local setup and operating notes |
| [`research-respondent-platform/db/migrations/`](research-respondent-platform/db/migrations/) | Versioned SQLite migrations |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | GitHub Actions verification |

## Local development

From the repository root:

```bash
cd research-respondent-platform
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm run dev
```

Requires Node.js 24 and pnpm 11.7.0 for alignment with the last documented developer toolchain. Native `better-sqlite3` bindings must install successfully. See `docs/SETUP.md` for migration and bootstrap commands. These instructions are **not** a claim that the current commit passes all checks.

## CI and deployment

GitHub Actions runs from the repository root and executes commands inside `research-respondent-platform/`. In Vercel, if creating a preview project, set **Root Directory** to `research-respondent-platform`. Do not enable production data collection until a persistent database architecture, access controls, consent and retention policies, and deployment checks have been verified. The current file-backed SQLite setup is not suitable as a durable production database for typical Vercel serverless hosting.

## Working with coding agents

Read [`AGENTS.md`](AGENTS.md) and [`WORK_CONTINUATION.md`](research-respondent-platform/docs/WORK_CONTINUATION.md) first. Work from an isolated branch, validate changes, open a pull request, and keep documentation synchronized with actual test results. No credentials or respondent-identifying data belong in this repository.

## Research data

Only consented, documented participants and their actual observed answers belong in the study dataset. Derived scores must remain traceable to versions of documented responses and scoring rules. Generated fixtures are allowed only in explicitly isolated test environments and must never be represented as empirical respondents.

## Current public cabinet (2026-10-11)

https://research-respondent-platform.vercel.app/cabinet provides issued-account
access, private source/questionnaire uploads and scoped agent handoff. No email
registration is required; owner/shared accounts and environments are isolated.
The original public preparation panel remains at `/workbench`. This is a private
file catalog, not a completed migration of legacy SQLite. See
[the cabinet contract](research-respondent-platform/docs/CABINET.md) and the latest
[verified continuation](research-respondent-platform/docs/WORK_CONTINUATION.md).
Application PR #15 has successful CI plus actual provider/public-access checks;
production account catalogs were verified empty.
