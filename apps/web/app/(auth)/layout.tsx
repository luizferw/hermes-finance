import Link from "next/link";
import { redirect } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { getSession } from "@/lib/session";
import { BrandWordmark } from "@/components/brand";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (session) redirect("/overview");

  return (
    <div className="app-atmosphere relative flex min-h-svh flex-col overflow-x-hidden">
      <header className="relative z-10 flex h-16 shrink-0 items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          aria-label="Kosh home"
          className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <BrandWordmark />
        </Link>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} className="size-3.5" />
          Back to home
        </Link>
      </header>
      <main className="relative z-10 flex flex-1 flex-col lg:grid lg:grid-cols-[1.05fr_1fr] xl:grid-cols-[1.2fr_1fr]">
        <aside className="relative hidden flex-col justify-center border-r border-border/60 px-12 pb-24 xl:px-20 lg:flex">
          <div className="max-w-md">
            <p className="mt-6 font-serif text-[2.4rem] leading-[1.08] font-normal tracking-[-0.015em] text-balance text-foreground">
              The whole record of your money, on a server you own.
            </p>
            <p className="mt-6 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Kosh runs on your own machine. The app and its database live where
              you put them — no cloud account holds your ledger, and nothing here
              studies what you spend.
            </p>
            <div className="mt-10 h-px w-16 bg-border" />
            <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
              You are signing in to this installation of Kosh, not a shared Kosh
              service.
            </p>
          </div>
        </aside>

        <div className="flex w-full min-w-0 flex-1 items-center justify-center px-5 pb-16 sm:px-10 lg:px-14">
          <div className="page-in w-full min-w-0 max-w-[380px]">{children}</div>
        </div>
      </main>
    </div>
  );
}
