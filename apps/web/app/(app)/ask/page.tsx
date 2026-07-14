import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { env } from "@/lib/env";
import { listConversations } from "@/modules/agent/conversations";
import { getAiStatus } from "@/modules/agent/provider";
import { AskWorkspace } from "@/components/ask/ask-workspace";
import { listAccounts } from "@/modules/accounts/queries";
import { getRecentTransactions } from "@/modules/transactions/queries";
import { listBudgetsWithProgress } from "@/modules/budgets/queries";
import { listBills } from "@/modules/bills/queries";
import { listGoals } from "@/modules/goals/queries";

export const metadata: Metadata = { title: "Ask Kosh" };

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  if (!env().KOSH_AI_ENABLED) notFound();
  const user = await requireUser();
  const [conversations, status, { q }, accounts, recent, budgets, bills, goals] = await Promise.all([
    listConversations(user.id),
    Promise.resolve(getAiStatus()),
    searchParams,
    listAccounts(user.id),
    getRecentTransactions(user.id, 1),
    listBudgetsWithProgress(user.id),
    listBills(user.id),
    listGoals(user.id),
  ]);

  const starters = status.aiEnabled
    ? [
        recent.length > 0 ? "Summarize this month from my recorded transactions" : null,
        recent.length > 0 ? "What changed compared with last month?" : null,
        recent.length > 0 ? "Find unusual changes in my spending" : null,
        bills.length > 0 ? "What bills are coming up?" : null,
        budgets.length > 0 ? "How are my budgets doing this month?" : null,
        goals.length > 0 ? "Show my savings goal progress" : null,
        accounts.some((account) => !account.isArchived)
          ? "What financial data am I still missing?"
          : "What do I need to set up before you can help?",
      ].filter((item): item is string => item !== null).slice(0, 6)
    : [
        "Where did my money go this month?",
        "Compare this month with last month",
        "What bills are due soon?",
        "Show my recurring commitments",
      ];

  return (
    <AskWorkspace
      user={{ name: user.name }}
      status={status}
      conversations={conversations.map((c) => ({
        id: c.id,
        title: c.title,
        pinned: c.pinned,
        updatedAt: c.updatedAt.toISOString(),
      }))}
      initialQuery={q ?? ""}
      starters={starters}
    />
  );
}
