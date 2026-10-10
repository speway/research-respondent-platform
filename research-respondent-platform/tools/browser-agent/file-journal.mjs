import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Directory must be durable and private, outside the repository. No answer text stored. */
export function createFileJournal(directory) {
  const path = (key) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid receipt key.");
    return join(directory, `${key}.json`);
  };
  const write = async (target, value) => {
    const file = await open(target, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
    finally { await file.close(); }
  };
  const syncDirectory = async () => {
    const folder = await open(directory, "r");
    try { await folder.sync(); } finally { await folder.close(); }
  };
  return {
    async claim(key) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await write(path(key), { status: "reserved", observedAt: new Date().toISOString() }); await syncDirectory(); return true; }
      catch (error) { if (error.code === "EEXIST") return false; throw error; }
    },
    async finish(key, receipt) {
      const target = path(key), temporary = `${target}.${randomUUID()}.tmp`;
      await write(temporary, receipt);
      await rename(temporary, target);
      await syncDirectory();
    },
  };
}
