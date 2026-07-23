import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  Database01Icon,
  GithubIcon,
  LockKeyIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { Reveal } from "@/components/landing/reveal";
import {
  AccountsPreview,
  AutomationPreview,
  BillsPreview,
  BudgetsPreview,
  GoalsPreview,
  HealthPreview,
  ImportPreview,
  OverviewPreview,
  OwnershipDiagram,
  TransactionsPreview,
} from "@/components/landing/previews";

const REPO_URL = "https://github.com/kzekiue/kosh";

export default function Home() {
  const showDemo = process.env.NODE_ENV !== "production";

  return (
    <div className="dark">
      <div className="app-atmosphere min-h-screen bg-background text-foreground">
        <div aria-hidden className="app-grain" />
        <TopBar />
        <main>
          <Hero showDemo={showDemo} />
          <Difference />
          <Walkthrough />
          <Ownership />
          <SelfHost />
          <FinalCta />
        </main>
        <Footer />
      </div>
    </div>
  );
}


function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          className="font-serif text-2xl leading-none tracking-[-0.015em] text-foreground"
        >
          Kosh
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            <HugeiconsIcon icon={GithubIcon} className="size-4" />
            Source
          </a>
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85"
          >
            Create account
          </Link>
        </nav>
      </div>
    </header>
  );
}


function Hero({ showDemo }: { showDemo: boolean }) {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 pt-16 pb-14 sm:px-8 sm:pt-24 sm:pb-20">
        <div className="max-w-3xl">
          <h1 className="mt-5 font-serif text-[2.6rem] leading-[1.02] font-normal tracking-[-0.01em] text-foreground sm:text-6xl md:text-7xl">
            The whole record of your money,
            <span className="text-primary"> on a server you own.</span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Kosh keeps your accounts, transactions, budgets, bills, and reports
            in a database you run yourself. No cloud account holds your ledger,
            and nothing here sells or studies what you spend.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/register"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
            >
              Create your account
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
            >
              Sign in
            </Link>
          </div>
          {showDemo && (
            <p className="mt-5 text-xs text-muted-foreground">
              Demo after seeding:{" "}
              <span className="font-amount text-foreground">
                demo@kosh.local / demo1234
              </span>
            </p>
          )}
        </div>

        {
}
        <Reveal className="relative mt-14 sm:mt-20">
          <div className="sm:-mr-8 md:-mr-16 lg:-mr-24">
            <OverviewPreview />
          </div>
        </Reveal>
      </div>
    </section>
  );
}


const DIFFERENCE = [
  {
    title: "Self-hosted",
    body: "One Docker command on your own machine. The app and its PostgreSQL database run where you put them, and stay there.",
  },
  {
    title: "Private by default",
    body: "No analytics on your spending, no third-party trackers, no data sold on. What you record is read by you and the software you run.",
  },
  {
    title: "Yours to keep",
    body: "Plain PostgreSQL underneath, with backups and CSV export you trigger. Leave whenever you like and take everything with you.",
  },
];

