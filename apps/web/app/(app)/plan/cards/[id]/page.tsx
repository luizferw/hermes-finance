import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { formatDate, formatMoney, formatMonth } from "@/lib/format";
import { getCardStatement } from "@/modules/finance/queries";
import { listAccounts } from "@/modules/accounts/queries";
import { listCategories } from "@/modules/taxonomy/queries";
import { todayIso } from "@kosh/domain";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { NewPurchaseDialog } from "./new-purchase-dialog";
import { EditCardDialog } from "./edit-card-dialog";
import { ReconcileCycleDialog } from "./reconcile-cycle-dialog";

export const metadata: Metadata = { title: "Card statement" };

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  closed: "Closed",
  paid: "Paid",
  overdue: "Overdue",
  needs_review: "Needs review",
};

export default async function CardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const [statement, categories, accounts] = await Promise.all([
    getCardStatement(user.id, id),
    listCategories(user.id),
    listAccounts(user.id),
  ]);
  if (!statement) notFound();

  const { card, cycles } = statement;
  const paymentAccounts = accounts
    .filter((account) => ["asset", "cash", "wallet"].includes(account.type))
    .map((account) => ({ id: account.id, name: account.name }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{card.name}</h2>
          <p className="text-sm text-muted-foreground">
            {card.issuer ? `${card.issuer} · ` : ""}
            Limit {formatMoney(card.creditLimitMinor, card.currencyCode)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <EditCardDialog
            card={{
              id: card.id,
              name: card.name,
              issuer: card.issuer,
              currencyCode: card.currencyCode,
              creditLimitMinor: card.creditLimitMinor,
              defaultClosingDay: card.defaultClosingDay,
              defaultDueDay: card.defaultDueDay,
              paymentAccountId: card.paymentAccountId,
            }}
            paymentAccounts={paymentAccounts}
          />
          <NewPurchaseDialog
            creditCardId={card.id}
            categories={categories.map((category) => ({ id: category.id, name: category.name }))}
            todayIso={todayIso()}
          />
        </div>
      </div>

      {cycles.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          Nothing posted to this card yet. Statements appear here as soon as it
          has transactions.
        </div>
      ) : (
        <ul className="divide-y divide-dashed">
          {cycles.map((cycle) => {
            const overdue = cycle.status === "overdue";
            const needsReview = cycle.status === "needs_review";
            return (
              <li
                key={cycle.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{formatMonth(cycle.statementMonth)}</p>
                  <p className="text-xs text-muted-foreground">
                    Due {formatDate(cycle.dueAt)}
                    {cycle.creditsMinor > 0 &&
                      ` · ${formatMoney(cycle.creditsMinor, card.currencyCode)} paid or refunded`}
                  </p>
                </div>
                <div className="flex items-center gap-2.5">
                  <Badge variant={cycle.isReconciled ? "outline" : "secondary"} className="text-[10px]">
                    {cycle.isReconciled
                      ? "Reconciled"
                      : cycle.source === "derived"
                        ? "From transactions"
                        : "Estimated"}
                  </Badge>
                  <Badge
                    variant={overdue || needsReview ? "destructive" : "outline"}
                    className={cn("text-[10px]", (overdue || needsReview) && "text-destructive")}
                  >
                    {STATUS_LABEL[cycle.status] ?? cycle.status}
                  </Badge>
                  <span className="font-amount w-28 text-right text-sm tabular-nums">
                    {formatMoney(cycle.totalMinor, card.currencyCode)}
                  </span>
                  {cycle.source === "recorded" && !cycle.isReconciled && (
                    <ReconcileCycleDialog
                      cycleId={cycle.id}
                      statementMonth={cycle.statementMonth}
                      currencyCode={card.currencyCode}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
