import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDataTransferHorizontalIcon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Briefcase01Icon,
  Car01Icon,
  ChartLineData01Icon,
  CheckmarkCircle02Icon,
  Coins01Icon,
  Database01Icon,
  FlashIcon,
  Home01Icon,
  Home09Icon,
  InboxIcon,
  Invoice01Icon,
  LockKeyIcon,
  MagicWand01Icon,
  PieChart01Icon,
  RepeatIcon,
  Restaurant01Icon,
  ServerStack01Icon,
  Shield01Icon,
  ShoppingCart01Icon,
  Target01Icon,
  Tv01Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";


type Icon = typeof Wallet01Icon;

export function Panel({
  crumb,
  children,
  className,
  badge = "Local",
}: {
  crumb: string;
  children: React.ReactNode;
  className?: string;
  badge?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10",
        "shadow-[0_40px_90px_-50px_rgba(0,0,0,0.7)]",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-serif text-sm leading-none text-foreground">
            Kosh
          </span>
          <HugeiconsIcon icon={ArrowRight01Icon} className="size-3 opacity-50" />
          <span className="text-[0.7rem] font-medium tracking-wide">
            {crumb}
          </span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-[0.625rem] font-medium text-success">
          <HugeiconsIcon icon={Shield01Icon} className="size-2.5" />
          {badge}
        </span>
      </div>
      {children}
    </div>
  );
}

function Meter({ pct, over = false }: { pct: number; over?: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full",
          over ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}


const SPINE: Array<{ label: string; icon: Icon; active?: boolean; badge?: string }> = [
  { label: "Today", icon: Home01Icon, active: true },
  { label: "Inbox", icon: InboxIcon, badge: "12" },
  { label: "Accounts", icon: Wallet01Icon },
  { label: "Transactions", icon: ArrowDataTransferHorizontalIcon },
  { label: "Budgets", icon: PieChart01Icon },
  { label: "Bills", icon: Invoice01Icon },
  { label: "Trends", icon: ChartLineData01Icon },
  { label: "Automations", icon: MagicWand01Icon },
];

export function OverviewPreview({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10",
        "shadow-[0_50px_110px_-45px_rgba(0,0,0,0.8)]",
        className,
      )}
    >
      {
}
      <aside className="hidden w-44 shrink-0 flex-col border-r border-border/70 bg-sidebar px-2.5 py-3 sm:flex">
        <span className="px-2 pb-3 font-serif text-lg leading-none text-foreground">
          Kosh
        </span>
        <nav className="flex flex-col gap-0.5">
          {SPINE.map((item) => (
            <span
              key={item.label}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.75rem]",
                item.active
                  ? "bg-sidebar-accent font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <HugeiconsIcon icon={item.icon} className="size-3.5 shrink-0" />
              <span className="flex-1 truncate">{item.label}</span>
              {item.badge && (
                <span className="rounded-full bg-primary/15 px-1.5 text-[0.625rem] font-medium text-primary">
                  {item.badge}
                </span>
              )}
            </span>
          ))}
        </nav>
      </aside>

      {
}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3 sm:px-5">
          <div>
            <p className="font-serif text-lg leading-tight text-foreground sm:text-xl">
              Good evening, Aditya
            </p>
            <p className="mt-0.5 text-[0.7rem] text-muted-foreground">
              You&apos;re on steady ground this month.
            </p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-[0.625rem] font-medium text-success">
            <HugeiconsIcon icon={Shield01Icon} className="size-2.5" />
            Local
          </span>
        </div>

        <div className="space-y-4 p-4 sm:p-5">
          {
}
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Net worth" value="₹18,42,600" hint="+₹42,300" up />
            <Stat label="Safe to spend" value="₹31,400" hint="through 31 Jul" />
            <Stat label="This month" value="+₹58,200" hint="income − spend" />
          </div>

          {
}
          <div className="rounded-lg border border-ledger p-3">
            <div className="mb-1 flex items-center justify-between">
              <p className="micro-label">Net worth · 12 months</p>
              <span className="font-amount text-[0.7rem] text-success">
                +14.6%
              </span>
            </div>
            <Sparkline />
          </div>

          {
}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Attention
              icon={InboxIcon}
              label="12 to review"
              hint="imported from HDFC"
            />
            <Attention
              icon={Invoice01Icon}
              label="Electricity due"
              hint="BESCOM · in 3 days"
            />
            <Attention
              icon={PieChart01Icon}
              label="Eating out over"
              hint="₹6,900 of ₹6,000"
              warn
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  up = false,
}: {
  label: string;
  value: string;
  hint: string;
  up?: boolean;
}) {
  return (
    <div className="rounded-lg border border-ledger bg-muted/25 p-3">
      <p className="micro-label">{label}</p>
      <p className="font-amount mt-1 text-base leading-tight font-medium tracking-tight sm:text-lg">
        {value}
      </p>
      <p
        className={cn(
          "mt-0.5 flex items-center gap-0.5 text-[0.7rem]",
          up ? "text-success" : "text-muted-foreground",
        )}
      >
        {up && <HugeiconsIcon icon={ArrowUpRight01Icon} className="size-3" />}
        {hint}
      </p>
    </div>
  );
}

