import type { Metadata } from "next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { formatDateShort, formatMoney, formatMonth } from "@/lib/format";
import { getUpcomingCommitments } from "@/modules/finance/queries";
import { getUserSettings } from "@/modules/settings/queries";
import { ConfidenceBadge } from "@/components/plan/confidence-badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const metadata: Metadata = { title: "Commitments" };

/** How far ahead the agenda looks. */
const HORIZON_DAYS = 180;

export default async function CommitmentsPage() {
  const user = await requireUser();
  const [settings, commitments] = await Promise.all([
    getUserSettings(user.id),
    getUpcomingCommitments(user.id, HORIZON_DAYS),
  ]);
  const currency = settings.currencyCode;

  const sorted = [...commitments].sort((a, b) => a.expectedAt.localeCompare(b.expectedAt));
  const byMonth = new Map<string, typeof sorted>();
  for (const commitment of sorted) {
    const key = commitment.expectedAt.slice(0, 7);
    const group = byMonth.get(key) ?? [];
    group.push(commitment);
    byMonth.set(key, group);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Upcoming commitments</h2>
        <p className="text-sm text-muted-foreground">
          Everything the forecast expects to leave your accounts over the next {HORIZON_DAYS} days.
        </p>
      </div>

      {sorted.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Calendar03Icon} />
            </EmptyMedia>
            <EmptyTitle>Nothing committed ahead</EmptyTitle>
            <EmptyDescription>
              Bills, recurring payments, and card statements will show up here as they&apos;re expected.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-8">
          {[...byMonth.entries()].map(([month, items]) => (
            <div key={month}>
              <h3 className="micro-label">{formatMonth(month)}</h3>
              <ul className="mt-2 divide-y divide-dashed">
                {items.map((item) => (
                  <li
                    key={item.logicalKey}
                    className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <span className="font-amount w-14 shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatDateShort(item.expectedAt)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                    <ConfidenceBadge confidence={item.confidence} />
                    <span className="font-amount w-28 shrink-0 text-right text-sm tabular-nums">
                      {formatMoney(Math.abs(item.amountMinor), currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
