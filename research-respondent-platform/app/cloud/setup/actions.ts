"use server";

import { redirect } from "next/navigation";
import { cloudDiagnosticsEnabled } from "../../../lib/services/cloud-preview-policy.ts";
import { privateCloudProbeDependencies, runPrivateCloudProbe } from "../../../lib/services/private-cloud-probe.ts";

export async function runStorageProbeAction() {
  if (!cloudDiagnosticsEnabled(process.env)) redirect("/workbench");
  let status = "failed";
  try {
    await runPrivateCloudProbe(privateCloudProbeDependencies(process.env.BLOB_STORE_ID!));
    status = "verified";
  } catch {
    // Never expose provider messages, credential values or private URLs.
    console.error("rrp.cloud-storage-probe failed; no VM or respondent writes.");
  }
  redirect(`/cloud/setup?probe=${status}`);
}
