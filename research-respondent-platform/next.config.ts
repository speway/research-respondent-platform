import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The SQLite driver is a native Node module and must never be bundled by the
  // client compiler. All database access happens in server components, server
  // actions or route handlers.
  serverExternalPackages: ["better-sqlite3"],
  typedRoutes: false,
  // Native SQLite runtime loads these immutable files after deployment.
  outputFileTracingIncludes: { "/*": ["./db/migrations/*.sql", "./db/pragmas.sql", "./tools/browser-agent/runner.mjs", "./tools/cloud-agent/*.mjs"] },
};

export default nextConfig;
