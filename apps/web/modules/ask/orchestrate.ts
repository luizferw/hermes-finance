import "server-only";
import {
  parseAskIntent,
  addMonthsClamped,
  todayIso,
  type NavTarget,
} from "@kosh/domain";
import { getApiUser } from "@/lib/session";
import {
  getSpendingByCategory,
  getMonthSummaryFor,
} from "@/modules/reports/queries";
import { listTransactions } from "@/modules/transactions/queries";
import { getUserSettings } from "@/modules/settings/queries";
import { getUpcomingBills } from "@/modules/bills/queries";
import { listRecurring } from "@/modules/recurring/queries";
import type { AskAnswer, AskBillRow } from "./answer";

const NAV_HREF: Record<NavTarget, string> = {
  imports: "/transactions/import",
  accounts: "/accounts",
  inbox: "/inbox",
  reports: "/reports",
  goals: "/plan/goals",
  budgets: "/plan/budgets",
  bills: "/plan/bills",
};

const MONTH_FMT = new Intl.DateTimeFormat("en-IN", { month: "long" });
function monthLabel(iso: string): string {
  return MONTH_FMT.format(new Date(`${iso.slice(0, 7)}-01T00:00:00`));
}

/**
 * Turn a question into a structured answer using only deterministic queries.
 * Every figure is computed server-side from the user's real data; the parser
 * only decides *which* query to run. Returns { kind: "none" } when nothing
 * deterministic matches, so the caller can fall back to search.
 */
export async function answerAsk(query: string): Promise<AskAnswer> {
  const user = await getApiUser();
  if (!user) return { kind: "none", query };

  const intent = parseAskIntent(query);
  if (!intent) return { kind: "none", query };

  const currency = (await getUserSettings(user.id)).currencyCode;

  switch (intent.kind) {
    case "navigate":
      return { kind: "navigate", href: NAV_HREF[intent.target], label: intent.target };

    case "spending": {
      const monthIso =
        intent.period === "last_month"
          ? addMonthsClamped(todayIso(), -1)
          : todayIso();
      const label = monthLabel(monthIso);
      const spending = await getSpendingByCategory(user.id, monthIso);
      const total = spending.reduce((s, c) => s + c.spentMinor, 0);

      // A named category → a single figure for that category.
      if (intent.categoryQuery) {
        const q = intent.categoryQuery.toLowerCase();
        const match = spending.find((c) => c.name.toLowerCase().includes(q));
        if (match) {
          return {
            kind: "amount",
            title: `${match.name} · ${label}`,
            amountMinor: match.spentMinor,
            currency,
            caption:
              total > 0
                ? `${Math.round((match.spentMinor / total) * 100)}% of ${label}'s spending`
                : undefined,
            href: "/reports",
            followUps: [
              { label: "All spending", query: "where did my money go" },
              { label: "Compare months", query: "compare this month with last month" },
            ],
          };
        }
        // No such category spent → fall through to the global breakdown below.
      }

      if (total === 0) {
        return {
          kind: "amount",
          title: `Spending · ${label}`,
          amountMinor: 0,
          currency,
          caption: "Nothing recorded for this period yet.",
          href: "/reports",
        };
      }

      return {
        kind: "categories",
        title: `Where it went · ${label}`,
        currency,
        rows: spending.slice(0, 6).map((c) => ({
          name: c.name,
          color: c.color,
          spentMinor: c.spentMinor,
        })),
        totalMinor: total,
        href: "/reports",
        followUps: [
          { label: "Compare months", query: "compare this month with last month" },
          { label: "Big transactions", query: "transactions above 5000" },
        ],
      };
    }

    case "find_above": {
      const major = intent.amountMinor / 100;
      const { items, total } = await listTransactions(user.id, {
        minAmount: major,
        page: 1,
        pageSize: 6,
      } as Parameters<typeof listTransactions>[1]);
      return {
        kind: "transactions",
        title: `Above ${formatPlain(intent.amountMinor, currency)}`,
        txns: items.map((t) => ({
          id: t.id,
          date: t.date,
          description: t.description,
          amountMinor: t.amountMinor,
          currencyCode: t.currencyCode,
          category: t.category
            ? { name: t.category.name, color: t.category.color }
            : null,
        })),
        moreCount: Math.max(0, total - items.length),
        href: `/transactions?minAmount=${major}`,
      };
    }

    case "due_soon": {
      const bills = await getUpcomingBills(user.id, 30);
      const rows: AskBillRow[] = bills.slice(0, 6).map((b) => ({
        id: b.bill.id,
        name: b.bill.name,
        amountMinor: b.bill.expectedAmountMinor,
        currencyCode: b.bill.currencyCode,
        dueDate: b.bill.nextDueDate,
        daysUntilDue: b.daysUntilDue,
        overdue: b.state === "overdue",
      }));
      if (rows.length === 0) {
        return {
          kind: "amount",
          title: "Coming up",
          amountMinor: 0,
          currency,
          caption: "Nothing due in the next 30 days.",
          href: "/plan/bills",
        };
      }
      return { kind: "bills", title: "Coming up", currency, rows, href: "/plan/bills" };
    }

    case "pending": {
      const { items, total } = await listTransactions(user.id, {
        status: "pending",
        page: 1,
        pageSize: 6,
      } as Parameters<typeof listTransactions>[1]);
      return {
        kind: "transactions",
        title: total === 0 ? "Nothing pending review" : "Pending review",
        txns: items.map((t) => ({
          id: t.id,
          date: t.date,
          description: t.description,
          amountMinor: t.amountMinor,
          currencyCode: t.currencyCode,
          category: t.category
            ? { name: t.category.name, color: t.category.color }
            : null,
        })),
        moreCount: Math.max(0, total - items.length),
        href: "/inbox",
      };
    }

    case "recurring": {
      const all = await listRecurring(user.id);
      const active = all.filter((r) => r.isActive);
      const rows: AskBillRow[] = active.slice(0, 8).map((r) => ({
        id: r.id,
        name: r.name,
        amountMinor: Math.abs(r.amountMinor),
        currencyCode: r.currencyCode,
        dueDate: r.nextRunDate,
        daysUntilDue: 0,
        overdue: false,
      }));
      if (rows.length === 0) {
        return {
          kind: "amount",
          title: "Subscriptions",
          amountMinor: 0,
          currency,
          caption: "No recurring commitments tracked yet.",
          href: "/plan/recurring",
        };
      }
      return {
        kind: "bills",
        title: "Recurring commitments",
        currency,
        rows,
        href: "/plan/recurring",
      };
    }

    case "compare_months": {
      const thisIso = todayIso();
      const lastIso = addMonthsClamped(thisIso, -1);
      const [a, b] = await Promise.all([
        getMonthSummaryFor(user.id, lastIso),
        getMonthSummaryFor(user.id, thisIso),
      ]);
      return {
        kind: "compare",
        title: "This month vs last",
        currency,
        a: { label: monthLabel(lastIso), ...a },
        b: { label: monthLabel(thisIso), ...b },
        href: "/reports",
      };
    }
  }
}

// Minimal server-side money string for titles (client renders figures itself).
function formatPlain(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}
