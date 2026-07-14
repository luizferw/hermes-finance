import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Wallet01Icon,
  Coins01Icon,
  Calendar03Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

interface Step {
  label: string;
  hint: string;
  href: string;
  icon: typeof Wallet01Icon;
  done: boolean;
}

/**
 * First-run guidance in place of an empty dashboard. Three concrete steps, each
 * a real link, with a live done-state — progressive, skippable, never a wall of
 * fields. Shown while the essentials are incomplete; disappears on its own once
 * there's enough to show a real picture.
 */
export function SetupChecklist({
  hasAccount,
  hasTransaction,
  hasSalaryDay,
}: {
  hasAccount: boolean;
  hasTransaction: boolean;
  hasSalaryDay: boolean;
}) {
  const steps: Step[] = [
    {
      label: "Add an account",
      hint: "A bank, card, or your cash wallet",
      href: "/accounts?new=1",
      icon: Wallet01Icon,
      done: hasAccount,
    },
    {
      label: "Log your first spend",
      hint: "Try the ask bar above — “coffee 180 upi”",
      href: "/transactions?new=1",
      icon: Coins01Icon,
      done: hasTransaction,
    },
    {
      label: "Set when you're paid",
      hint: "Sharpens your safe-to-spend",
      href: "/settings",
      icon: Calendar03Icon,
      done: hasSalaryDay,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="glass-panel rounded-2xl p-5 shadow-sm sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium tracking-tight">Get kosh set up</h2>
        <span className="font-amount text-xs text-muted-foreground tabular-nums">
          {doneCount} / {steps.length}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        A couple of minutes now and kosh starts answering questions about your money.
      </p>

      <ul className="mt-4 space-y-1.5">
        {steps.map((step) => (
          <li key={step.label}>
            <Link
              href={step.href}
              className={cn(
                "group flex items-center gap-3.5 rounded-xl px-3 py-3 outline-none transition-colors duration-[var(--duration-state)] ease-[var(--ease-out-quint)]",
                step.done ? "opacity-60" : "hover:bg-foreground/[0.035] focus-visible:bg-foreground/[0.04]",
              )}
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full",
                  step.done ? "bg-primary/15 text-primary" : "bg-foreground/[0.06] text-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={step.done ? CheckmarkCircle02Icon : step.icon}
                  className="size-[18px]"
                  strokeWidth={1.8}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block text-sm font-medium",
                    step.done && "text-muted-foreground line-through",
                  )}
                >
                  {step.label}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{step.hint}</span>
              </span>
              {!step.done && (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  className="size-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
                  strokeWidth={2}
                />
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
