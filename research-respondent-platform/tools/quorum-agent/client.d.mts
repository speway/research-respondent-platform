import type { QuorumPrediction } from "../../lib/domain/quorum.ts";
import type { Quorum } from "../../lib/services/quorum.ts";
export type QuorumAgentTask = Awaited<ReturnType<Quorum["agentTask"]>>;
export interface QuorumClientOptions { site: string; token: string; transport?: typeof fetch }
export function readQuorumTask(options: QuorumClientOptions): Promise<QuorumAgentTask>;
export function commitQuorumPrediction(options: QuorumClientOptions & { prediction: QuorumPrediction }): Promise<{ predictionSha256: string; alreadyCommitted: boolean }>;
export function runQuorumAgent(options: QuorumClientOptions & { predict: (task: QuorumAgentTask) => Promise<QuorumPrediction> }): Promise<{ predictionSha256: string; alreadyCommitted: boolean } | { alreadyCommitted: true }>;
