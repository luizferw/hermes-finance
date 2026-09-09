import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, CreditCardIcon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { listArchivedCreditCards, listCreditCards } from "@/modules/finance/queries";
import { restoreCreditCard } from "@/modules/finance/mutations";
import { listAccounts } from "@/modules/accounts/queries";
import { getUserSettings } from "@/modules/settings/queries";
import { NewCardDialog } from "./new-card-dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ArchivedList } from "@/components/shared/archived-list";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Cards" };

export default async function CardsPage() {
  const user = await requireUser();
  const [cards, accounts, settings, archivedCards] = await Promise.all([
    listCreditCards(user.id),
    listAccounts(user.id),
    getUserSettings(user.id),
    listArchivedCreditCards(user.id),
  ]);

  // A ledger account of type `credit_card` is not yet a Hermes card: the limit,
  // closing day and due day cannot come from an import. Offer only the accounts
  // that have not been linked to a card record yet.
  const linked = new Set(cards.map((card) => card.accountId));
  const cardAccounts = accounts
    .filter((account) => account.type === "credit_card" && !linked.has(account.id))
    .map((account) => ({
      id: account.id,
      name: account.name,
      currencyCode: account.currencyCode,
      // Carried over so the card form does not ask again for what the ledger
      // account already records.
      institution: account.institution,
      limitMinor: account.limitMinor,
    }));
  const paymentAccounts = accounts
    .filter((account) => ["asset", "cash", "wallet"].includes(account.type))
    .map((account) => ({ id: account.id, name: account.name, currencyCode: account.currencyCode }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Credit cards</h2>
          <p className="text-sm text-muted-foreground">
            Limit, what&apos;s committed to future installments, and what&apos;s still available.
          </p>
        </div>
        <NewCardDialog
          cardAccounts={cardAccounts}
          paymentAccounts={paymentAccounts}
          defaultCurrency={settings.currencyCode}
        />
      </div>

      {cards.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={CreditCardIcon} />
            </EmptyMedia>
            <EmptyTitle>No cards tracked</EmptyTitle>
            <EmptyDescription>
              {cardAccounts.length > 0 ? (
                <>
                  You already have {cardAccounts.length} credit-card{" "}
                  {cardAccounts.length === 1 ? "account" : "accounts"} —{" "}
                  {cardAccounts.map((account) => account.name).join(", ")} — carrying balance
                  and history. Tracking a card here also needs its limit, closing day and due
                  day, which no statement import can know. Add those once and this page fills
                  in with statements, installments and available limit.
                </>
              ) : (
                <>Add a credit card to see its limit, commitments, and statement history here.</>
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="space-y-4">
          {cards.map((card) => {
            const tight = card.utilizationPercent >= 80;
            return (
              <li key={card.id}>
                <Link
                  href={`/plan/cards/${card.id}`}
                  className="group block rounded-xl border border-border/60 bg-card p-4 transition-colors duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:bg-foreground/[0.02]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{card.name}</p>
                      {card.issuer && (
                        <p className="text-xs text-muted-foreground">{card.issuer}</p>
                      )}
                    </div>
                    <span className="flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground">
                      <span
                        className={cn(
                          "font-amount tabular-nums",
                          tight && "font-medium text-warning",
                        )}
                      >
                        {card.utilizationPercent}%
                      </span>
                      used
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        className="size-3.5 text-muted-foreground/50 transition-transform duration-[var(--duration-state)] ease-[var(--ease-out-quint)] group-hover:translate-x-0.5"
                        strokeWidth={2}
                      />
                    </span>
                  </div>

                  <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-foreground/[0.05]">
                    <span
                      className={cn(
                        "grow-x block h-full rounded-full",
                        tight ? "bg-warning" : "bg-primary",
                      )}
                      style={{ width: `${Math.min(100, card.utilizationPercent)}%`, "--i": 0 } as React.CSSProperties}
                    />
                  </div>

                  <dl className="mt-3 grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Limit</dt>
                      <dd className="font-amount mt-0.5 tabular-nums">
                        {formatMoney(card.creditLimitMinor, card.currencyCode)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Committed</dt>
                      <dd className="font-amount mt-0.5 tabular-nums">
                        {formatMoney(card.committedMinor, card.currencyCode)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Available</dt>
                      <dd className="font-amount mt-0.5 tabular-nums">
                        {formatMoney(card.availableLimitMinor, card.currencyCode)}
                      </dd>
                    </div>
                  </dl>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <ArchivedList
        rows={archivedCards.map((card) => ({ id: card.id, name: card.name }))}
        label="cards"
        restore={restoreCreditCard}
      />
    </div>
  );
}
