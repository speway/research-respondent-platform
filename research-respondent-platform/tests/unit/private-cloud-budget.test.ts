import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivateCloudBudgetJournal } from "../../lib/services/private-cloud-budget.ts";
import { runCloudFormAudit, type AuditFactory } from "../../lib/services/cloud-form-audit.ts";

test("independent private budget clients use one immutable provider reservation without source values", async () => {
  const stored = new Map<string, string>();
  const writer: NonNullable<Parameters<typeof createPrivateCloudBudgetJournal>[0]>["writer"] = async (path, body, options) => {
    assert.equal(options.access, "private"); assert.equal(options.allowOverwrite, false); assert.equal(options.addRandomSuffix, false);
    assert.equal(options.storeId, "store_fixture"); assert.equal(options.token, undefined); assert.equal(options.ifMatch, undefined);
    assert.deepEqual(JSON.parse(body), { schema: "rrp.cloud-budget-reservation.v1" });
    if (stored.has(path)) throw new Error("Fixture provider create conflict");
    stored.set(path, body);
  };
  const clients = Array.from({ length: 8 }, () => createPrivateCloudBudgetJournal({ storeId: "store_fixture", writer }));
  const outcomes = await Promise.allSettled(clients.map((client) => client.claim("a".repeat(64))));
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1); assert.equal(stored.size, 1);
  await assert.rejects(clients[0]!.claim("../participant/name"), /Invalid cloud budget/);
  assert.throws(() => createPrivateCloudBudgetJournal({ storeId: "" }), /configured private Blob/);
});

test("failed or uncertain private reservation prevents cloud allocation", async () => {
  let allocations = 0;
  const createSandbox: AuditFactory = async () => { allocations++; throw new Error("Must not allocate"); };
  const budgetJournal = createPrivateCloudBudgetJournal({ storeId: "store_fixture", writer: async () => { throw new Error("Uncertain private storage acknowledgment"); } });
  await assert.rejects(runCloudFormAudit({ formUrl: "https://forms.gle/fixture", approval: {
    purpose: "read_only_form_audit", evidenceReference: "Fixture approval", expiresAt: "2099-01-01T00:00:00Z", maxRuns: 1,
  }, budgetJournal, createSandbox }), /Uncertain private storage acknowledgment/);
  assert.equal(allocations, 0);
});
