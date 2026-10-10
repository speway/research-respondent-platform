import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The SQLite driver is a native Node module and must never be bundled by the
  // client compiler. All database access happens in server components, server
  // actions or route handlers.
  serverExternalPackages: ["better-sqlite3"],
  typedRoutes: false,
};

export default nextConfig;
