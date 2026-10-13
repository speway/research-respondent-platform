/** Rebuild public structural schemas; domain runtime also checks contextual rules. */
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { observationSchema, taskSchema } from "../lib/domain/agent-workbench.ts";
import { simulationCommandSchema, simulationCohortSchema } from "../lib/domain/simulation-lab.ts";
import { personaCommandSchema } from "../lib/domain/persona-bank.ts";
import { quorumStudentCommandSchema, quorumAdminCommandSchema, quorumHostedCommandSchema, quorumPredictionSchema, quorumStudySchema, quorumExperimentSchema } from "../lib/domain/quorum.ts";
for (const [name, schema] of [["rrp-agent-task", taskSchema], ["rrp-observed-form", observationSchema], ["rrp-lab-command", simulationCommandSchema], ["rrp-simulation-cohort", simulationCohortSchema], ["quorum-student-command", quorumStudentCommandSchema], ["quorum-admin-command", z.union([quorumAdminCommandSchema, quorumHostedCommandSchema])], ["quorum-agent-prediction", quorumPredictionSchema], ["quorum-study", quorumStudySchema], ["quorum-experiment", quorumExperimentSchema]] as const) {
  await writeFile(new URL(`../public/.well-known/${name}.schema.json`, import.meta.url), `${JSON.stringify(z.toJSONSchema(schema, { io: "input" }), null, 2)}\n`);
}
await writeFile(new URL("../public/.well-known/rrp-persona-command.schema.json",import.meta.url),`${JSON.stringify(z.toJSONSchema(personaCommandSchema,{io:"input"}),null,2)}\n`);
