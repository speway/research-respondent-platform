import { get, list, put, BlobPreconditionFailedError } from "@vercel/blob";
export interface CabinetStore {
  read(path: string, maxBytes?: number): Promise<{ body: string; etag: string } | null>;
  write(path: string, value: unknown, etag?: string): Promise<void>;
  paths(prefix: string): Promise<string[]>;
}
export function privateCabinetStore(storeId: string): CabinetStore {
  if (!/^store_[A-Za-z0-9]+$/.test(storeId)) throw new Error("Invalid cabinet store.");
  return {
    async read(path, maxBytes = 3 * 1024 * 1024) {
      const result = await get(path, { access: "private", storeId, useCache: false });
      if (!result) return null;
      if (result.statusCode !== 200 || result.blob.size > maxBytes) throw new Error("Invalid private record.");
      return { body: await new Response(result.stream).text(), etag: result.headers.get("etag") ?? "" };
    },
    async write(path, value, etag) {
      await put(path, JSON.stringify(value), { access: "private", storeId,
        contentType: "application/json", addRandomSuffix: false, allowOverwrite: !!etag,
        ...(etag ? { ifMatch: etag } : {}), cacheControlMaxAge: 60 });
    },
    async paths(prefix) {
      const result = await list({ storeId, prefix, limit: 1000 });
      if (result.hasMore) throw new Error("Каталог превысил лимит. Нужна миграция индекса.");
      return result.blobs.map((blob) => blob.pathname);
    },
  };
}
/** A concurrent write loses its ETag lease and fails closed, never resets the counter. */
export async function reserveCabinetAttempt(store: CabinetStore, path: string, limit: number) {
  const record = await store.read(path, 100);
  const count = record ? JSON.parse(record.body).count as unknown : 0;
  if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) >= limit) return false;
  if (record && !record.etag) throw new Error("Rate limit requires a provider ETag.");
  try { await store.write(path, { count: Number(count) + 1 }, record?.etag); }
  catch (error) { if (error instanceof BlobPreconditionFailedError) return false; throw error; }
  return true;
}
