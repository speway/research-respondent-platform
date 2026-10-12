import { z } from "zod";
import { validFormUrl } from "./workbench.ts";
export const automationRequestSchema = z.object({ requestId: z.string().uuid(), projectId: z.string().uuid(),
  participantRef: z.string().min(1).max(500), mode: z.enum(["prepare", "fill", "submit"]),
  evidenceAssetId: z.string().uuid().optional(), evidenceReference: z.string().trim().min(1).max(1000).optional(),
  consentConfirmed: z.boolean().default(false), recipientConfirmed: z.boolean().default(false),
}).strict().superRefine((s, ctx) => {
  if (s.mode !== "prepare" && (!s.evidenceAssetId || !s.evidenceReference || !s.consentConfirmed || !s.recipientConfirmed)) {
    ctx.addIssue({ code: "custom", message: "Для ввода нужны документ согласия, основание и подтверждение получателя." });
  }
});
export type AutomationRequest = z.output<typeof automationRequestSchema>;
export const automationResultSchema = z.object({
  status: z.enum(["prepared", "blocked", "filled_not_submitted", "response_recorded", "submission_uncertain"]),
  sectionsVerified: z.number().int().min(0).max(100).default(0),
  questionsVerified: z.number().int().min(0).max(10000).default(0),
  sectionNumber: z.number().int().min(1).max(100).optional(),
  problems: z.array(z.string().max(20000)).max(20).default([]),
  externalSubmission: z.union([z.boolean(), z.literal("unknown")]),
  evidence: z.literal("visible_response_recorded").optional(), observedAt: z.iso.datetime(),
}).strict().superRefine((r, ctx) => {
  const recorded = r.status === "response_recorded";
  if (recorded !== (r.externalSubmission === true) || (recorded && r.evidence !== "visible_response_recorded")
    || (r.status === "submission_uncertain") !== (r.externalSubmission === "unknown")) ctx.addIssue({ code: "custom", message: "Неподтверждённая отправка." });
});
export type AutomationResult = z.output<typeof automationResultSchema>;
export const automationProgressSchema = z.object({ status: z.enum(["introduction", "prepared_section", "verified_section"]),
  sectionNumber: z.number().int().min(1).max(100), sectionsVerified: z.number().int().min(0).max(100),
  questionsVerified: z.number().int().min(0).max(10000) }).strict();
export interface AutomationJob {
  id: string; accountId: string; fingerprint: string; request: AutomationRequest; sourceSha256: string;
  formUrl: string; formIdentity: string; createdAt: string; expiresAt: string; requestHash: string;
  evidence?: { id: string; sha256: string }; projectName: string;
}
/** Cloud writes accept canonical full links only; query variants share the same ledger. */
export function formIdentity(raw: string) {
  if (!validFormUrl(raw)) throw new TypeError("Нужна ссылка Google Forms.");
  const url = new URL(raw);
  const match = /^\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]+)\/viewform\/?$/.exec(url.pathname);
  if (url.hostname !== "docs.google.com" || !match || url.port || url.hash || [...url.searchParams.keys()].some((key) => /^entry[._]|^(edit2|draftResponse|partialResponse|email|emailAddress)$/i.test(key))) throw new TypeError("Для облачного запуска нужна полная ссылка viewform без предзаполнения.");
  return match[1]!;
}
export interface AutomationView {
  id: string; projectId: string; projectName: string; participantRef: string; mode: AutomationRequest["mode"];
  createdAt: string; expiresAt: string; status: "reserved" | "queued" | "running" | "cancellation_requested" | "cancelled" | "failed" | "execution_uncertain" | AutomationResult["status"];
  runId?: string; result?: AutomationResult; progress?: z.infer<typeof automationProgressSchema>; retryAllowed: false;
}
