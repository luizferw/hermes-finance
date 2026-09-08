import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, users } from "@kosh/db";
import {
  buildUserForecastDetailed,
  getConfidenceBreakdown,
  getFinancePosition,
  getHardReserveMinor,
  getSafeToSpend,
  getUpcomingCommitments,
  getCardStatement,
  listCreditCards,
  listPurchasePlans,
} from "./queries";
import { compareStoredPaymentOptions, simulateUserPurchase } from "./simulation";

/**
 * The PRD's mandatory end-to-end scenario (§83), run against the seeded
 * fixture: two accounts, salary, rent, a variable energy bill, internet, four
 * cards carrying statements and installments, and a R$1.500 hard reserve.
 *
 * These assertions are about *shape and consistency*, not about specific
 * amounts — the fixture is allowed to evolve. What must never change is that
 * every answer is internally coherent and derived from the engine.
 */
const FIXTURE_EMAIL = "prd-scenario@kosh.local";

let userId: string;

beforeAll(async () => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, FIXTURE_EMAIL)).limit(1);
  if (!user) throw new Error(`fixture user missing — run pnpm --filter @kosh/db seed:prd-scenario`);
  userId = user.id;
});

describe("PRD §83 scenario", () => {
  it("answers 'how much do I really have' with a dated, sourced position", async () => {
    const position = await getFinancePosition(userId);

    expect(position.accounts.length).toBeGreaterThan(0);
    expect(position.balanceMinor).toBe(
      position.accounts.reduce((total, account) => total + account.balanceMinor, 0),
    );
    for (const account of position.accounts) {
      expect(Number.isInteger(account.balanceMinor)).toBe(true);
      expect(account.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["snapshot", "ledger"]).toContain(account.source);
      expect(account.ageDays).toBeGreaterThanOrEqual(0);
    }
  });

  it("projects a daily trajectory whose trough is consistent with its own days", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 90);

    expect(forecast.days.length).toBe(91);
    expect(forecast.days[0]!.openingBalanceMinor).toBe(forecast.openingBalanceMinor);
    const lowestClose = Math.min(...forecast.days.map((day) => day.closingBalanceMinor));
    expect(forecast.minimumBalanceMinor).toBe(lowestClose);
    expect(forecast.days.find((day) => day.date === forecast.minimumBalanceDate)?.closingBalanceMinor).toBe(
      forecast.minimumBalanceMinor,
    );
  });

  it("never carries two live events for the same logical commitment", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 365);
    const keys = forecast.events.map((event) => event.logicalKey);

    expect(new Set(keys).size).toBe(keys.length);
    expect(forecast.events.every((event) => event.resolvedByTransactionId === undefined)).toBe(true);
  });

  it("bills a card once per statement, never once per installment", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 365);
    const statements = forecast.events.filter((event) => event.sourceType === "card_statement");

    expect(statements.length).toBeGreaterThan(0);
    // One event per (card, statement month); an installment never reaches cash directly.
    expect(new Set(statements.map((event) => event.logicalKey)).size).toBe(statements.length);
    expect(forecast.events.some((event) => event.sourceType === "installment")).toBe(false);
  });

  it("computes a safe-to-spend that honours the hard reserve", async () => {
    const hardReserveMinor = await getHardReserveMinor(userId);
    const result = await getSafeToSpend(userId, 30);

    expect(hardReserveMinor).toBeGreaterThan(0);
    expect(result.hardReserveMinor).toBe(hardReserveMinor);
    expect(result.safeToSpendMinor).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.safeToSpendMinor)).toBe(true);
    expect(result.safeToSpendMinor).toBe(
      result.hardReserveViolated ? 0 : result.minimumBalanceMinor - hardReserveMinor,
    );
  });

  it("lists upcoming commitments as outflows carrying provenance", async () => {
    const commitments = await getUpcomingCommitments(userId, 60);

    expect(commitments.length).toBeGreaterThan(0);
    for (const commitment of commitments) {
      expect(commitment.amountMinor).toBeLessThan(0);
      expect(commitment.label.length).toBeGreaterThan(0);
      expect(["ACTUAL", "CONFIRMED", "HIGH", "MEDIUM", "LOW"]).toContain(commitment.confidence);
    }
  });

  it("reports how much of the projection rests on assumptions", async () => {
    const breakdown = await getConfidenceBreakdown(userId, 90);
    const shares = Object.values(breakdown.sharePercent).reduce((total, value) => total + value, 0);

    expect(breakdown.totalMinor).toBeGreaterThan(0);
    // Rounding to whole percent can drift a point or two from 100.
    expect(shares).toBeGreaterThan(95);
    expect(shares).toBeLessThan(105);
  });

  it("keeps card commitments inside the credit limit accounting", async () => {
    const cards = await listCreditCards(userId);

    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.availableLimitMinor).toBe(card.creditLimitMinor - card.committedMinor);
      expect(Number.isInteger(card.committedMinor)).toBe(true);
    }
  });

  it("compares PIX against 5x and 10x for the stroller, deterministically", async () => {
    const [plan] = await listPurchasePlans(userId);
    expect(plan).toBeDefined();
    const item = plan!.items[0]!;
    expect(item.paymentOptions.length).toBe(3);

    const result = await compareStoredPaymentOptions(userId, item.id);
    expect(result).not.toBeNull();
    const { comparison } = result!;

    expect(comparison.options).toHaveLength(3);
    for (const option of comparison.options) {
      expect(option.reasons.length).toBeGreaterThan(0);
      expect(option.forecast.openingBalanceMinor).toBe(comparison.options[0]!.forecast.openingBalanceMinor);
    }

    if (comparison.status === "OK") {
      const recommended = comparison.options.find((option) => option.id === comparison.recommendedOptionId)!;
      expect(recommended.feasible).toBe(true);
      expect(recommended.rejections).toEqual([]);
      // Nothing feasible may be strictly cheaper than the recommendation.
      for (const option of comparison.options.filter((candidate) => candidate.feasible)) {
        expect(option.totalCostMinor).toBeGreaterThanOrEqual(recommended.totalCostMinor);
      }
    } else {
      expect(comparison.recommendedOptionId).toBeUndefined();
      expect(comparison.blockers.length).toBeGreaterThan(0);
    }
  });

  it("gives the same answer twice for the same question", async () => {
    const first = await compareStoredPaymentOptions(userId, (await listPurchasePlans(userId))[0]!.items[0]!.id);
    const second = await compareStoredPaymentOptions(userId, (await listPurchasePlans(userId))[0]!.items[0]!.id);

    expect(first!.comparison.status).toBe(second!.comparison.status);
    expect(first!.comparison.recommendedOptionId).toBe(second!.comparison.recommendedOptionId);
    expect(first!.comparison.options.map((option) => option.minimumBalanceMinor)).toEqual(
      second!.comparison.options.map((option) => option.minimumBalanceMinor),
    );
  });

  it("simulates a R$2.500 purchase and reports its impact without touching the baseline", async () => {
    const before = await getSafeToSpend(userId, 365);
    const simulation = await simulateUserPurchase(
      userId,
      { id: "vitest-adhoc", method: "pix", amountMinor: 250_000 },
      { horizonDays: 365 },
    );
    const after = await getSafeToSpend(userId, 365);

    expect(simulation.totalCostMinor).toBe(250_000);
    expect(simulation.immediateImpactMinor).toBe(250_000);
    expect(simulation.safeToSpendBeforeMinor).toBe(before.safeToSpendMinor);
    // A simulation is a question, not a change.
    expect(after.safeToSpendMinor).toBe(before.safeToSpendMinor);
    expect(simulation.reasons.length).toBeGreaterThan(0);
  });
});

