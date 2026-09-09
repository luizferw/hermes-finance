import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import {
  getAccount,
  getAccountBalanceHistory,
  getAccountTransactions,
} from "@/modules/accounts/queries";
import { formatDate, formatDateShort, formatMoney } from "@/lib/format";
import { todayIso } from "@kosh/domain";
import { RecordBalanceDialog } from "./record-balance-dialog";
import { EditAccountDialog } from "./edit-account-dialog";
import { PageHeader } from "@/components/app-shell/page-header";
import { Amount } from "@/components/transactions/amount";
import { CategoryBadge } from "@/components/transactions/category-badge";
import { StatusBadge } from "@/components/transactions/status-badge";
import { BalanceChart } from "@/components/charts/balance-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Account" };

const TYPE_LABEL: Record<string, string> = {
  asset: "Bank account",
  cash: "Cash",
  wallet: "Wallet",
  credit_card: "Credit card",
  liability: "Liability",
  investment: "Investment",
};

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const account = await getAccount(user.id, id);
  if (!account) notFound();

  const [history, recentTransactions] = await Promise.all([
    getAccountBalanceHistory(user.id, id),
    getAccountTransactions(user.id, id, 25),
  ]);

  return (
    <>
      <PageHeader title={account.name} description={TYPE_LABEL[account.type]}>
        <EditAccountDialog
          account={{
            id: account.id,
            name: account.name,
            currencyCode: account.currencyCode,
            institution: account.institution,
            limitMinor: account.limitMinor,
            includeInNetWorth: account.includeInNetWorth,
            isArchived: account.isArchived,
          }}
        />
        <RecordBalanceDialog accountId={account.id} todayIso={todayIso()} />
        <Button asChild variant="outline" size="sm" className="h-8">
          <Link href={`/transactions?accountId=${account.id}`}>
            All transactions
          </Link>
        </Button>
      </PageHeader>
      <main className="flex flex-col gap-5 p-4 md:p-6">
        <section className="grid gap-4 lg:grid-cols-3">
          <Card className="gap-2 px-5 py-4">
            <p className="micro-label">Current balance</p>
            <Amount
              amountMinor={account.currentBalanceMinor}
              currencyCode={account.currencyCode}
              className="text-2xl font-medium"
              muted={account.currentBalanceMinor < 0}
            />
            <div className="space-y-0.5 text-xs text-muted-foreground">
              {account.institution && <p>{account.institution}</p>}
              {account.accountNumberMask && (
                <p className="font-amount">{account.accountNumberMask}</p>
              )}
              {account.upiId && <p className="font-amount">{account.upiId}</p>}
              {account.openingBalanceDate && (
                <p>
                  Opened with{" "}
                  <span className="font-amount">
                    {formatMoney(account.openingBalanceMinor, account.currencyCode)}
                  </span>{" "}
                  on {formatDate(account.openingBalanceDate)}
                </p>
              )}
              {account.limitMinor !== null && (
                <p>
                  {account.type === "credit_card" ? "Limit" : "Principal"}:{" "}
                  <span className="font-amount">
                    {formatMoney(account.limitMinor, account.currencyCode)}
                  </span>
                </p>
              )}
            </div>
            <div className="mt-1 flex gap-1.5">
              {!account.includeInNetWorth && (
                <Badge variant="outline" className="text-[10px]">
                  excluded from net worth
                </Badge>
              )}
              {account.isArchived && (
                <Badge variant="outline" className="text-[10px]">
                  archived
                </Badge>
              )}
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="micro-label">Balance · 4 months</CardTitle>
            </CardHeader>
            <CardContent>
              {history.length > 1 ? (
                <BalanceChart
                  data={history.map((h) => ({
                    date: h.date,
                    balanceMinor: h.balanceMinor,
                  }))}
                  currencyCode={account.currencyCode}
                  className="h-48 w-full"
                />
              ) : (
                <div className="flex h-48 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                  Balance history builds up as transactions arrive.
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="micro-label">Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recentTransactions.length === 0 ? (
              <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                No transactions on this account yet.
              </div>
            ) : (
              <ul className="divide-y divide-dashed">
                {recentTransactions.map((tx) => {
                  const incoming =
                    tx.type === "transfer" && tx.transferAccountId === account.id;
                  const effectiveAmount = incoming ? -tx.amountMinor : tx.amountMinor;
                  return (
                    <li
                      key={tx.id}
                      className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">
                          {tx.merchant ?? tx.description}
                          {tx.type === "transfer" && (
                            <span className="text-muted-foreground">
                              {incoming
                                ? ` ← ${tx.account?.name}`
                                : tx.transferAccount
                                  ? ` → ${tx.transferAccount.name}`
                                  : ""}
                            </span>
                          )}
                        </p>
                        <div className="mt-0.5 flex items-center gap-2">
                          <span className="font-amount text-xs text-muted-foreground">
                            {formatDateShort(tx.date)}
                          </span>
                          <CategoryBadge
                            category={tx.category}
                            className="px-1.5 py-0 text-[10px]"
                          />
                          {tx.status !== "posted" && (
                            <StatusBadge status={tx.status} className="text-[10px]" />
                          )}
                        </div>
                      </div>
                      <Amount
                        amountMinor={effectiveAmount}
                        currencyCode={tx.currencyCode}
                        className="text-sm"
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
