# Browser workbench — first trials

The existing application now includes `/workbench`. Vercel Preview home redirects there; local authenticated research routes keep their previous behavior. The workbench does not require an application account. Vercel deployment protection remains enabled. Vercel production redirects the workbench to the disabled login until durable hosting is configured.

## Start in the interface

1. **База ответов:** upload your CSV UTF-8, TSV or flat JSON file. One record per participant; unique headings. Save XLSX as CSV UTF-8 first. Choose the participant ID column and describe the source.
2. **Отбор и классификация:** choose columns, operators and group labels. Combine criteria with all/any. Criteria change the selection and separate classification labels; they never rewrite source answers.
3. **Карта формы:** for manual preparation, enter the Google Forms link, add exact questions and map each to a source column. Set required flags according to the actual form. The URL alone does not start a worker; an external agent can now read and automatically map the form using the Automation protocol below.
4. **Пакет для агента:** describe the task. Resolve displayed blockers, then download JSON. Required missing answers must be obtained from participants. Check the recipient permission and exact answer options before asking an agent to fill a form.
5. **Сохранить проект:** download a JSON project containing the base and settings. Use **Открыть проект** to restore it. Without that file, closing/reloading the tab loses the in-memory workspace.
6. **Автоматизация:** give the external browser agent this panel URL, source file, destination and purpose. The versioned command bridge supports programmatic load/read/map/check/plan without manual panel edits. A portable browser adapter supports text and single-choice section filling with an explicit scoped grant. Discovery: `/.well-known/rrp-agent.json`; full workflow and limits: [`AGENT_AUTOMATION.md`](AGENT_AUTOMATION.md).

The file is processed only in the workbench tab. There is no server upload, cloud sync or browser storage. The site itself does not submit forms; the new external browser adapter can do so within an explicit grant and durable receipt journal. The clear button drops the active workspace; downloaded files remain under the user's control. Only explicitly mapped columns enter an agent packet. Source data in a saved project remains private to the user; never add real project files to GitHub. Form observations are transient; restoring a saved project requires a fresh agent read before an automated plan.

## Source integrity and limits

- Source SHA-256 is calculated from the uploaded bytes; CSV line locators and JSON record indexes are retained. A checksum identifies the supplied file, not proof of participant identity or consent.
- String values, zero, false and null are preserved. The interface does not infer answers from personality traits, reverse-code source answers or substitute a neutral value for missing data.
- Duplicate/empty IDs in the selected records, missing required responses, invalid mappings, malformed CSV/JSON and known modeled-profile origins block preparation. Imported records are user-provided until verified under the research workflow.
- Initial limits: 5 MiB source file, 5000 records, 250000 cells; project files up to 15 MiB. Preview shows 20 records per page and eight columns. The entire mapped selection enters the JSON packet.
- Output schema `rrp.form-preparation.v1` includes task, criteria, question mappings, source checksum/locators and literal answers. `external_submission:false` and recipient authorization requirements are explicit. This is an agent preparation format, not the existing server task-runner execution contract.

## Skill context

The owner linked the shared chat “Создание психологических персон”: https://chatgpt.com/share/6aca3258-7640-83ed-82ed-b55a3697368b . It was read over HTTP, including the shared message data. It describes the skill and PR #6; it does not contain an attached empirical answer database.

The concept dictionary at `tools/psychological-personas/references/dimensions.json` is copied unchanged from PR #6 source `037bbbe1b0212d36627c51e51e5a094e17e2c861`, Git blob `49846ebba67284f035a888dc6a646233fc6da9a7`. All 17 groups / 169 authored coordinates are available as searchable labels. Selecting a label only names a criterion; it does not generate a trait measurement, a participant or an answer. The Python generator/transport and its separate persona storage remain the PR #6 integration, not a hidden browser service.

## Actual browser verification

Build first and make Playwright plus a compatible Chromium available externally. The project does not add a browser dependency to its locked application install.

```bash
pnpm run build
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
BROWSER_EXECUTABLE_PATH=/absolute/path/to/chromium \
node --experimental-strip-types tests/browser/workbench.mjs
```

If Playwright is already available by ordinary module resolution, omit `PLAYWRIGHT_MODULE`; if its browser is installed, omit `BROWSER_EXECUTABLE_PATH`. Optional `BROWSER_SCREENSHOT_DIR` captures desktop/mobile images. The script starts a real production Next server using the test harness and disposable SQLite database. It does not use real participants or a live destination form.

Verified runtime: Node 24.19.0, pnpm 11.25.0, Playwright 1.62.1, Chromium 153.0.8010.0. The restricted container required browser archives extracted without ownership changes; no browser binary or installation artifact is committed. Browser test covers file import, exact source hash, filtering, missing-answer denial, mapping, packet download, project restore, origin rejection, dictionary labels, 390px mobile overflow, absence of page errors/POST requests and unchanged research tables.

Follow `WORK_CONTINUATION.md` for source SHA, CI and deployment evidence. Durable multi-user hosting and live submission are still separate incomplete work; do not close Issue #4 on this first-trial panel alone.

## 2026-10-10: link reuse and expanded controls

Automation now accepts a new Google Forms link while retaining the loaded source and criteria. The agent discards the old observation and reads every new section. Labeled radio/checkbox matrices, finite multiple selection, native/custom accessible dropdowns and numbers are supported in the portable browser adapter and verified on isolated actual-Chromium fixtures. Multi-select cells require explicit JSON-array strings of exact labels. A read-only live audit inspected the first question section; complete live submission and the hosted background worker remain unverified. The bounded cloud audit adapter is prepared in `CLOUD_AGENT.md`, with no anonymous billable endpoint or automatically provisioned resources.
