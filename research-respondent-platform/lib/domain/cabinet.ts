import { z } from "zod";
import { taskSchema, workspaceFromTask } from "./agent-workbench.ts";
import { parseSource } from "./workbench.ts";

export const CABINET_FILE_BYTES = 2 * 1024 * 1024;
export const cabinetId = z.string().uuid();
const label = z.string().trim().min(1).max(500);
export const uploadSchema = z.object({ kind: z.enum(["source", "questionnaire"]), name: label,
  reference: label, rights: label, base64: z.string().max(Math.ceil(CABINET_FILE_BYTES / 3) * 4),
}).strict();
export const projectSchema = z.object({ name: label, sourceId: cabinetId,
  questionnaireIds: z.array(cabinetId).max(20), formUrl: taskSchema.shape.formUrl,
  purpose: label, idHeader: label, match: taskSchema.shape.match,
  criteria: taskSchema.shape.criteria,
}).strict().refine((p) => new Set(p.questionnaireIds).size === p.questionnaireIds.length, "Повтор опросника.");
export type CabinetProjectInput = z.input<typeof projectSchema>;
export const cabinetSettingsSchema = z.object({ checksum: z.string().regex(/^[a-f0-9]{64}$/),
  formUrl: taskSchema.shape.formUrl, purpose: label, idHeader: label,
  match: taskSchema.shape.match, criteria: taskSchema.shape.criteria }).strict();
export type CabinetProject = z.output<typeof projectSchema> & { id: string; createdAt: string };
export interface CabinetAsset { id: string; kind: "source" | "questionnaire"; name: string;
  reference: string; rights: string; sha256: string; bytes: number; createdAt: string;
  headers?: string[]; records?: number;
  derivation?: { schema: "rrp.bank-lineage.v1"; mode: "merge" | "join"; lineageSha256: string;
    parents: Array<{ id: string; sha256: string; name: string; reference: string; rights: string }> }; }
export interface AssetBody { base64: string }
export function validateUpload(input: unknown) {
  const file = uploadSchema.parse(input);
  // Canonical base64 only. Filenames never become storage paths or executable code.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error("Некорректное содержимое файла.");
  const bytes = Buffer.from(file.base64, "base64");
  if (!bytes.length || bytes.length > CABINET_FILE_BYTES || bytes.toString("base64") !== file.base64) throw new Error("Файл должен быть от 1 байта до 2 МБ.");
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const allowed = file.kind === "source" ? ["csv", "tsv", "json"] : ["json", "csv", "tsv", "txt", "pdf", "docx"];
  if (!extension || !allowed.includes(extension)) throw new Error("Неподдерживаемый формат файла.");
  if (file.kind === "source") {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const dataset = parseSource(file.name, text);
    if (dataset.headers.length > 2000 || Buffer.byteLength(JSON.stringify({ text })) > 3 * 1024 * 1024) throw new Error("Разделите базу: до 2000 столбцов и 3 МБ в JSON-пакете.");
    return { file, bytes, headers: dataset.headers, records: dataset.rows.length };
  }
  if (["json", "csv", "tsv", "txt"].includes(extension)) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (extension === "json") JSON.parse(text);
  } else if (extension === "pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Некорректный PDF.");
  else if (extension === "docx" && !bytes.subarray(0, 2).equals(Buffer.from("PK"))) throw new Error("Некорректный DOCX.");
  return { file, bytes };
}
export async function cabinetTask(project: CabinetProject, asset: CabinetAsset, body: AssetBody) {
  if (asset.kind !== "source" || asset.id !== project.sourceId) throw new Error("Источник проекта не совпадает.");
  const task = taskSchema.parse({ schema: "rrp.agent-task.v1", source: { name: asset.name,
    text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(body.base64, "base64")) },
  reference: asset.reference, purpose: project.purpose, formUrl: project.formUrl,
  idHeader: project.idHeader, match: project.match, criteria: project.criteria });
  await workspaceFromTask(task); // Existing importer, ID and criterion checks, no new interpretation.
  return task;
}
