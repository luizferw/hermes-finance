import { describe, expect, it } from "vitest";
import { addDaysIso, buildForecast, type Confidence, type ForecastEvent } from "@hermes-finance/forecast";
import { calculateSafeToSpend, comparePaymentOptions, monthlySettlementEvents } from "./planning";

/** Seeded xorshift32, so a failing case can be replayed from its seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const CONFIDENCES: Confidence[] = ["ACTUAL", "CONFIRMED", "HIGH", "MEDIUM", "LOW"];

function generateScenario(seed: number) {
  const random = makeRandom(seed);
  const pick = (max: number) => Math.floor(random() * max);
  const asOf = "2026-01-01";
  const horizonDays = 10 + pick(80);

  const events: ForecastEvent[] = Array.from({ length: pick(25) }, (_unused, index) => {
    const amountMinor = pick(300_000) - 150_000;
    return {
      id: `event-${index}`,
      logicalKey: `key-${index}`,
      expectedAt: addDaysIso(asOf, pick(horizonDays + 1)),
      amountMinor: amountMinor === 0 ? -1 : amountMinor,
      sourceType: "generated",
      confidence: CONFIDENCES[pick(CONFIDENCES.length)]!,
    };
  });

  return {
    forecastInput: {
      asOf,
      horizonEnd: addDaysIso(asOf, horizonDays),
      balances: [{ accountId: "consolidated", amountMinor: pick(3_000_000), observedAt: asOf }],
      events,
    },
    hardReserveMinor: pick(500_000),
  };
}

const SEEDS = Array.from({ length: 200 }, (_unused, index) => index * 2_246_822_519 + 7);

describe("calculateSafeToSpend invariants", () => {
  it("never reports an amount whose immediate spend would breach the hard reserve", () => {
    for (const seed of SEEDS) {
      const scenario = generateScenario(seed);
      const { safeToSpendMinor } = calculateSafeToSpend(scenario);
      if (safeToSpendMinor === 0) continue;

      // Spend the whole allowance today and re-run the engine.
      const after = buildForecast({
        ...scenario.forecastInput,
        events: [
          ...scenario.forecastInput.events,
          {
            id: "spend-it-all",
            logicalKey: "spend-it-all",
            expectedAt: scenario.forecastInput.asOf,
            amountMinor: -safeToSpendMinor,
            sourceType: "test",
            confidence: "CONFIRMED",
          },
        ],
      });

      expect(after.minimumBalanceMinor, `seed ${seed} breached the reserve`).toBeGreaterThanOrEqual(
        scenario.hardReserveMinor,
      );
    }
  });

  it("reports the largest such amount: one cent more always breaches", () => {
    for (const seed of SEEDS) {
      const scenario = generateScenario(seed);
      const { safeToSpendMinor, hardReserveViolated } = calculateSafeToSpend(scenario);
      if (hardReserveViolated) continue;

      const after = buildForecast({
        ...scenario.forecastInput,
        events: [
          ...scenario.forecastInput.events,
          {
            id: "one-cent-more",
            logicalKey: "one-cent-more",
            expectedAt: scenario.forecastInput.asOf,
            amountMinor: -(safeToSpendMinor + 1),
            sourceType: "test",
            confidence: "CONFIRMED",
          },
        ],
      });

      expect(after.minimumBalanceMinor, `seed ${seed} left room on the table`).toBeLessThan(
        scenario.hardReserveMinor,
      );
    }
  });

  it("is never negative and never exceeds the projected trough", () => {
    for (const seed of SEEDS) {
      const scenario = generateScenario(seed);
      const result = calculateSafeToSpend(scenario);
      expect(result.safeToSpendMinor).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.safeToSpendMinor)).toBe(true);
      expect(result.safeToSpendMinor).toBeLessThanOrEqual(Math.max(0, result.minimumBalanceMinor));
    }
  });

  it("never grows when the hard reserve grows", () => {
    for (const seed of SEEDS) {
      const scenario = generateScenario(seed);
      const lower = calculateSafeToSpend(scenario);
      const higher = calculateSafeToSpend({ ...scenario, hardReserveMinor: scenario.hardReserveMinor + 50_000 });
      expect(higher.safeToSpendMinor, `seed ${seed}`).toBeLessThanOrEqual(lower.safeToSpendMinor);
    }
  });
});

describe("comparePaymentOptions invariants", () => {
  it("only ever recommends an option that breaks no hard constraint", () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const scenario = generateScenario(seed);
      const random = makeRandom(seed);
      const installments = 1 + Math.floor(random() * 12);
      const total = 50_000 + Math.floor(random() * 400_000);

      const comparison = comparePaymentOptions({
        ...scenario,
        options: [
          {
            id: "cash",
            label: "cash",
            totalCostMinor: total,
            installments: 1,
            cashEvents: monthlySettlementEvents({
              logicalKeyPrefix: "simulation:cash",
              sourceType: "purchase_simulation",
              firstPaymentDate: scenario.forecastInput.asOf,
              installments: 1,
              installmentAmountMinor: total,
            }),
          },
          {
            id: "installments",
            label: `${installments}x`,
            totalCostMinor: total + 20_000,
            installments,
            cashEvents: monthlySettlementEvents({
              logicalKeyPrefix: "simulation:plan",
              sourceType: "purchase_simulation",
              firstPaymentDate: addDaysIso(scenario.forecastInput.asOf, 30),
              installments,
              installmentAmountMinor: Math.floor((total + 20_000) / installments),
              totalCostMinor: total + 20_000,
            }),
          },
        ],
      });

      if (comparison.recommendedOptionId === undefined) {
        expect(comparison.options.every((option) => !option.feasible), `seed ${seed}`).toBe(true);
        expect(comparison.status).not.toBe("OK");
        continue;
      }

      const recommended = comparison.options.find((option) => option.id === comparison.recommendedOptionId)!;
      expect(recommended.feasible, `seed ${seed} recommended an infeasible option`).toBe(true);
      expect(recommended.rejections).toEqual([]);
      // No feasible option may be strictly cheaper than the recommendation.
      for (const option of comparison.options.filter((candidate) => candidate.feasible)) {
        expect(option.totalCostMinor, `seed ${seed}`).toBeGreaterThanOrEqual(recommended.totalCostMinor);
      }
    }
  });

  it("always explains every option it evaluated", () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const scenario = generateScenario(seed);
      const comparison = comparePaymentOptions({
        ...scenario,
        options: [
          {
            id: "only",
            label: "only",
            totalCostMinor: 100_000,
            cashEvents: monthlySettlementEvents({
              logicalKeyPrefix: "simulation:only",
              sourceType: "purchase_simulation",
              firstPaymentDate: scenario.forecastInput.asOf,
              installments: 1,
              installmentAmountMinor: 100_000,
            }),
          },
        ],
      });

      for (const option of comparison.options) {
        expect(option.reasons.length, `seed ${seed}`).toBeGreaterThan(0);
      }
      if (comparison.status !== "OK") expect(comparison.blockers.length).toBeGreaterThan(0);
    }
  });
});
