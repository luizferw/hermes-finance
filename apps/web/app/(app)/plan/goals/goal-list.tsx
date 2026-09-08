"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { contributeToGoal, deleteGoal } from "@/modules/goals/mutations";
import { formatMoney, formatRelativeDays } from "@/lib/format";
import { daysBetween, todayIso } from "@kosh/domain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface GoalRow {
  id: string;
  name: string;
  targetAmountMinor: number;
  currentAmountMinor: number;
  currencyCode: string;
  targetDate: string | null;
  achievedAt: string | null;
  createdAt: Date;
  accountName: string | null;
}

export function GoalList({ goals }: { goals: GoalRow[] }) {
  const router = useRouter();
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  function contribute(goal: GoalRow) {
    const amount = Number(amounts[goal.id] ?? "");
    if (!Number.isFinite(amount) || amount === 0) {
      toast.error("Enter a non-zero contribution");
      return;
    }
    setBusyId(goal.id);
    startTransition(async () => {
      try {
        await contributeToGoal(goal.id, amount);
        toast.success(`${goal.name} updated`);
        setAmounts((next) => ({ ...next, [goal.id]: "" }));
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not update goal");
      } finally {
        setBusyId(null);
      }
    });
  }

  function remove(goal: GoalRow) {
    setBusyId(goal.id);
    startTransition(async () => {
      try {
        await deleteGoal(goal.id);
        toast.success(`${goal.name} deleted`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not delete goal");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <ul>
      {goals.map((goal, i) => (
        <GoalTrajectory
          key={goal.id}
          goal={goal}
          index={i}
          amount={amounts[goal.id] ?? ""}
          busy={isPending && busyId === goal.id}
          onAmount={(v) => setAmounts((n) => ({ ...n, [goal.id]: v }))}
          onContribute={() => contribute(goal)}
          onRemove={() => remove(goal)}
        />
      ))}
    </ul>
  );
}

/**
 * A goal as a path: fern fill is progress, a hairline marker is where the goal
 * should be by now, so ahead/behind reads before any number. The contribution
 * control sits inline on the row — act without leaving the list.
 */
function GoalTrajectory({
  goal,
  index,
  amount,
  busy,
  onAmount,
  onContribute,
  onRemove,
}: {
  goal: GoalRow;
  index: number;
  amount: string;
  busy: boolean;
  onAmount: (v: string) => void;
  onContribute: () => void;
  onRemove: () => void;
}) {
  const today = todayIso();
  const ratio =
    goal.targetAmountMinor > 0
      ? goal.currentAmountMinor / goal.targetAmountMinor
      : goal.currentAmountMinor > 0
        ? 1
        : 0;
  const remaining = Math.max(0, goal.targetAmountMinor - goal.currentAmountMinor);
  const achieved = !!goal.achievedAt || ratio >= 1;
  const days = goal.targetDate ? daysBetween(today, goal.targetDate) : null;
  const pct = Math.round(Math.min(1, ratio) * 100);

  // Pace = elapsed share of the goal's timeline, via daysBetween only (no
  // impure Date.now() in render — the React Compiler forbids it).
  let pace: number | null = null;
  if (goal.targetDate) {
    const createdIso = goal.createdAt.toISOString().slice(0, 10);
    const total = daysBetween(createdIso, goal.targetDate);
    pace = total > 0 ? Math.min(1, Math.max(0, (total - (days ?? 0)) / total)) : 1;
  }
  const behind = !achieved && pace !== null && ratio < pace * 0.9;

  return (
    <li
      className="border-b border-border/50 py-5 first:pt-1 last:border-0"
      style={{ "--i": index } as React.CSSProperties}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="truncate text-[0.9375rem] font-medium text-foreground">
            {goal.name}
          </span>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {goal.accountName ?? "Manual"}
          </span>
        </div>
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="font-amount text-sm tabular-nums">
            {formatMoney(goal.currentAmountMinor, goal.currencyCode)}
          </span>
          <span className="font-amount text-xs text-muted-foreground/70 tabular-nums">
            / {formatMoney(goal.targetAmountMinor, goal.currencyCode)}
          </span>
        </span>
      </div>

      <div className="relative mt-2.5 h-2 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
        <span
          className={cn(
            "grow-x block h-full rounded-full",
            achieved ? "bg-success" : "bg-primary",
          )}
          style={
            { width: `${Math.max(2, ratio * 100)}%`, "--i": index } as React.CSSProperties
          }
        />
        {pace !== null && !achieved && pace > 0.02 && pace < 0.99 && (
          <span
            aria-hidden
            title="Where you should be by now"
            className="absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-foreground/45"
            style={{ left: `${pace * 100}%` }}
          />
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <p className={cn("text-xs", behind ? "text-destructive" : "text-muted-foreground")}>
          {achieved ? (
            <span className="font-medium text-success">Reached</span>
          ) : (
            <>
              <span className="font-amount tabular-nums text-foreground">
                {formatMoney(remaining, goal.currencyCode)}
              </span>{" "}
              to go · {pct}% there
              {days !== null && ` · target ${formatRelativeDays(days)}`}
            </>
          )}
        </p>

        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.01"
            inputMode="decimal"
            placeholder="Add / withdraw"
            className="h-7 w-32 text-xs"
            value={amount}
            onChange={(e) => onAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onContribute();
            }}
          />
          <Button variant="outline" size="sm" disabled={busy} onClick={onContribute}>
            {busy && <Spinner />}
            Save
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onRemove}
            aria-label="Delete goal"
          >
            <HugeiconsIcon icon={Delete02Icon} />
          </Button>
        </div>
      </div>
    </li>
  );
}
