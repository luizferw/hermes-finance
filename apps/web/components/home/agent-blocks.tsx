"use client";

import * as React from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Invoice01Icon,
  CheckmarkCircle02Icon,
  Alert02Icon,
  MagicWand01Icon,
  ArrowRight01Icon,
  Copy01Icon,
} from "@hugeicons/core-free-icons";
import { formatMoney, formatDateShort, formatRelativeDays } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ResponseBlock } from "@/modules/agent/types";
import { ConfirmationCard } from "./confirmation-card";
import { AssistantMarkdown } from "@/components/ask/assistant-markdown";

/** Render an ordered list of structured assistant blocks. Figures here come
 * from tool results — the model never computes them. */
export function AgentBlocks({
  blocks,
  onConfirmDone,
  onFollowUp,
}: {
  blocks: ResponseBlock[];
  onConfirmDone: () => void;
  onFollowUp: (q: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const copyable = blocks.map(blockText).filter(Boolean).join("\n\n");

  if (blocks.length === 0) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Kosh returned no answer. Try asking again with a little more detail.
      </p>
    );
  }

  return (
    <article aria-label="Kosh response" className="group/answer min-w-0">
      <div className="mb-2 flex h-6 items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Kosh</span>
        {copyable && (
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(copyable);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 opacity-70 transition-colors hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/answer:opacity-100"
            aria-label="Copy response"
          >
            <HugeiconsIcon icon={Copy01Icon} className="size-3.5" strokeWidth={1.8} />
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <div className="space-y-3">
        {blocks.map((b, i) => (
          <div
            key={i}
            data-message-kind={b.type === "text" ? "assistant" : b.type === "warning" ? "error" : "tool"}
          >
            <Block block={b} onConfirmDone={onConfirmDone} onFollowUp={onFollowUp} />
          </div>
        ))}
      </div>
    </article>
  );
}

function Block({
  block,
  onConfirmDone,
  onFollowUp,
}: {
  block: ResponseBlock;
  onConfirmDone: () => void;
  onFollowUp: (q: string) => void;
}) {
  switch (block.type) {
    case "text":
      return <AssistantMarkdown>{block.text}</AssistantMarkdown>;

    case "warning":
      return (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-warning/[0.08] px-3.5 py-2.5 text-sm text-foreground ring-1 ring-inset ring-warning/20">
          <HugeiconsIcon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.8} />
          {block.text}
        </p>
      );

    case "result":
      return (
        <p className="flex items-center gap-2 rounded-xl bg-success/[0.08] px-3.5 py-2.5 text-sm text-foreground ring-1 ring-inset ring-success/20">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-4 shrink-0 text-success" strokeWidth={1.8} />
          <span className="font-medium">{block.title}</span>
          {block.detail && <span className="text-muted-foreground">· {block.detail}</span>}
        </p>
      );

    case "figure":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          <p
            className={cn(
              "mt-1 font-amount text-[clamp(1.5rem,4vw,2.25rem)] leading-[0.95] font-medium tracking-[-0.03em] tabular-nums",
              block.figure.tone === "negative" && "text-destructive",
              block.figure.tone === "positive" && "text-success",
            )}
          >
            {formatMoney(block.figure.amountMinor, block.figure.currency)}
          </p>
          {block.caption && <p className="mt-1.5 text-sm text-muted-foreground">{block.caption}</p>}
        </div>
      );

    case "breakdown": {
      const max = block.rows[0]?.spentMinor ?? 1;
      return (
        <div className="glass-panel rounded-2xl p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="micro-label">{block.title}</span>
            <span className="font-amount text-sm text-muted-foreground tabular-nums">
              {formatMoney(block.totalMinor, block.currency)}
            </span>
          </div>
          <ul className="mt-3 space-y-2.5">
            {block.rows.map((r, i) => {
              const w = max > 0 ? (r.spentMinor / max) * 100 : 0;
              const color = r.color ?? "var(--chart-1)";
              return (
                <li key={r.name} style={{ "--i": i } as React.CSSProperties}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className="size-2 shrink-0 rounded-[3px]" style={{ background: color }} />
                      <span className="truncate">{r.name}</span>
                    </span>
                    <span className="font-amount tabular-nums">{formatMoney(r.spentMinor, block.currency)}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.05]">
                    <span className="grow-x block h-full rounded-full" style={{ width: `${w}%`, background: color, "--i": i } as React.CSSProperties} />
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
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          {block.rows.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul className="mt-2">
              {block.rows.map((t, i) => (
                <li
                  key={t.id}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 border-b border-border/50 py-2.5 last:border-0"
                  style={{ "--i": i } as React.CSSProperties}
                >
                  <span className="font-amount text-xs text-muted-foreground tabular-nums">{formatDateShort(t.date)}</span>
                  <span className="min-w-0 truncate text-sm">{t.description}</span>
                  <span className={cn("font-amount text-sm tabular-nums", t.amountMinor > 0 ? "text-success" : "text-foreground")}>
                    {formatMoney(t.amountMinor, t.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {block.moreCount > 0 && <p className="mt-2 text-xs text-muted-foreground">+{block.moreCount} more</p>}
          {block.href && (
            <Link href={block.href} className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
              Open all →
            </Link>
          )}
        </div>
      );

    case "comparison":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          <div className="mt-3 grid grid-cols-2 gap-4">
            {[block.a, block.b].map((p, idx) => (
              <div key={p.label} className={cn("min-w-0", idx === 1 && "rounded-lg bg-foreground/[0.03] p-3")}>
                <p className="text-sm font-medium">{p.label}</p>
                <dl className="mt-1.5 space-y-1 text-sm">
                  <CmpRow label="Earned" value={formatMoney(p.incomeMinor, block.currency)} />
                  <CmpRow label="Spent" value={formatMoney(p.expenseMinor, block.currency)} />
                  <CmpRow label="Kept" value={formatMoney(p.netMinor, block.currency, { signDisplay: "exceptZero" })} tone={p.netMinor >= 0 ? "pos" : "neg"} />
                </dl>
              </div>
            ))}
          </div>
        </div>
      );

    case "accounts":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          <ul className="mt-2 space-y-1.5">
            {block.rows.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 text-sm">
                <Link href={`/accounts/${a.id}`} className="truncate text-muted-foreground hover:text-foreground">
                  {a.name}
                </Link>
                <span className="font-amount tabular-nums">{formatMoney(a.balanceMinor, a.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      );

    case "commitments":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          <ul className="mt-2 space-y-0.5">
            {block.rows.map((b, i) => (
              <li key={b.id} className="flex items-center gap-3 py-1.5" style={{ "--i": i } as React.CSSProperties}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <HugeiconsIcon icon={Invoice01Icon} className="size-4" strokeWidth={1.8} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{b.name}</p>
                  <p className={cn("text-xs", b.overdue ? "text-destructive" : "text-muted-foreground")}>
                    {b.overdue ? `overdue · ${formatDateShort(b.dueDate)}` : b.daysUntilDue > 0 ? `due ${formatRelativeDays(b.daysUntilDue)}` : `next ${formatDateShort(b.dueDate)}`}
                  </p>
                </div>
                <span className="font-amount text-sm tabular-nums">{formatMoney(b.amountMinor, b.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      );

    case "safeToSpend":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="micro-label">{block.title}</span>
            <span className="text-xs text-muted-foreground">{block.period}</span>
          </div>
          <p
            className={cn(
              "mt-1 font-amount text-3xl font-medium tracking-[-0.03em] tabular-nums",
              block.safeMinor < 0 ? "text-destructive" : "text-success",
            )}
          >
            {formatMoney(block.safeMinor, block.currency)}
          </p>
          <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-xs">
            <MoneyDatum label="Recorded income" value={block.incomeMinor} currency={block.currency} />
            <MoneyDatum label="Recorded spend" value={block.expenseMinor} currency={block.currency} />
            <MoneyDatum label="Bills due" value={block.committedMinor} currency={block.currency} />
          </dl>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">{block.note}</p>
        </div>
      );

    case "budgets":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="micro-label">{block.title}</span>
            <span className="text-xs text-muted-foreground">{block.period}</span>
          </div>
          {block.rows.length === 0 ? (
            <MissingLine href="/plan/budgets">No budgets are set up yet.</MissingLine>
          ) : (
            <ul className="mt-3 space-y-3">
              {block.rows.map((budget) => (
                <li key={budget.id}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <Link href="/plan/budgets" className="truncate font-medium hover:underline">
                      {budget.name}
                    </Link>
                    <span className={cn("font-amount shrink-0 tabular-nums", budget.isOver && "text-destructive")}>
                      {formatMoney(budget.spentMinor, budget.currency)} / {formatMoney(budget.plannedMinor, budget.currency)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                    <span
                      className={cn("block h-full rounded-full", budget.isOver ? "bg-destructive" : "bg-primary")}
                      style={{ width: `${Math.min(100, budget.ratio * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {budget.isOver
                      ? `${formatMoney(Math.abs(budget.remainingMinor), budget.currency)} over`
                      : `${formatMoney(budget.remainingMinor, budget.currency)} left`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "goals":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          {block.rows.length === 0 ? (
            <MissingLine href="/plan/goals">No savings goals are set up yet.</MissingLine>
          ) : (
            <ul className="mt-3 space-y-3">
              {block.rows.map((goal) => (
                <li key={goal.id}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <Link href="/plan/goals" className="truncate font-medium hover:underline">{goal.name}</Link>
                    <span className="font-amount shrink-0 tabular-nums">
                      {formatMoney(goal.currentMinor, goal.currency)} / {formatMoney(goal.targetMinor, goal.currency)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                    <span className="block h-full rounded-full bg-success" style={{ width: `${goal.ratio * 100}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {Math.round(goal.ratio * 100)}% complete{goal.targetDate ? ` · target ${formatDateShort(goal.targetDate)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "recurring":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          {block.rows.length === 0 ? (
            <MissingLine href="/plan/recurring">No recurring transactions are tracked yet.</MissingLine>
          ) : (
            <ul className="mt-2 divide-y divide-border/60">
              {block.rows.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">{row.interval} · next {formatDateShort(row.nextDate)}</p>
                  </div>
                  <span className="font-amount shrink-0 text-sm tabular-nums">{formatMoney(row.amountMinor, row.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "cashflow":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="micro-label">{block.title}</span>
            <span className="text-xs text-muted-foreground">{block.range}</span>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2">
            <MoneyDatum label="In" value={block.inflowMinor} currency={block.currency} tone="positive" />
            <MoneyDatum label="Out" value={block.outflowMinor} currency={block.currency} />
            <MoneyDatum label="Net" value={block.netMinor} currency={block.currency} tone={block.netMinor >= 0 ? "positive" : "negative"} />
          </dl>
        </div>
      );

    case "anomalies":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          {block.rows.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">There is not enough month-to-month movement to compare yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border/60">
              {block.rows.map((row) => (
                <li key={row.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatMoney(row.priorMinor, block.currency)} → {formatMoney(row.currentMinor, block.currency)}
                    </p>
                  </div>
                  <span className={cn("font-amount shrink-0 tabular-nums", row.deltaMinor > 0 ? "text-destructive" : "text-success")}>
                    {row.isNew ? "new" : row.deltaPct === null ? "—" : `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct}%`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">{block.note}</p>
        </div>
      );

    case "missingData":
      return (
        <div className="rounded-2xl border border-border/70 bg-card/70 p-4">
          <span className="micro-label">{block.title}</span>
          {block.items.length === 0 ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-foreground">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-4 text-success" strokeWidth={1.8} />
              Core finance data is ready.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {block.items.map((item) => (
                <li key={item.href} className="text-sm">
                  <Link href={item.href} className="font-medium text-primary hover:underline">{item.label}</Link>
                  <p className="text-xs leading-5 text-muted-foreground">{item.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "currencyWarning":
      return (
        <p className="flex items-start gap-2 rounded-xl bg-warning/[0.08] px-3.5 py-2.5 text-xs leading-5 text-foreground ring-1 ring-inset ring-warning/20">
          <HugeiconsIcon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.8} />
          <span>
            <strong>Currency boundary:</strong> {block.text} Found {block.otherCurrencies.join(", ")} alongside {block.defaultCurrency}.
          </span>
        </p>
      );

    case "goalProjection":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          <ul className="mt-2 space-y-1.5 text-sm">
            {block.lines.map((l, i) => (
              <li key={i} className="text-foreground">{l}</li>
            ))}
          </ul>
        </div>
      );

    case "ruleDraft": {
      const d = block.draft;
      return (
        <div className="glass-panel rounded-2xl p-4 ring-1 ring-inset ring-primary/15">
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={MagicWand01Icon} className="size-4 shrink-0 text-primary" strokeWidth={1.8} />
            <span className="micro-label">Rule draft · dry run</span>
          </div>
          <p className="mt-1.5 text-sm font-medium text-foreground">{d.name}</p>
          <dl className="mt-3 space-y-1.5 border-t border-border/50 pt-3 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">When</dt>
              <dd className="text-right font-medium">{d.conditions.map((c) => c.label).join(d.matchAll ? " AND " : " OR ")}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Then</dt>
              <dd className="text-right font-medium">{d.actions.map((a) => a.label).join(", ")}</dd>
            </div>
          </dl>
          <p className="mt-3 text-sm">
            <span className="font-amount font-medium tabular-nums">{d.matchedCount}</span>
            <span className="text-muted-foreground"> of {d.scannedCount} transactions would match.</span>
          </p>
          {d.sample.length > 0 && (
            <ul className="mt-2 space-y-1">
              {d.sample.slice(0, 5).map((s, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate">{s.description}</span>
                  <span className="font-amount shrink-0 tabular-nums">{formatMoney(s.amountMinor, s.currency)}</span>
                </li>
              ))}
            </ul>
          )}
          {d.warning && (
            <p className="mt-3 flex items-start gap-2 text-xs text-warning">
              <HugeiconsIcon icon={Alert02Icon} className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.8} />
              {d.warning}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onFollowUp(`create the rule "${d.name}" exactly as drafted`)}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.02] active:scale-95"
            >
              Activate rule
            </button>
            <button
              type="button"
              onClick={() => onFollowUp("narrow this rule so it matches fewer transactions")}
              className="inline-flex items-center rounded-full bg-card/70 px-4 py-1.5 text-sm text-foreground ring-1 ring-inset ring-border/70 transition-colors hover:bg-card"
            >
              Narrow it
            </button>
          </div>
        </div>
      );
    }

    case "ruleList":
      return (
        <div className="glass-panel rounded-2xl p-4">
          <span className="micro-label">{block.title}</span>
          {block.rules.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No rules yet.</p>
          ) : (
            <ul className="mt-2 space-y-0.5">
              {block.rules.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-1.5">
                  <span className={cn("size-2 shrink-0 rounded-full", r.isActive ? "bg-success" : "bg-muted-foreground/40")} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.conditionCount} condition{r.conditionCount !== 1 && "s"} · {r.actionCount} action{r.actionCount !== 1 && "s"}
                      {r.lastRun ? ` · last applied ${r.lastRun.applied}` : ""}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">{r.isActive ? "on" : "off"}</span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/automations" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Manage rules <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" strokeWidth={2} />
          </Link>
        </div>
      );

    case "proposal":
      return <ConfirmationCard proposal={block.proposal} onDone={onConfirmDone} onFollowUp={onFollowUp} />;

    default:
      return null;
  }
}

function CmpRow({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-amount tabular-nums", tone === "pos" && "text-success", tone === "neg" && "text-destructive")}>{value}</dd>
    </div>
  );
}

function MoneyDatum({
  label,
  value,
  currency,
  tone,
}: {
  label: string;
  value: number;
  currency: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 break-words font-amount text-sm tabular-nums",
          tone === "positive" && "text-success",
          tone === "negative" && "text-destructive",
        )}
      >
        {formatMoney(value, currency)}
      </dd>
    </div>
  );
}

function MissingLine({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <p className="mt-2 text-sm text-muted-foreground">
      {children}{" "}
      <Link href={href} className="font-medium text-primary hover:underline">Set it up</Link>
    </p>
  );
}

function blockText(block: ResponseBlock): string {
  switch (block.type) {
    case "text":
    case "warning":
      return block.text;
    case "result":
      return [block.title, block.detail].filter(Boolean).join(" — ");
    case "currencyWarning":
      return block.text;
    case "proposal":
      return `${block.proposal.title} — ${block.proposal.summary}`;
    default:
      return "title" in block ? block.title : "";
  }
}
