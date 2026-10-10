import assert from "node:assert/strict";
import { test } from "node:test";
import { runCloudFormAudit, type AuditFactory } from "../../lib/services/cloud-form-audit.ts";
const policyModule = "../../tools/cloud-agent/read-only-policy.mjs";
const { isReadOnlyFormUrl, readOnlyRequestAllowed } = await import(policyModule);
const url = "https://docs.google.com/forms/d/e/fixture/formResponse";

test("read-only navigation refuses prefilled links, encoded answer keys and populated partial responses", () => {
  const request = { url, method: "POST", navigation: true };
  assert.equal(readOnlyRequestAllowed({ ...request, postData: "fvv=1&pageHistory=0&partialResponse=%5Bnull%2Cnull%2C%22123%22%5D" }), true);
  for (const body of ["entry.1=answer", "entry%2E1=answer", "emailAddress=person%40example.test", "submit=Submit",
    "partialResponse=" + encodeURIComponent(JSON.stringify([[[1, ["answer"], null]], null, "123"])), "partialResponse=invalid"])
    assert.equal(readOnlyRequestAllowed({ ...request, postData: body }), false);
  assert.equal(readOnlyRequestAllowed({ ...request, navigation: false }), false);
  assert.equal(readOnlyRequestAllowed({ ...request, method: "PUT" }), false);
  assert.equal(readOnlyRequestAllowed({ ...request, url: url.replace("docs.google.com", "evil.test") }), false);
  assert.equal(isReadOnlyFormUrl(url + "?entry%2E1=answer"), false);
  assert.equal(isReadOnlyFormUrl(url + "?edit2=token"), false);
  assert.equal(isReadOnlyFormUrl(url + "?usp=dialog"), true);
  assert.equal(readOnlyRequestAllowed({ url: "https://fonts.googleapis.com/css", method: "GET", navigation: false }), true);
  assert.equal(readOnlyRequestAllowed({ url: url + "?entry%2E1=answer", method: "GET", navigation: true }), false);
});

test("prefilled audit links are refused before consuming budget or creating a VM", async () => {
  let claims = 0, allocations = 0;
  const createSandbox: AuditFactory = async () => { allocations++; throw new Error("Must not allocate"); };
  await assert.rejects(runCloudFormAudit({ formUrl: url + "?entry%2E1=answer", approval: {
    purpose: "read_only_form_audit", evidenceReference: "Fixture", expiresAt: "2099-01-01T00:00:00Z", maxRuns: 1,
  }, budgetJournal: { claim: async () => { claims++; return true; } }, createSandbox }), /unfilled Google Forms link/);
  assert.equal(claims, 0); assert.equal(allocations, 0);
});
