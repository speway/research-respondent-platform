import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = "../../tools/browser-agent/file-journal.mjs";
const { createFileJournal } = await import(modulePath);
test("durable receipt journal atomically reserves only once and preserves uncertain outcomes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rrp-journal-test-"));
  try {
    const journal = createFileJournal(directory), key = "a".repeat(64);
    assert.deepEqual((await Promise.all(Array.from({ length: 8 }, () => journal.claim(key)))).sort(), [false, false, false, false, false, false, false, true]);
    const filename = join(directory, `${key}.json`);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await journal.finish(key, { status: "submission_uncertain", retryAllowed: false });
    assert.equal(await createFileJournal(directory).claim(key), false);
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), { status: "submission_uncertain", retryAllowed: false });
    await assert.rejects(journal.claim("../invalid"), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
