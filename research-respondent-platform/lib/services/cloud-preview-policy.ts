/** Diagnostics are limited to the explicitly enabled, SSO-protected Preview. */
export function cloudDiagnosticsEnabled(env: Record<string, string | undefined>): boolean {
  return env.VERCEL === "1" && env.VERCEL_ENV === "preview" && env.RRP_CLOUD_DIAGNOSTICS === "1"
    && /^[a-zA-Z0-9_-]{1,200}$/.test(env.BLOB_STORE_ID ?? "");
}
