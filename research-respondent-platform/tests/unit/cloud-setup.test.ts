import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const setupModule = "../../tools/cloud-agent/prepare-ubuntu.mjs";
const { prepareUbuntuSources } = await import(setupModule);

test("cloud package setup uses TLS for approved mirrors and disables unrelated repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "rrp-cloud-setup-"));
  try {
    await writeFile(join(root, "ubuntu.sources"), "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: resolute\nComponents: main\n");
    await writeFile(join(root, "github.list"), "deb https://cli.github.com/packages stable main\n");
    await writeFile(join(root, "lookalike.list"), "deb https://archive.ubuntu.com.evil.test/ubuntu resolute main\n");
    const legacy = join(root, "legacy");
    await writeFile(legacy, "# old mirror\ndeb http://security.ubuntu.com/ubuntu resolute-security main\n");
    assert.equal(await prepareUbuntuSources(root, legacy), 2);
    assert.match(await readFile(join(root, "ubuntu.sources"), "utf8"), /https:\/\/archive\.ubuntu\.com/);
    assert.match(await readFile(legacy, "utf8"), /https:\/\/security\.ubuntu\.com/);
    await assert.rejects(readFile(join(root, "github.list")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "lookalike.list")), { code: "ENOENT" });
    assert.match(await readFile(join(root, "github.list.rrp-disabled"), "utf8"), /cli.github.com/);
    assert.equal(await prepareUbuntuSources(root, legacy), 2); // Repeat is harmless; no reactivation.
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cloud package setup stops if no approved Ubuntu source remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "rrp-cloud-setup-"));
  try {
    await writeFile(join(root, "foreign.sources"), "Types: deb\nURIs: https://other.test/ubuntu\n");
    await assert.rejects(prepareUbuntuSources(root, join(root, "missing")), /No approved Ubuntu/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
