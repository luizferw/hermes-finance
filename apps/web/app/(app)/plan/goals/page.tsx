import type { Metadata } from "next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Target01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { listAccounts } from "@/modules/accounts/queries";
import { listGoals } from "@/modules/goals/queries";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { GoalList } from "./goal-list";
import { NewGoalDialog } from "./new-goal-dialog";

export const metadata: Metadata = { title: "Goals" };

export default async function GoalsPage() {
  const user = await requireUser();
  const [goals, accounts] = await Promise.all([
    listGoals(user.id),
    listAccounts(user.id),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Savings goals</h2>
          <p className="text-sm text-muted-foreground">
            Track targets, deadlines, and manual contributions.
          </p>
        </div>
        <NewGoalDialog accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} />
      </div>

      {goals.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Target01Icon} />
            </EmptyMedia>
            <EmptyTitle>No goals yet</EmptyTitle>
            <EmptyDescription>
              Create an emergency fund, travel target, down payment, or any
              amount you want to set aside.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <GoalList
          goals={goals.map((goal) => ({
            id: goal.id,
            name: goal.name,
            targetAmountMinor: goal.targetAmountMinor,
            currentAmountMinor: goal.currentAmountMinor,
            currencyCode: goal.currencyCode,
            targetDate: goal.targetDate,
            achievedAt: goal.achievedAt,
            createdAt: goal.createdAt,
            accountName: goal.account?.name ?? null,
          }))}
        />
      )}
    </div>
  );
}
