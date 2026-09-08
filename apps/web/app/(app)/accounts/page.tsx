import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Wallet01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import {
  listAccounts,
  getNetWorthSummary,
  type AccountRow,
} from "@/modules/accounts/queries";
import { PageHeader } from "@/components/app-shell/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { NewAccountDialog } from "./new-account-dialog";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Accounts" };

const TYPE_META: Record<string, { label: string; explainer: string }> = {
  asset: { label: "Bank accounts", explainer: "Savings and current — money you own" },
  cash: { label: "Cash", explainer: "Physical wallets and petty cash" },
  wallet: { label: "Wallets", explainer: "UPI and prepaid — PhonePe, Paytm, GPay" },
  investment: { label: "Investments", explainer: "Stocks, funds, FD/RD, gold, PPF/EPF/NPS" },
  credit_card: { label: "Credit cards", explainer: "Balances are what you owe this cycle" },
  liability: { label: "Liabilities", explainer: "Loans and debts that shrink over time" },
};
const TYPE_ORDER = Object.keys(TYPE_META);

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const [accounts, netWorth] = await Promise.all([
    listAccounts(user.id),
    getNetWorthSummary(user.id),
  ]);
  const active = accounts.filter((a) => !a.isArchived);
  const archived = accounts.filter((a) => a.isArchived);
  const currency = netWorth.currencyCode;

  const groups = TYPE_ORDER.map((type) => ({
    type,
    ...TYPE_META[type]!,
    accounts: active.filter((a) => a.type === type),
  })).filter((g) => g.accounts.length > 0);

  return (
    <>
      <PageHeader
        title="Accounts"
        description={`Net worth uses ${currency}; foreign-currency accounts are listed but excluded from the total.`}
      >
        <NewAccountDialog defaultOpen={params.new === "1"} />
      </PageHeader>

      <main className="mx-auto w-full max-w-screen-2xl space-y-10 px-4 py-6 md:space-y-14 md:px-8 md:py-8">
        {/* ── Movement I · The standing ─────────────────────────────────── */}
        <section
          className="row-in"
          style={{ "--i": 0 } as React.CSSProperties}
          aria-label="Net worth"
        >
          <span className="micro-label">Net worth</span>
          <p className="mt-1.5 font-amount text-[clamp(2.25rem,5.5vw,3.25rem)] leading-[0.95] font-medium tracking-[-0.03em] text-foreground tabular-nums">
            {formatMoney(netWorth.netWorthMinor, currency)}
          </p>
          <Meter
            assets={netWorth.assetsMinor}
            liabilities={netWorth.liabilitiesMinor}
            currency={currency}
          />
        </section>

        {/* ── Movement II · What you hold ───────────────────────────────── */}
        {active.length === 0 ? (
          <Empty className="border border-dashed py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Wallet01Icon} />
              </EmptyMedia>
              <EmptyTitle>No accounts yet</EmptyTitle>
              <EmptyDescription>
                Start with the account your salary lands in. Opening balances keep
                history honest.
              </EmptyDescription>
            </EmptyHeader>
            <NewAccountDialog />
          </Empty>
        ) : (
          <div
            className="row-in space-y-10"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            {groups.map((group) => {
              const subtotal = group.accounts.reduce(
                (s, a) => s + a.currentBalanceMinor,
                0,
              );
              return (
                <section key={group.type}>
                  <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
                    <div className="min-w-0">
                      <h2 className="text-sm font-medium text-foreground">
                        {group.label}
                      </h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {group.explainer}
                      </p>
                    </div>
                    <LedgerFigure
                      minor={subtotal}
                      currency={currency}
                      className="text-sm"
                    />
                  </div>
                  <ul>
                    {group.accounts.map((account, i) => (
                      <AccountRowItem
                        key={account.id}
                        account={account}
                        currency={currency}
                        index={i}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}

        {archived.length > 0 && (
          <section>
            <h2 className="micro-label">Archived</h2>
            <ul className="mt-2.5">
              {archived.map((account) => (
                <li key={account.id} className="border-b border-border/50 last:border-0">
                  <Link
                    href={`/accounts/${account.id}`}
                    className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.025] hover:text-foreground"
                  >
                    <span className="truncate">{account.name}</span>
                    <LedgerFigure
                      minor={account.currentBalanceMinor}
                      currency={currency}
                      className="text-xs"
                      muted
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

/* ─────────────────────────────── Pieces ─────────────────────────────── */

/**
 * Owned against owed as one proportional rule — fern carries assets, clay
 * liabilities; the split width is the truth of the ratio, legible before the
 * figures are read.
 */
function Meter({
  assets,
  liabilities,
  currency,
}: {
  assets: number;
  liabilities: number;
  currency: string;
}) {
  const total = assets + liabilities;
  const assetPct = total > 0 ? (assets / total) * 100 : 100;
  return (
    <div className="mt-5 max-w-xl">
      <div className="flex h-2 w-full gap-1 overflow-hidden rounded-full">
        <span
          className="grow-x h-full rounded-full bg-primary"
          style={{ width: `${assetPct}%`, "--i": 0 } as React.CSSProperties}
        />
        {liabilities > 0 && (
          <span
            className="grow-x h-full flex-1 rounded-full bg-destructive/55"
            style={{ "--i": 1 } as React.CSSProperties}
          />
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-between text-xs">
        <span className="flex items-baseline gap-1.5">
          <span className="text-muted-foreground">Assets</span>
          <span className="font-amount text-foreground tabular-nums">
            {formatMoney(assets, currency)}
          </span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-muted-foreground">Owe</span>
          <span className="font-amount text-foreground tabular-nums">
            {formatMoney(liabilities, currency)}
          </span>
        </span>
      </div>
    </div>
  );
}

/** A ledger amount: mono, tabular, plain ink; negatives drop to a quiet clay. */
function LedgerFigure({
  minor,
  currency,
  className,
  muted,
}: {
  minor: number;
  currency: string;
  className?: string;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "font-amount tabular-nums whitespace-nowrap",
        muted
          ? "text-muted-foreground"
          : minor < 0
            ? "text-destructive/80"
            : "text-foreground",
        className,
      )}
    >
      {formatMoney(minor, currency)}
    </span>
  );
}

function AccountRowItem({
  account,
  currency,
  index,
}: {
  account: AccountRow;
  currency: string;
  index: number;
}) {
  const meta: string[] = [];
  if (account.institution) meta.push(account.institution);
  if (account.accountNumberMask) meta.push(account.accountNumberMask);
  else if (account.upiId) meta.push(account.upiId);

  return (
    <li
      className="border-b border-border/50 last:border-0"
      style={{ "--i": index } as React.CSSProperties}
    >
      <Link
        href={`/accounts/${account.id}`}
        className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:bg-foreground/[0.025]"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {account.name}
          </p>
          {meta.length > 0 && (
            <p className="truncate text-xs text-muted-foreground">
              {meta.join(" · ")}
            </p>
          )}
        </div>

        {account.type === "credit_card" && account.limitMinor ? (
          <span className="hidden text-xs text-muted-foreground sm:inline">
            of{" "}
            <span className="font-amount tabular-nums">
              {formatMoney(account.limitMinor, currency)}
            </span>{" "}
            limit
          </span>
        ) : null}
        {!account.includeInNetWorth && (
          <span className="hidden rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground sm:inline">
            off net worth
          </span>
        )}

        <LedgerFigure
          minor={account.currentBalanceMinor}
          currency={account.currencyCode}
          className="text-[0.9375rem]"
        />
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="size-4 shrink-0 text-muted-foreground/40 transition-transform duration-[var(--duration-state)] ease-[var(--ease-out-quint)] group-hover:translate-x-0.5 group-hover:text-muted-foreground"
          strokeWidth={2}
        />
      </Link>
    </li>
  );
}
