import { cookies } from "next/headers";
import { ZodError } from "zod";
import { CABINET_COOKIE, CabinetError, configuredCabinet } from "./cabinet.ts";

export const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
export function cabinetResponse(body: unknown, status = 200) { return Response.json(body, { status, headers: privateHeaders }); }
export function cabinetFailure(error: unknown) {
  if (error instanceof CabinetError) return cabinetResponse({ error: error.message }, error.status);
  if (error instanceof ZodError || error instanceof SyntaxError || error instanceof TypeError) return cabinetResponse({ error: "Проверьте формат файла, ID и настройки проекта." }, 400);
  return cabinetResponse({ error: "Операция не завершена. Проверьте сохранённый каталог перед повтором." }, 503);
}
export function requireCabinetOrigin(request: Request) {
  // Neither a cookie nor a page's instructions are permission for cross-site writes.
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new CabinetError(403, "Недопустимый источник запроса.");
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new CabinetError(415, "Нужен JSON.");
}
export async function cabinetJson(request: Request) {
  const limit = 3 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw new CabinetError(413, "Запрос превышает 3 МБ.");
  if (!request.body) throw new CabinetError(400, "Пустой запрос.");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length;
    if (size > limit) { await reader.cancel(); throw new CabinetError(413, "Запрос превышает 3 МБ."); } chunks.push(result.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export async function requireCabinetAccount() {
  const cabinet = configuredCabinet();
  const account = await cabinet.session((await cookies()).get(CABINET_COOKIE)?.value);
  if (!account) throw new CabinetError(401, "Войдите в кабинет.");
  return { cabinet, account };
}
