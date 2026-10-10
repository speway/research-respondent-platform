/** Explicit operator command, not an anonymous/public billable endpoint.
 * On Vercel, SDK auth uses official OIDC. Locally use official `vercel link/env pull`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runCloudFormAudit, type AuditApproval } from "../lib/services/cloud-form-audit.ts";
const journalModule = "../tools/browser-agent/file-journal.mjs";
const { createFileJournal } = await import(journalModule);
const [formUrl, approvalFile, journalDirectory, outputFile, ...extra] = process.argv.slice(2);
if (!formUrl || !approvalFile || !journalDirectory || !outputFile || extra.length) throw new Error("Usage: node --experimental-strip-types scripts/audit-cloud-form.ts FORM_URL APPROVAL_FILE ABSOLUTE_DURABLE_JOURNAL_DIR ABSOLUTE_OUTPUT_FILE");
const inRepository = (path: string) => resolve(path).startsWith(resolve(new URL("../", import.meta.url).pathname));
if (!isAbsolute(journalDirectory) || !isAbsolute(outputFile) || inRepository(journalDirectory) || inRepository(outputFile)) throw new Error("Keep the durable budget journal and private evidence outside the repository.");
const approval: AuditApproval = JSON.parse(await readFile(approvalFile, "utf8"));
const result = await runCloudFormAudit({ formUrl, approval, budgetJournal: createFileJournal(journalDirectory) });
await writeFile(outputFile, JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
console.log("Read-only cloud audit completed. Private evidence saved; no participant answers entered or submitted.");
