/**
 * Small presentational primitives shared by every screen. They render real data
 * states, including explicit "missing" markers, and never fabricate values.
 */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className ?? ""}`}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-[0.75rem] text-[#55606d]">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="empty-state">{children}</p>;
}

export function Metric({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "neutral" | "verified" | "partial" | "missing" | "blocked";
}) {
  const toneClass =
    tone === "verified"
      ? "text-[#14663a]"
      : tone === "partial"
        ? "text-[#8a5309]"
        : tone === "blocked"
          ? "text-[#98211f]"
          : tone === "missing"
            ? "text-[#5b6470]"
            : "text-[#10161d]";
  return (
    <div className="panel px-3 py-2">
      <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.05em] text-[#55606d]">{label}</p>
      <p className={`mt-0.5 font-mono text-lg font-semibold ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[0.6875rem] text-[#55606d]">{hint}</p> : null}
    </div>
  );
}

export function Chip({
  tone = "neutral",
  children,
  title,
}: {
  tone?: "verified" | "partial" | "missing" | "blocked" | "info" | "neutral";
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Renders a value or an explicit missing marker - never a placeholder number. */
export function ValueOrMissing({
  value,
  reason,
}: {
  value: string | number | null | undefined;
  reason?: string | null;
}) {
  if (value === null || value === undefined || value === "") {
    return (
      <span className="chip chip-missing" title={reason ?? "not documented in the source"}>
        missing
      </span>
    );
  }
  return <span className="mono">{value}</span>;
}

export function Note({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn" | "fail" | "ok";
  children: React.ReactNode;
}) {
  const cls = tone === "neutral" ? "note" : `note note-${tone}`;
  return <div className={cls}>{children}</div>;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(decimals);
}

export function stateTone(state: string): "verified" | "partial" | "missing" | "blocked" | "info" | "neutral" {
  switch (state) {
    case "succeeded":
    case "approved":
    case "validated":
    case "completed":
    case "active":
      return "verified";
    case "running":
    case "queued":
    case "pending":
    case "draft":
    case "enrolled":
    case "invited":
      return "info";
    case "needs_review":
    case "partial":
      return "partial";
    case "failed":
    case "cancelled":
    case "withdrawn":
    case "excluded":
    case "expired":
    case "rejected":
    case "stale":
      return "blocked";
    default:
      return "neutral";
  }
}
