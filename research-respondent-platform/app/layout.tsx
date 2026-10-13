import type { Metadata } from "next";
import "./globals.css";
import { SiteNav } from "../components/site-nav.tsx";

export const metadata: Metadata = {
  title: "Кворум · Исследования и участие",
  description:
    "Обмен опросами, подтверждённые человеческие ответы и слепая проверка персонального агента.",
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
