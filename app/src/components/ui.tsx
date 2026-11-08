import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** A titled block with an optional aside. Used by all three consoles. */
export function Panel({
  title,
  description,
  icon: Icon,
  aside,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card flex flex-col gap-4 p-5">
      <header className="flex items-start gap-3">
        {Icon && (
          <span className="mt-0.5 rounded-lg bg-ink-800 p-2">
            <Icon className="size-4 text-held" aria-hidden />
          </span>
        )}
        <div className="flex-1">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="mt-1 text-xs leading-relaxed text-ink-400">
              {description}
            </p>
          )}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** A labelled figure. The value slots are monospaced by `.tabular`. */
export function Stat({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "neutral" | "pass" | "breach" | "held" | "warn";
  hint?: string;
}) {
  const toneClass = {
    neutral: "text-ink-100",
    pass: "text-pass",
    breach: "text-breach",
    held: "text-held",
    warn: "text-warn",
  }[tone];

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-850/60 px-3 py-2.5">
      <p className="label">{label}</p>
      <p className={`tabular mt-1 text-sm ${toneClass}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] text-ink-400">{hint}</p>}
    </div>
  );
}

/** Inline status chip for escrow and verdict states. */
export function Chip({
  tone,
  children,
}: {
  tone: "neutral" | "pass" | "breach" | "held" | "warn";
  children: ReactNode;
}) {
  const classes = {
    neutral: "border-ink-600 text-ink-300",
    pass: "border-pass/40 text-pass bg-pass/10",
    breach: "border-breach/40 text-breach bg-breach/10",
    held: "border-held/40 text-held bg-held/10",
    warn: "border-warn/40 text-warn bg-warn/10",
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${classes}`}
    >
      {children}
    </span>
  );
}

/** Errors get a consistent shape so a failure is never a bare string. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-breach/40 bg-breach/10 px-3 py-2 text-xs leading-relaxed text-breach">
      {children}
    </p>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-ink-700 px-3 py-6 text-center text-xs text-ink-400">
      {children}
    </p>
  );
}
