"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const NAV_ITEMS: Array<{ href: string; label: string; hint: string }> = [
  { href: "/", label: "Overview", hint: "Studies, data-quality signals and pending work" },
  { href: "/studies", label: "Studies", hint: "Protocols, eligibility criteria, timepoints" },
  { href: "/participants", label: "Participants", hint: "Registry, evidence, consent, response history" },
  { href: "/library", label: "Psychological Library", hint: "Instruments, versions, scales, scoring rules" },
  { href: "/cohorts", label: "Cohorts", hint: "Rule builder, eligibility explanations, snapshots" },
  { href: "/forms", label: "Forms & Mappings", hint: "Form versions, field mapping, preflight" },
  { href: "/agents", label: "Agents & Tasks", hint: "Registration, approvals, runs, retries" },
  { href: "/audit", label: "Audit & Exports", hint: "Provenance, retention, export jobs" },
  { href: "/settings", label: "Settings", hint: "Roles, integrations, security configuration" },
];

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  if (pathname === "/workbench" || pathname === "/cabinet") return null;
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <header className="border-b border-[#dfe3e8] bg-white">
      <div className="mx-auto flex w-full max-w-[1500px] items-center gap-3 px-4 py-2">
        <Link href="/" className="flex items-center gap-2 whitespace-nowrap">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-[#1d4ed8] text-xs font-bold text-white">
            Ψ
          </span>
          <span className="text-[0.8125rem] font-semibold tracking-tight">Research Respondent Platform</span>
        </Link>
        <nav aria-label="Primary" className="ml-4 hidden flex-1 items-center gap-0.5 lg:flex">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              title={item.hint}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={`rounded px-2 py-1 text-[0.8125rem] no-underline ${
                isActive(item.href)
                  ? "bg-[#e8edfd] font-semibold text-[#1b3ea8]"
                  : "text-[#27313d] hover:bg-[#f2f4f7]"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/settings" className="hidden text-[0.75rem] text-[#55606d] no-underline hover:underline sm:inline">
            roles & integrations
          </Link>
          <button
            type="button"
            className="btn lg:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((value) => !value)}
          >
            Menu
          </button>
        </div>
      </div>
      {open ? (
        <nav
          id="mobile-nav"
          aria-label="Primary mobile"
          className="border-t border-[#dfe3e8] bg-white px-4 py-2 lg:hidden"
        >
          <ul className="grid gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`block rounded px-2 py-1.5 text-[0.8125rem] no-underline ${
                    isActive(item.href) ? "bg-[#e8edfd] font-semibold text-[#1b3ea8]" : "text-[#27313d]"
                  }`}
                >
                  {item.label}
                  <span className="block text-[0.6875rem] text-[#55606d]">{item.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
