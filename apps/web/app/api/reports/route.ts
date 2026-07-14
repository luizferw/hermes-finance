import { withUser, ok } from "@/modules/shared/api";
import {
  getMonthlyFlows,
  getNetWorthSeries,
  getRecentCashflow,
  getSpendingByCategory,
} from "@/modules/reports/queries";

export const GET = withUser(async (_req, { user }) => {
  const [flows, categories, netWorth, cashflow] = await Promise.all([
    getMonthlyFlows(user.id),
    getSpendingByCategory(user.id),
    getNetWorthSeries(user.id),
    getRecentCashflow(user.id),
  ]);
  return ok({ flows, categories, netWorth, cashflow });
});
