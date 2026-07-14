"use client";

import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  Invoice01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { formatMoney, formatDateShort, formatRelativeDays } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AskAnswer, AskFollowUp } from "@/modules/ask/answer";

/**
 * Renders a deterministic ask-kosh answer inline: a figure, a ranked
 * breakdown, a transaction group, an agenda, or a month comparison — never a
 * wall of prose. Every number here was computed server-side; this only paints
 * it. Follow-up chips re-ask kosh; the title links drill into the full screen.
 */
export function AskAnswerCard({
  answer,
  onFollowUp,
  onDismiss,
}: {
  answer: AskAnswer;
  onFollowUp: (query: string) => void;
  onDismiss: () => void;
}) {
  if (answer.kind === "none") return null;

  return (
    <div className="glass-panel panel-in mt-3 overflow-hidden rounded-2xl p-5 shadow-sm">
      <Body answer={answer} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {"href" in answer && answer.href && (
          <DrillLink href={answer.href} />
        )}
        {"followUps" in answer &&
          answer.followUps?.map((f) => (
            <FollowChip key={f.query} f={f} onFollowUp={onFollowUp} />
          ))}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss answer"
          className="ml-auto inline-flex size-7 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

function Body({ answer }: { answer: AskAnswer }) {
  switch (answer.kind) {
    case "navigate":
      return (
        <p className="text-sm text-muted-foreground">
          Opening <span className="font-medium text-foreground">{answer.label}</span>…
        </p>
      );

    case "amount":
      return (
        <div>
          <span className="micro-label">{answer.title}</span>
          <p className="mt-1 font-amount text-[clamp(1.75rem,4vw,2.5rem)] leading-[0.95] font-medium tracking-[-0.03em] tabular-nums">
            {formatMoney(answer.amountMinor, answer.currency)}
          </p>
          {answer.caption && (
            <p className="mt-1.5 text-sm text-muted-foreground">{answer.caption}</p>
          )}
        </div>
      );

    case "categories": {
      const max = answer.rows[0]?.spentMinor ?? 1;
      return (
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="micro-label">{answer.title}</span>
            <span className="font-amount text-sm text-muted-foreground tabular-nums">
              {formatMoney(answer.totalMinor, answer.currency)}
            </span>
          </div>
          <ul className="mt-3 space-y-2.5">
            {answer.rows.map((r, i) => {
              const w = max > 0 ? (r.spentMinor / max) * 100 : 0;
              const color = r.color ?? "var(--chart-1)";
              return (
                <li key={r.name} style={{ "--i": i } as React.CSSProperties}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-[3px]"
                        style={{ background: color }}
                      />
                      <span className="truncate">{r.name}</span>
                    </span>
                    <span className="font-amount tabular-nums">
                      {formatMoney(r.spentMinor, answer.currency)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.05]">
                    <span
                      className="grow-x block h-full rounded-full"
                      style={{ width: `${w}%`, background: color, "--i": i } as React.CSSProperties}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      );
    }

    case "transactions":
      return (
        <div>
          <span className="micro-label">{answer.title}</span>
          {answer.txns.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul className="mt-2">
              {answer.txns.map((t, i) => (
                <li
                  key={t.id}
                  className="row-in grid grid-cols-[auto_1fr_auto] items-center gap-x-4 border-b border-border/50 py-2.5 last:border-0"
                  style={{ "--i": i } as React.CSSProperties}
                >
                  <span className="font-amount text-xs text-muted-foreground tabular-nums">
                    {formatDateShort(t.date)}
                  </span>
                  <span className="min-w-0 truncate text-sm">{t.description}</span>
                  <span
                    className={cn(
                      "font-amount text-sm tabular-nums",
                      t.amountMinor > 0 ? "text-success" : "text-foreground",
                    )}
                  >
                    {formatMoney(t.amountMinor, t.currencyCode)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {answer.moreCount > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              +{answer.moreCount} more
            </p>
          )}
        </div>
      );

    case "bills":
      return (
        <div>
          <span className="micro-label">{answer.title}</span>
          <ul className="mt-2 space-y-0.5">
            {answer.rows.map((b, i) => (
              <li
                key={b.id}
                className="row-in flex items-center gap-3 py-1.5"
                style={{ "--i": i } as React.CSSProperties}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <HugeiconsIcon icon={Invoice01Icon} className="size-4" strokeWidth={1.8} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{b.name}</p>
                  <p
                    className={cn(
                      "text-xs",
                      b.overdue ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {b.overdue
                      ? `overdue · ${formatDateShort(b.dueDate)}`
                      : b.daysUntilDue > 0
                        ? `due ${formatRelativeDays(b.daysUntilDue)}`
                        : `next ${formatDateShort(b.dueDate)}`}
                  </p>
                </div>
                <span className="font-amount text-sm tabular-nums">
                  {formatMoney(b.amountMinor, b.currencyCode)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );

    case "compare":
      return (
        <div>
          <span className="micro-label">{answer.title}</span>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <ComparePane pane={answer.a} currency={answer.currency} />
            <ComparePane pane={answer.b} currency={answer.currency} accent />
          </div>
        </div>
      );

    default:
      return null;
  }
}

function ComparePane({
  pane,
  currency,
  accent,
}: {
  pane: { label: string; incomeMinor: number; expenseMinor: number; netMinor: number };
  currency: string;
  accent?: boolean;
}) {
  return (
    <div className={cn("min-w-0", accent && "rounded-lg bg-foreground/[0.03] p-3")}>
      <p className="text-sm font-medium">{pane.label}</p>
      <dl className="mt-1.5 space-y-1 text-sm">
        <Row label="Earned" value={formatMoney(pane.incomeMinor, currency)} />
        <Row label="Spent" value={formatMoney(pane.expenseMinor, currency)} />
        <Row
          label="Kept"
          value={formatMoney(pane.netMinor, currency, { signDisplay: "exceptZero" })}
          tone={pane.netMinor >= 0 ? "pos" : "neg"}
        />
      </dl>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-amount tabular-nums",
          tone === "pos" && "text-success",
          tone === "neg" && "text-destructive",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function DrillLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1 rounded-full bg-primary/[0.08] px-3 py-1.5 text-sm font-medium text-primary outline-none ring-1 ring-inset ring-primary/20 transition-colors hover:bg-primary/[0.12] focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      Open
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        className="size-3.5 transition-transform group-hover:translate-x-0.5"
        strokeWidth={2}
      />
    </Link>
  );
}

function FollowChip({
  f,
  onFollowUp,
}: {
  f: AskFollowUp;
  onFollowUp: (q: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onFollowUp(f.query)}
      className="inline-flex items-center rounded-full bg-card/70 px-3 py-1.5 text-sm text-muted-foreground outline-none ring-1 ring-inset ring-border/70 transition-colors hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {f.label}
    </button>
  );
}
