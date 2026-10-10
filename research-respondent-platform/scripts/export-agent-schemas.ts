/** Rebuild public structural schemas; domain runtime also checks contextual rules. */
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { observationSchema, taskSchema } from "../lib/domain/agent-workbench.ts";
for (const [name, schema] of [["rrp-agent-task", taskSchema], ["rrp-observed-form", observationSchema]] as const) {
  await writeFile(new URL(`../public/.well-known/${name}.schema.json`, import.meta.url), `${JSON.stringify(z.toJSONSchema(schema, { io: "input" }), null, 2)}\n`);
}