/**
 * Regression: a card whose debt lives in the ledger (an import, not a
 * registered installment plan) must still report its limit as taken.
 *
 * Deriving the committed amount from the installment table alone reported zero
 * for such cards and overstated the available limit — telling the user they had
 * credit they did not have.
 */
describe("credit card committed amount", () => {
  it("derives what is taken from the linked account balance, not from installments", async () => {
    const cards = await listCreditCards(userId);
    expect(cards.length).toBeGreaterThan(0);

    for (const card of cards) {
      const owed = Math.max(0, -card.account!.currentBalanceMinor);
      expect(card.committedMinor).toBe(owed);
      expect(card.availableLimitMinor).toBe(card.creditLimitMinor - owed);
    }

    // The fixture must actually exercise the rule: at least one card carries
    // real debt, otherwise the assertions above compare zero against zero and
    // could never catch the regression they exist for.
    expect(cards.some((card) => card.committedMinor > 0)).toBe(true);
  });

  it("does not add scheduled installments on top of the debt they belong to", async () => {
    const cards = await listCreditCards(userId);
    const withPlan = cards.filter((card) => card.scheduledInstallmentsMinor > 0);

    expect(withPlan.length).toBeGreaterThan(0);
    for (const card of withPlan) {
      // Installments say *when* the debt is billed. Counting them again on top
      // of the balance would double-count the same purchase.
      expect(card.committedMinor).toBeLessThan(
        Math.max(0, -card.account!.currentBalanceMinor) + card.scheduledInstallmentsMinor,
      );
    }
  });

  it("never reports more available limit than the limit itself", async () => {
    for (const card of await listCreditCards(userId)) {
      expect(card.availableLimitMinor).toBeLessThanOrEqual(card.creditLimitMinor);
      expect(card.utilizationPercent).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * Regression: a card whose history came from an import has no recorded billing
 * cycles, only ledger transactions. Showing "nothing here" for a card with a
 * year of spending hides data the app already holds.
 */
describe("card statement derivation", () => {
  it("derives statements from transactions when no cycle was recorded", async () => {
    const cards = await listCreditCards(userId);
    const withSpending = [];
    for (const card of cards) {
      const statement = await getCardStatement(userId, card.id);
      if (statement && statement.cycles.length > 0) withSpending.push(statement);
    }

    expect(withSpending.length).toBeGreaterThan(0);
    for (const statement of withSpending) {
      for (const cycle of statement.cycles) {
        expect(cycle.statementMonth).toMatch(/^\d{4}-\d{2}$/);
        expect(cycle.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(["recorded", "derived"]).toContain(cycle.source);
        // A derived period must never claim to be a reconciled statement.
        if (cycle.source === "derived") expect(cycle.isReconciled).toBe(false);
        expect(Number.isInteger(cycle.totalMinor)).toBe(true);
      }
      // Newest first, and one entry per statement month.
      const months = statement.cycles.map((cycle) => cycle.statementMonth);
      expect(new Set(months).size).toBe(months.length);
      expect([...months]).toEqual([...months].sort().reverse());
    }
  });
});
