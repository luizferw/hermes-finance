import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ChartLineData01Icon,
  Invoice01Icon,
  MagicWand01Icon,
  PieChart01Icon,
  Shield01Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { BrandWordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

const FEATURES = [
  {
    icon: Wallet01Icon,
    title: "Accounts and imports",
    text: "Track banks, cash, cards, loans, CSV imports, duplicates, and review queues.",
  },
  {
    icon: PieChart01Icon,
    title: "Budgets and bills",
    text: "Plan monthly envelopes, recurring payments, goals, and due-date reminders.",
  },
  {
    icon: MagicWand01Icon,
    title: "Automation",
    text: "Create rules for repeated merchants, categories, tags, and import cleanup.",
  },
  {
    icon: ChartLineData01Icon,
    title: "Private reports",
    text: "Cashflow, net worth, category spending, and operator health in one place.",
  },
] as const;

export default function Home() {
  const showDemoCredentials = process.env.NODE_ENV !== "production";
  return (
    <main className="min-h-screen bg-background">
      <section className="relative overflow-hidden border-b border-ledger">
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,color-mix(in_oklch,var(--primary),transparent_78%),transparent_35%),linear-gradient(180deg,var(--background),var(--muted))]"
        />
        <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-10 px-4 py-8 md:grid-cols-[0.9fr_1.1fr] md:px-6">
          <div className="space-y-6">
            <BrandWordmark />
            <div className="space-y-4">
              <Badge variant="secondary" className="w-fit">
                Self-hosted, privacy-first finance
              </Badge>
              <h1 className="max-w-xl font-serif text-5xl leading-[0.98] font-normal tracking-tight text-foreground md:text-7xl">
                Kosh
              </h1>
              <p className="max-w-xl text-base leading-7 text-muted-foreground md:text-lg">
                Personal finance for people who want budgets, cashflow, net
                worth, imports, automation, and health checks on their own
                server.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/register">Create account</Link>
              </Button>
            </div>
            {showDemoCredentials && (
              <p className="text-xs text-muted-foreground">
                Demo after seeding:{" "}
                <span className="font-amount">demo@kosh.local / demo1234</span>
              </p>
            )}
          </div>

          <DashboardPreview />
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 py-10 md:grid-cols-4 md:px-6">
        {FEATURES.map((feature) => (
          <Card key={feature.title} className="gap-3 px-5 py-4">
            <HugeiconsIcon icon={feature.icon} className="size-5 text-primary" />
            <div>
              <h2 className="font-medium">{feature.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{feature.text}</p>
            </div>
          </Card>
        ))}
      </section>
    </main>
  );
}

function DashboardPreview() {
  return (
    <div className="rounded-xl border bg-card p-3 shadow-2xl shadow-foreground/10">
      <div className="rounded-lg border border-ledger bg-background">
        <div className="flex items-center justify-between border-b border-ledger px-4 py-3">
          <div>
            <p className="micro-label">Overview</p>
            <p className="text-sm font-medium">Demo household</p>
          </div>
          <Badge className="bg-success/10 text-success">
            <HugeiconsIcon icon={Shield01Icon} className="size-3" />
            Local
          </Badge>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <PreviewStat label="Net worth" value="₹12,48,320" hint="+₹38,400 this month" />
          <PreviewStat label="Cashflow" value="+₹52,600" hint="Income minus spending" />
          <PreviewStat label="Spent" value="₹72,940" hint="62% of plan" />
          <PreviewStat label="Review" value="14" hint="Imported transactions" />
        </div>
        <div className="grid gap-3 p-4 pt-0 md:grid-cols-[1fr_0.8fr]">
          <div className="rounded-lg border border-ledger p-3">
            <div className="mb-3 flex items-center justify-between">
              <p className="micro-label">Cashflow</p>
              <HugeiconsIcon icon={ChartLineData01Icon} className="size-4 text-primary" />
            </div>
            <div className="flex h-36 items-end gap-1.5">
              {[28, 42, 35, 58, 46, 72, 38, 64, 76, 52, 88, 70].map(
                (height, index) => (
                  <span
                    key={index}
                    className="flex-1 rounded-t-sm bg-primary/70"
                    style={{ height: `${height}%` }}
                  />
                ),
              )}
            </div>
          </div>
          <div className="space-y-3">
            <PreviewRow
              icon={PieChart01Icon}
              label="Groceries"
              value="₹18,420 / ₹22,000"
            />
            <PreviewRow
              icon={Invoice01Icon}
              label="Electricity"
              value="Due tomorrow"
            />
            <PreviewRow
              icon={MagicWand01Icon}
              label="Swiggy rule"
              value="9 matched"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-ledger bg-muted/30 p-3">
      <p className="micro-label">{label}</p>
      <p className="font-amount text-lg font-medium">{value}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function PreviewRow({
  icon,
  label,
  value,
}: {
  icon: typeof Wallet01Icon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-ledger px-3 py-2">
      <HugeiconsIcon icon={icon} className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{value}</p>
      </div>
    </div>
  );
}
