import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { formatDate, formatMoney, formatMonth } from "@/lib/format";
import { getCardStatement } from "@/modules/finance/queries";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Card statement" };

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  closed: "Closed",
  paid: "Paid",
  overdue: "Overdue",
};

export default async function CardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const statement = await getCardStatement(user.id, id);
  if (!statement) notFound();

  const { card, cycles } = statement;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{card.name}</h2>
        <p className="text-sm text-muted-foreground">
          {card.issuer ? `${card.issuer} · ` : ""}
          Limit {formatMoney(card.creditLimitMinor, card.currencyCode)}
        </p>
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
                    variant={overdue ? "destructive" : "outline"}
                    className={cn("text-[10px]", overdue && "text-destructive")}
                  >
                    {STATUS_LABEL[cycle.status] ?? cycle.status}
                  </Badge>
                  <span className="font-amount w-28 text-right text-sm tabular-nums">
                    {formatMoney(cycle.totalMinor, card.currencyCode)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
