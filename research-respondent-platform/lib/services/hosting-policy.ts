/** Fail closed until a durable deployment database has been implemented. */
export type HostingMode = "persistent-local" | "isolated-preview" | "blocked-production";

export function hostingMode(env: Record<string, string | undefined>): HostingMode {
  if (env.VERCEL_ENV === "preview") return "isolated-preview";
  if (env.VERCEL === "1" || env.VERCEL_ENV === "production") return "blocked-production";
  return "persistent-local";
}
