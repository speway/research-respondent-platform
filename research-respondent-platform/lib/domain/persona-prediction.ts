/** Reuses Quorum question validation without enrolling a fictional human in Quorum. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { validatePersonaCohort } from "./personas.ts";
import type { PersonaEnvelope } from "./persona-bank.ts";
import { quorumQuestionsSchema, validateQuorumAnswers } from "./quorum.ts";
const text=z.string().trim().min(1).max(1000);
export const modeledPredictionProtocolSchema=z.object({modelId:text,promptVersion:text,settings:text,questions:quorumQuestionsSchema}).strict();
export async function runModeledPrediction(envelope:PersonaEnvelope,personaId:string,rawProtocol:unknown,arm:"personal"|"baseline",predict:(task:unknown)=>Promise<unknown>) {
  validatePersonaCohort(envelope.cohort);
  const original=structuredClone(envelope),protocol=modeledPredictionProtocolSchema.parse(rawProtocol);
  if(original.schema!=="rrp.modeled-personas.v1"||original.asset.kind!=="modeled_persona"||original.asset.data_origin!=="modeled"||original.asset.sha256!==createHash("sha256").update(JSON.stringify(original.cohort)).digest("hex")) throw new TypeError("Invalid persona envelope.");
  if(arm!=="personal"&&arm!=="baseline") throw new TypeError("Invalid prediction arm.");
  const persona=original.cohort.personas.find(p=>p.id===personaId);if(!persona) throw new TypeError("Unknown persona ID.");
  const binding=createHash("sha256").update(JSON.stringify([original.asset.sha256,personaId,protocol,arm])).digest("hex");
  const task={schema:"rrp.modeled-prediction-task.v1",data_origin:"modeled",binding,arm,protocol,...(arm==="personal"?{persona:structuredClone(persona)}:{}),permissions:{maySubmitExternalResponse:false,mayCreateObservedParticipant:false}};
  const answers=validateQuorumAnswers(protocol.questions,await predict(structuredClone(task))); // One call, no outcome-driven retry.
  return {schema:"rrp.modeled-prediction-receipt.v1",data_origin:"modeled",observedParticipants:0,arm,binding,protocol,answers,originalEnvelope:original,executionEvidence:"caller_attestation_not_provider_receipt"};
}