function Difference() {
  return (
    <section className="border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <Reveal>
          <p className="max-w-2xl font-serif text-2xl leading-snug text-foreground sm:text-3xl">
            Most finance apps keep your ledger on their servers. Kosh keeps it on
            yours — that single difference shapes everything else.
          </p>
        </Reveal>
        <Reveal className="mt-12 grid gap-px overflow-hidden border-y border-border/60 bg-border/60 sm:grid-cols-3 sm:border-x">
          {DIFFERENCE.map((d) => (
            <div key={d.title} className="h-full bg-background px-1 py-6 sm:px-6">
              <h2 className="text-sm font-medium text-foreground">{d.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {d.body}
              </p>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}


function Walkthrough() {
  return (
    <section className="border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <Reveal>
          <p className="micro-label">The product</p>
          <h2 className="mt-4 max-w-2xl font-serif text-3xl leading-tight text-foreground sm:text-4xl">
            A place for every part of your money — composed, not crammed.
          </h2>
        </Reveal>

        <div className="mt-16 space-y-20 sm:mt-20 sm:space-y-28">
          {
}
          <Reveal>
            <Moment
              index="01"
              kicker="Transactions"
              title="Everything that moved, in one honest ledger."
              body="Every account posts into the same tabular record — mono figures, categories, tags, and the account each line came from. Search it, filter it, split it, and reconcile without leaving the page."
            />
            <div className="mt-8">
              <TransactionsPreview />
            </div>
          </Reveal>

          {
}
          <Reveal>
            <div className="grid items-center gap-10 lg:grid-cols-[0.9fr_1.1fr]">
              <Moment
                index="02"
                kicker="Accounts & imports"
                title="Bring in a statement, keep the mess out."
                body="Add banks, cards, cash, loans, and savings, then import a CSV. Kosh matches what it recognises, suggests a category for the rest, and holds duplicates back for you to confirm."
              />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                <ImportPreview />
                <AccountsPreview />
              </div>
            </div>
          </Reveal>

          {
}
          <Reveal>
            <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="order-2 grid gap-4 sm:grid-cols-2 lg:order-1 lg:grid-cols-1">
                <BudgetsPreview />
                <BillsPreview />
              </div>
              <div className="order-1 lg:order-2">
                <Moment
                  index="03"
                  kicker="Budgets & bills"
                  title="Plan the month; meet every due date."
                  body="Set monthly envelopes and watch them fill as you spend. Track recurring bills with their real due dates, so rent, EMIs, and the electricity bill never arrive as a surprise."
                />
              </div>
            </div>
          </Reveal>

          {
}
          <Reveal>
            <div className="grid items-center gap-10 lg:grid-cols-[0.9fr_1.1fr]">
              <Moment
                index="04"
                kicker="Automations & recurring"
                title="Let the repetitive parts run themselves."
                body="Write a rule once — this merchant, that category — and it applies to matching transactions from then on. Recurring income and payments arrive as drafts you confirm, never posted behind your back."
              />
              <AutomationPreview />
            </div>
          </Reveal>

          {
}
          <Reveal>
            <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="order-2 lg:order-1">
                <GoalsPreview />
              </div>
              <div className="order-1 lg:order-2">
                <Moment
                  index="05"
                  kicker="Savings goals"
                  title="Save toward the things you're actually planning."
                  body="An emergency fund, a trip, a laptop. Give each goal a target and follow the progress, funded from the accounts you already track — no separate pots to reconcile."
                />
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Moment({
  index,
  kicker,
  title,
  body,
}: {
  index: string;
  kicker: string;
  title: string;
  body: string;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="font-amount text-sm text-primary">{index}</span>
        <span className="micro-label">{kicker}</span>
      </div>
      <h3 className="mt-3 max-w-md font-serif text-2xl leading-tight text-foreground sm:text-3xl">
        {title}
      </h3>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
        {body}
      </p>
    </div>
  );
}


function Ownership() {
  return (
    <section className="border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
          <Reveal>
            <div>
              <p className="micro-label">Ownership</p>
              <h2 className="mt-4 font-serif text-3xl leading-tight text-foreground sm:text-4xl">
                You hold the data and the infrastructure.
              </h2>
              <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
                There is no Kosh account in a datacentre you can&apos;t see. The
                app runs on your hardware, writes to your PostgreSQL, and — when
                you set an encryption key — protects the sensitive columns with
                AES-256-GCM before they ever touch disk. Back it up on your
                schedule; export to CSV whenever you want a copy in hand.
              </p>
            </div>
          </Reveal>
          <Reveal delay={80}>
            <OwnershipDiagram />
          </Reveal>
        </div>
      </div>
    </section>
  );
}


const STACK = [
  { label: "App", value: "Next.js" },
  { label: "Database", value: "PostgreSQL 16" },
  { label: "Runtime", value: "Node.js 22.13+" },
  { label: "Encryption", value: "AES-256-GCM" },
  { label: "License", value: "AGPL-3.0" },
  { label: "Deploy", value: "Docker Compose" },
];

function SelfHost() {
  return (
    <section className="border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <div>
              <p className="micro-label">For self-hosters</p>
              <h2 className="mt-4 font-serif text-3xl leading-tight text-foreground sm:text-4xl">
                Boring, legible infrastructure.
              </h2>
              <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
                The Compose stack starts PostgreSQL, runs the migrations, then
                starts Kosh. Nothing exotic to operate and nothing to phone home.
              </p>

              <div className="mt-7 overflow-hidden rounded-lg border border-border/70 bg-card">
                <div className="border-b border-border/60 px-4 py-2">
                  <span className="micro-label">Terminal</span>
                </div>
                <pre className="overflow-x-auto px-4 py-3.5 font-amount text-[0.8rem] leading-relaxed text-muted-foreground">
                  <code>
                    <span className="text-muted-foreground/60">$ </span>
                    <span className="text-foreground">cp</span> .env.example .env
                    {"\n"}
                    <span className="text-muted-foreground/60">$ </span>
                    <span className="text-foreground">docker compose</span> up
                    -d
                  </code>
                </pre>
              </div>

              <dl className="mt-7 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
                {STACK.map((s) => (
                  <div key={s.label}>
                    <dt className="micro-label">{s.label}</dt>
                    <dd className="mt-0.5 text-sm font-medium text-foreground">
                      {s.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Kosh shows you its own health — the database connection,
                migrations, backups, and encryption status — so operating it
                never means guessing.
              </p>
              <HealthPreview />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}


function FinalCta() {
  return (
    <section className="border-b border-border/60">
      <div className="mx-auto max-w-6xl px-5 py-20 text-center sm:px-8 sm:py-28">
        <Reveal>
          <h2 className="mx-auto max-w-2xl font-serif text-4xl leading-[1.05] text-foreground sm:text-5xl">
            Run your own money software.
          </h2>
          <p className="mx-auto mt-5 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
            Stand it up in a few minutes, import a statement, and see where you
            actually are. It stays on your server for as long as you want it.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/register"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
            >
              Create your account
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" />
            </Link>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-6 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
            >
              <HugeiconsIcon icon={GithubIcon} className="size-4" />
              Read the source
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}


const FOOTER_POINTS = [
  { icon: ServerStack01Icon, text: "Self-hosted" },
  { icon: Database01Icon, text: "PostgreSQL" },
  { icon: LockKeyIcon, text: "AES-256-GCM" },
];

function Footer() {
  return (
    <footer>
      <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="font-serif text-2xl leading-none text-foreground">
              Kosh
            </span>
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-muted-foreground">
              A self-hosted personal-finance app. Your accounts, your database,
              your server.
            </p>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
              {FOOTER_POINTS.map((p) => (
                <span
                  key={p.text}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <HugeiconsIcon icon={p.icon} className="size-3.5" />
                  {p.text}
                </span>
              ))}
            </div>
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
            <Link href="/register" className="text-muted-foreground transition-colors hover:text-foreground">
              Create account
            </Link>
            <Link href="/login" className="text-muted-foreground transition-colors hover:text-foreground">
              Sign in
            </Link>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              Source
            </a>
          </nav>
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-border/60 pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Licensed under AGPL-3.0.</span>
          <span>Built to run on hardware you control.</span>
        </div>
      </div>
    </footer>
  );
}
