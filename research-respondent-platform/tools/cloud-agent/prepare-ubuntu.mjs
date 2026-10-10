/** Trusted setup only: keep Ubuntu mirrors on TLS under the Sandbox allow-list. */
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";
import process from "node:process";

export async function prepareUbuntuSources(directory = "/etc/apt/sources.list.d", legacy = "/etc/apt/sources.list") {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(list|sources)$/.test(entry.name))
    .map((entry) => join(directory, entry.name));
  try { await readFile(legacy); entries.push(legacy); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let configured = 0;
  for (const path of entries) {
    const text = await readFile(path, "utf8");
    const urls = text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n").match(/https?:\/\/[^\s\]]+/g) ?? [];
    if (!urls.length) continue;
    const approved = urls.every((value) => {
      const url = new URL(value);
      return ["archive.ubuntu.com", "security.ubuntu.com"].includes(url.hostname) &&
        !url.username && !url.password && !url.port && /^\/ubuntu\/?$/.test(url.pathname) && !url.search && !url.hash;
    });
    if (!approved) { await rename(path, `${path}.rrp-disabled`); continue; }
    await writeFile(path, text.replaceAll("http://archive.ubuntu.com", "https://archive.ubuntu.com")
      .replaceAll("http://security.ubuntu.com", "https://security.ubuntu.com"));
    configured++;
  }
  if (!configured) throw new Error("No approved Ubuntu package sources; stop cloud setup.");
  return configured;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const count = await prepareUbuntuSources();
  process.stdout.write(`Configured ${count} Ubuntu package source files on HTTPS.\n`);
}
