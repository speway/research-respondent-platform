import { z } from "zod";
import type { PersonaCohort, PersonaGeneration, PersonaScenario } from "./personas.ts";
export const PERSONA_BANK_LIMITS = { bytes: 2 * 1024 * 1024, personas: 100, versions: 100, dailyRuns: 5, sandboxMs: 90000 } as const;
const id = z.string().uuid();
const name = z.string().trim().min(1).max(200);
export const personaCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("import"), requestId: id, name, cohort: z.unknown() }).strict(),
  z.object({ command: z.literal("generate"), requestId: id, name, parameters: z.unknown(), confirmCloudRun: z.literal(true) }).strict(),
  z.object({ command: z.literal("adapt"), requestId: id, name, cohortId: id, parameters: z.unknown(), confirmCloudRun: z.literal(true) }).strict(),
  z.object({ command: z.literal("cancel"), jobId: id }).strict(),
  z.object({ command: z.literal("agent_key"), cohortId: id }).strict(),
  z.object({ command: z.literal("revoke_key"), keyId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type PersonaCommand = z.output<typeof personaCommandSchema>;
export interface PersonaAsset {
  id: string; kind: "modeled_persona"; name: string; createdAt: string; sha256: string;
  count: number; modelVersion: string; data_origin: "modeled";
  parent: { id: string; sha256: string } | null;
}
export interface PersonaEnvelope { schema: "rrp.modeled-personas.v1"; asset: PersonaAsset; cohort: PersonaCohort }
export interface PersonaBankJob {
  id: string; accountId: string; fingerprint: string; requestHash: string; name: string;
  createdAt: string; expiresAt: string;
  operation: "generate" | "adapt"; parameters: PersonaGeneration | PersonaScenario;
  parent: { id: string; sha256: string } | null;
}
export interface PersonaJobView {
  id: string; name: string; createdAt: string; expiresAt: string;
  status: "reserved" | "queued" | "running" | "completed" | "cancelled" | "failed" | "execution_uncertain";
  retryAllowed: false; assetId?: string;
}
export interface PersonaReadKey { keyId: string; cohortId: string; expiresAt: string; revoked: boolean }
