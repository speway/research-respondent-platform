import type { Metadata } from "next";
import "./globals.css";
import { SiteNav } from "../components/site-nav.tsx";

export const metadata: Metadata = {
  title: "Research Respondent Platform",
  description:
    "Source-backed participant registry, psychometric assessment, cohort engine, form mapping and multi-agent task orchestration for documented research data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteNav />
        <main className="mx-auto w-full max-w-[1500px] px-4 pb-16 pt-4">{children}</main>
      </body>
    </html>
  );
}
