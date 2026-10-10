/** Private, immutable cloud budget markers. No respondent records or credentials. */
import { put, type PutCommandOptions } from "@vercel/blob";

type MarkerWriter = (path: string, body: string, options: PutCommandOptions) => Promise<unknown>;
export function createPrivateCloudBudgetJournal({ storeId = process.env.BLOB_STORE_ID, writer = put }: { storeId?: string; writer?: MarkerWriter } = {}) {
  if (!storeId || !/^[a-zA-Z0-9_-]{1,200}$/.test(storeId)) throw new Error("A configured private Blob store is required for the cloud budget journal.");
  return {
    async claim(key: string): Promise<boolean> {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid cloud budget reservation key.");
      // Provider create-only write; never head/list then put, overwrite, delete or expire.
      // Any duplicate, denied, failed or uncertain write throws before VM allocation.
      await writer(`rrp/cloud-audit-budget/v1/${key}.json`, '{"schema":"rrp.cloud-budget-reservation.v1"}', {
        access: "private", storeId, addRandomSuffix: false, allowOverwrite: false,
        contentType: "application/json", cacheControlMaxAge: 60,
      });
      return true;
    },
  };
}