function Attention({
  icon,
  label,
  hint,
  warn = false,
}: {
  icon: Icon;
  label: string;
  hint: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-ledger px-3 py-2">
      <HugeiconsIcon
        icon={icon}
        className={cn("size-4 shrink-0", warn ? "text-warning" : "text-primary")}
      />
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-foreground">{label}</p>
        <p className="truncate text-[0.7rem] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function Sparkline() {
  const line =
    "M0,64 C24,62 36,52 60,55 C84,58 96,44 120,46 C150,49 168,32 200,34 C232,36 250,22 280,18 C300,15 316,12 330,9";
  return (
    <svg
      viewBox="0 0 330 76"
      preserveAspectRatio="none"
      className="h-16 w-full"
      aria-hidden
    >
      <defs>
        <linearGradient id="nwFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L330,76 L0,76 Z`} fill="url(#nwFill)" />
      <path
        d={line}
        fill="none"
        stroke="var(--chart-1)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="330" cy="9" r="3" fill="var(--chart-1)" />
    </svg>
  );
}


const TXNS: Array<{
  merchant: string;
  cat: string;
  icon: Icon;
  account: string;
  amount: string;
  date: string;
  inflow?: boolean;
}> = [
  {
    merchant: "Monthly salary",
    cat: "Income",
    icon: Briefcase01Icon,
    account: "HDFC Salary",
    amount: "+₹1,85,000",
    date: "1 Jul",
    inflow: true,
  },
  {
    merchant: "Skyline Residency",
    cat: "Rent",
    icon: Home09Icon,
    account: "HDFC Salary",
    amount: "₹32,000",
    date: "2 Jul",
  },
  {
    merchant: "BigBasket",
    cat: "Groceries",
    icon: ShoppingCart01Icon,
    account: "Millennia Card",
    amount: "₹3,120",
    date: "4 Jul",
  },
  {
    merchant: "Swiggy",
    cat: "Eating out",
    icon: Restaurant01Icon,
    account: "Millennia Card",
    amount: "₹480",
    date: "5 Jul",
  },
  {
    merchant: "Index fund SIP",
    cat: "Investments",
    icon: Coins01Icon,
    account: "ICICI Savings",
    amount: "₹15,000",
    date: "5 Jul",
  },
  {
    merchant: "BESCOM electricity",
    cat: "Utilities",
    icon: FlashIcon,
    account: "HDFC Salary",
    amount: "₹2,340",
    date: "6 Jul",
  },
  {
    merchant: "Netflix",
    cat: "Subscriptions",
    icon: Tv01Icon,
    account: "Millennia Card",
    amount: "₹649",
    date: "7 Jul",
  },
];

export function TransactionsPreview({ className }: { className?: string }) {
  return (
    <Panel crumb="Transactions" className={className}>
      <div className="divide-y divide-border/60">
        {TXNS.map((t) => (
          <div
            key={t.merchant}
            className="flex items-center gap-3 px-4 py-2.5 sm:px-5"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/60 text-muted-foreground">
              <HugeiconsIcon icon={t.icon} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8rem] font-medium text-foreground">
                {t.merchant}
              </p>
              <p className="truncate text-[0.7rem] text-muted-foreground">
                {t.cat} · {t.account}
              </p>
            </div>
            <div className="text-right">
              <p
                className={cn(
                  "font-amount text-[0.8rem] font-medium",
                  t.inflow ? "text-success" : "text-foreground",
                )}
              >
                {t.amount}
              </p>
              <p className="text-[0.7rem] text-muted-foreground">{t.date}</p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}


export function ImportPreview({ className }: { className?: string }) {
  return (
    <Panel crumb="Inbox · Import review" className={className}>
      <div className="border-b border-border/70 px-4 py-3 sm:px-5">
        <p className="text-[0.8rem] font-medium text-foreground">
          hdfc-jul-2025.csv
        </p>
        <p className="mt-0.5 text-[0.7rem] text-muted-foreground">
          38 rows parsed · 34 matched · 3 need a category · 1 duplicate held
        </p>
      </div>
      <div className="divide-y divide-border/60">
        <ImportRow
          merchant="THIRD WAVE COFFEE BLR"
          suggest="Eating out"
          amount="₹380"
          state="suggested"
        />
        <ImportRow
          merchant="RENTPAY SKYLINE"
          suggest="Rent"
          amount="₹32,000"
          state="matched"
        />
        <ImportRow
          merchant="CROMA RETAIL BANGALORE"
          suggest="Shopping"
          amount="₹8,499"
          state="review"
        />
        <ImportRow
          merchant="SWIGGY INSTAMART"
          suggest="Duplicate of 5 Jul"
          amount="₹480"
          state="duplicate"
        />
      </div>
    </Panel>
  );
}

function ImportRow({
  merchant,
  suggest,
  amount,
  state,
}: {
  merchant: string;
  suggest: string;
  amount: string;
  state: "matched" | "suggested" | "review" | "duplicate";
}) {
  const tone = {
    matched: "bg-success/12 text-success",
    suggested: "bg-primary/12 text-primary",
    review: "bg-warning/15 text-warning",
    duplicate: "bg-muted text-muted-foreground",
  }[state];
  const label = {
    matched: "Matched",
    suggested: "Suggested",
    review: "Review",
    duplicate: "Duplicate",
  }[state];
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <p className="truncate font-amount text-[0.75rem] text-foreground">
          {merchant}
        </p>
        <p className="truncate text-[0.7rem] text-muted-foreground">
          → {suggest}
        </p>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-medium",
          tone,
        )}
      >
        {label}
      </span>
      <p className="font-amount w-16 shrink-0 text-right text-[0.8rem] font-medium text-foreground">
        {amount}
      </p>
    </div>
  );
}


const BUDGETS: Array<{
  name: string;
  icon: Icon;
  spent: string;
  cap: string;
  pct: number;
  over?: boolean;
}> = [
  { name: "Groceries", icon: ShoppingCart01Icon, spent: "₹18,420", cap: "₹22,000", pct: 84 },
  { name: "Eating out", icon: Restaurant01Icon, spent: "₹6,900", cap: "₹6,000", pct: 100, over: true },
  { name: "Transport", icon: Car01Icon, spent: "₹4,120", cap: "₹7,000", pct: 59 },
  { name: "Subscriptions", icon: Tv01Icon, spent: "₹1,897", cap: "₹2,500", pct: 76 },
];

export function BudgetsPreview({ className }: { className?: string }) {
  return (
    <Panel crumb="Budgets · July" className={className}>
      <div className="space-y-3.5 p-4 sm:p-5">
        {BUDGETS.map((b) => (
          <div key={b.name}>
            <div className="mb-1.5 flex items-center gap-2">
              <HugeiconsIcon icon={b.icon} className="size-3.5 text-muted-foreground" />
              <span className="text-[0.8rem] font-medium text-foreground">
                {b.name}
              </span>
              <span className="font-amount ml-auto text-[0.75rem] text-muted-foreground">
                <span className={cn(b.over && "text-destructive")}>{b.spent}</span>{" "}
                / {b.cap}
              </span>
            </div>
            <Meter pct={b.pct} over={b.over} />
          </div>
        ))}
      </div>
    </Panel>
  );
}


const BILLS: Array<{ name: string; icon: Icon; amount: string; due: string; soon?: boolean }> = [
  { name: "Jio Fiber", icon: FlashIcon, amount: "₹999", due: "Due tomorrow", soon: true },
  { name: "BESCOM electricity", icon: FlashIcon, amount: "₹2,340", due: "In 3 days", soon: true },
  { name: "Car loan EMI", icon: Car01Icon, amount: "₹18,500", due: "In 9 days" },
  { name: "Skyline rent", icon: Home09Icon, amount: "₹32,000", due: "1 Aug" },
];

export function BillsPreview({ className }: { className?: string }) {
  return (
    <Panel crumb="Bills · Upcoming" className={className}>
      <div className="divide-y divide-border/60">
        {BILLS.map((b) => (
          <div key={b.name} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/60 text-muted-foreground">
              <HugeiconsIcon icon={b.icon} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8rem] font-medium text-foreground">
                {b.name}
              </p>
              <p
                className={cn(
                  "text-[0.7rem]",
                  b.soon ? "text-warning" : "text-muted-foreground",
                )}
              >
                {b.due}
              </p>
            </div>
            <p className="font-amount text-[0.8rem] font-medium text-foreground">
              {b.amount}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}


export function AutomationPreview({ className }: { className?: string }) {
  return (
    <Panel crumb="Automations" className={className}>
      <div className="space-y-3 p-4 sm:p-5">
        <div className="rounded-lg border border-ledger p-3">
          <div className="mb-2 flex items-center gap-2">
            <HugeiconsIcon icon={MagicWand01Icon} className="size-3.5 text-primary" />
            <span className="text-[0.8rem] font-medium text-foreground">
              Swiggy → Eating out
            </span>
            <span className="ml-auto rounded-full bg-success/12 px-2 py-0.5 text-[0.625rem] font-medium text-success">
              9 matched
            </span>
          </div>
          <p className="text-[0.72rem] leading-relaxed text-muted-foreground">
            When <span className="font-amount text-foreground">merchant contains &ldquo;Swiggy&rdquo;</span>,
            set category <span className="text-foreground">Eating out</span> and tag{" "}
            <span className="text-foreground">food</span>.
          </p>
        </div>

        <div className="rounded-lg border border-ledger p-3">
          <div className="mb-2 flex items-center gap-2">
            <HugeiconsIcon icon={RepeatIcon} className="size-3.5 text-primary" />
            <span className="text-[0.8rem] font-medium text-foreground">
              Recurring draft · Salary
            </span>
            <span className="font-amount ml-auto text-[0.75rem] text-success">
              +₹1,85,000
            </span>
          </div>
          <p className="text-[0.72rem] leading-relaxed text-muted-foreground">
            Monthly on the 1st · next draft <span className="text-foreground">1 Aug</span>.
            Kosh prepares it; you confirm before it posts.
          </p>
        </div>
      </div>
    </Panel>
  );
}


const GOALS: Array<{ name: string; icon: Icon; saved: string; target: string; pct: number; note: string }> = [
  { name: "Emergency fund", icon: Shield01Icon, saved: "₹4,20,000", target: "₹6,00,000", pct: 70, note: "6 months of expenses" },
  { name: "Goa trip", icon: Target01Icon, saved: "₹48,000", target: "₹80,000", pct: 60, note: "December" },
  { name: "New MacBook", icon: Briefcase01Icon, saved: "₹1,10,000", target: "₹2,00,000", pct: 55, note: "on track" },
];

export function GoalsPreview({ className }: { className?: string }) {
  return (
    <Panel crumb="Goals" className={className}>
      <div className="space-y-4 p-4 sm:p-5">
        {GOALS.map((g) => (
          <div key={g.name}>
            <div className="mb-1.5 flex items-center gap-2">
              <HugeiconsIcon icon={g.icon} className="size-3.5 text-primary" />
              <span className="text-[0.8rem] font-medium text-foreground">
                {g.name}
              </span>
              <span className="font-amount ml-auto text-[0.75rem] text-muted-foreground">
                <span className="text-foreground">{g.saved}</span> / {g.target}
              </span>
            </div>
            <Meter pct={g.pct} />
            <p className="mt-1 text-[0.7rem] text-muted-foreground">{g.note}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}


const CHECKS = [
  { label: "Database", value: "PostgreSQL 16 · connected" },
  { label: "Migrations", value: "Up to date" },
  { label: "Backups", value: "Last night · 02:00" },
  { label: "Encryption", value: "AES-256-GCM · on" },
];

export function HealthPreview({ className }: { className?: string }) {
  return (
    <Panel crumb="Settings · Health" className={className}>
      <div className="divide-y divide-border/60">
        {CHECKS.map((c) => (
          <div key={c.label} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              className="size-4 shrink-0 text-success"
            />
            <span className="text-[0.8rem] font-medium text-foreground">
              {c.label}
            </span>
            <span className="font-amount ml-auto text-[0.72rem] text-muted-foreground">
              {c.value}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}


const ACCOUNTS: Array<{ name: string; icon: Icon; kind: string; balance: string; neg?: boolean }> = [
  { name: "HDFC Salary", icon: Wallet01Icon, kind: "Bank", balance: "₹2,14,300" },
  { name: "ICICI Savings", icon: Coins01Icon, kind: "Savings", balance: "₹8,90,000" },
  { name: "HDFC Millennia", icon: Tv01Icon, kind: "Credit card", balance: "−₹41,200", neg: true },
  { name: "SBI Emergency Fund", icon: Shield01Icon, kind: "Savings", balance: "₹4,20,000" },
  { name: "Car Loan", icon: Car01Icon, kind: "Loan", balance: "−₹3,10,000", neg: true },
];

export function AccountsPreview({ className }: { className?: string }) {
  return (
    <Panel crumb="Accounts" className={className}>
      <div className="divide-y divide-border/60">
        {ACCOUNTS.map((a) => (
          <div key={a.name} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/60 text-muted-foreground">
              <HugeiconsIcon icon={a.icon} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8rem] font-medium text-foreground">
                {a.name}
              </p>
              <p className="text-[0.7rem] text-muted-foreground">{a.kind}</p>
            </div>
            <p
              className={cn(
                "font-amount text-[0.8rem] font-medium",
                a.neg ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {a.balance}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}


export function OwnershipDiagram({ className }: { className?: string }) {
  const nodes: Array<{ icon: Icon; title: string; sub: string }> = [
    { icon: ServerStack01Icon, title: "Your server", sub: "a VPS, a NAS, a spare box" },
    { icon: Database01Icon, title: "Your database", sub: "PostgreSQL you control" },
    { icon: LockKeyIcon, title: "Your keys", sub: "encryption key never leaves" },
  ];
  return (
    <div className={cn("grid gap-3 sm:grid-cols-3", className)}>
      {nodes.map((n, i) => (
        <div key={n.title} className="relative rounded-xl border border-ledger p-4">
          <HugeiconsIcon icon={n.icon} className="size-5 text-primary" />
          <p className="mt-3 text-sm font-medium text-foreground">{n.title}</p>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">
            {n.sub}
          </p>
          {i < nodes.length - 1 && (
            <span
              aria-hidden
              className="absolute top-1/2 -right-3 hidden -translate-y-1/2 text-border sm:block"
            >
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
