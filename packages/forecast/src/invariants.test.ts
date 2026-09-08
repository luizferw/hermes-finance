import { describe, expect, it } from "vitest";
import { addDaysIso, buildForecast, type Confidence, type ForecastEvent } from "./forecast";

/**
 * Property-based invariants over generated forecasts.
 *
 * A seeded generator keeps every run reproducible: a failure reports the seed
 * that produced it, so the counterexample can be replayed exactly rather than
 * chased. This avoids a new dependency for what is a small, well-bounded need.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32: cheap, deterministic, good enough to shake out arithmetic bugs.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const CONFIDENCES: Confidence[] = ["ACTUAL", "CONFIRMED", "HIGH", "MEDIUM", "LOW"];

interface GeneratedCase {
  asOf: string;
  horizonEnd: string;
  balances: Array<{ accountId: string; amountMinor: number; observedAt: string }>;
  events: ForecastEvent[];
}

function generateCase(seed: number): GeneratedCase {
  const random = makeRandom(seed);
  const pick = (max: number) => Math.floor(random() * max);
  const asOf = "2026-01-01";
  const horizonDays = 5 + pick(90);
  const horizonEnd = addDaysIso(asOf, horizonDays);

  const balances = Array.from({ length: 1 + pick(3) }, (_unused, index) => ({
    accountId: `account-${index}`,
    amountMinor: pick(2_000_000) - 500_000,
    observedAt: asOf,
  }));

  const events: ForecastEvent[] = Array.from({ length: pick(40) }, (_unused, index) => {
    const amountMinor = pick(400_000) - 200_000;
    return {
      id: `event-${index}`,
      // A deliberately small key space, so duplicate logical keys are common
      // and the precedence rule is exercised rather than assumed.
      logicalKey: `key-${pick(8)}`,
      expectedAt: addDaysIso(asOf, pick(horizonDays + 1)),
      amountMinor: amountMinor === 0 ? 1 : amountMinor,
      sourceType: "generated",
      confidence: CONFIDENCES[pick(CONFIDENCES.length)]!,
    };
  });

  return { asOf, horizonEnd, balances, events };
}

const SEEDS = Array.from({ length: 200 }, (_unused, index) => index * 2_654_435_761 + 12345);

describe("buildForecast invariants", () => {
  it("closes each day exactly on opening plus inflows minus outflows", () => {
    for (const seed of SEEDS) {
      const forecast = buildForecast(generateCase(seed));
      for (const day of forecast.days) {
        expect(
          day.closingBalanceMinor,
          `seed ${seed} broke the daily identity on ${day.date}`,
        ).toBe(day.openingBalanceMinor + day.inflowsMinor - day.outflowsMinor);
      }
    }
  });

  it("chains each day's opening to the previous day's closing", () => {
    for (const seed of SEEDS) {
      const forecast = buildForecast(generateCase(seed));
      expect(forecast.days[0]!.openingBalanceMinor).toBe(forecast.openingBalanceMinor);
      for (let index = 1; index < forecast.days.length; index += 1) {
        expect(forecast.days[index]!.openingBalanceMinor, `seed ${seed}`).toBe(
          forecast.days[index - 1]!.closingBalanceMinor,
        );
      }
    }
  });

  it("ends on the opening balance plus the net of every active event", () => {
    for (const seed of SEEDS) {
      const forecast = buildForecast(generateCase(seed));
      const net = forecast.events.reduce((total, event) => total + event.amountMinor, 0);
      expect(forecast.days.at(-1)!.closingBalanceMinor, `seed ${seed}`).toBe(
        forecast.openingBalanceMinor + net,
      );
    }
  });

  it("reports a minimum that no day's closing balance undercuts", () => {
    for (const seed of SEEDS) {
      const forecast = buildForecast(generateCase(seed));
      for (const day of forecast.days) {
        expect(day.closingBalanceMinor, `seed ${seed} on ${day.date}`).toBeGreaterThanOrEqual(
          forecast.minimumBalanceMinor,
        );
      }
      // The trough is the lowest daily close, which is what the chart plots and
      // what a spend today is actually constrained by.
      const lowestClose = Math.min(...forecast.days.map((day) => day.closingBalanceMinor));
      expect(forecast.minimumBalanceMinor, `seed ${seed}`).toBe(lowestClose);
      const trough = forecast.days.find((day) => day.date === forecast.minimumBalanceDate);
      expect(trough?.closingBalanceMinor, `seed ${seed}: the date must locate the trough`).toBe(
        forecast.minimumBalanceMinor,
      );
    }
  });

  it("keeps every amount an integer number of minor units", () => {
    for (const seed of SEEDS) {
      const forecast = buildForecast(generateCase(seed));
      expect(Number.isInteger(forecast.openingBalanceMinor)).toBe(true);
      expect(Number.isInteger(forecast.minimumBalanceMinor)).toBe(true);
      for (const day of forecast.days) {
        for (const value of [day.openingBalanceMinor, day.inflowsMinor, day.outflowsMinor, day.closingBalanceMinor]) {
          expect(Number.isInteger(value), `seed ${seed} on ${day.date}`).toBe(true);
        }
      }
    }
  });

  it("never keeps two events for the same logical commitment", () => {
    for (const seed of SEEDS) {
      const forecast = buildForecast(generateCase(seed));
      const keys = forecast.events.map((event) => event.logicalKey);
      expect(new Set(keys).size, `seed ${seed}`).toBe(keys.length);
    }
  });

  it("keeps every active event inside the requested window", () => {
    for (const seed of SEEDS) {
      const generated = generateCase(seed);
      const forecast = buildForecast(generated);
      for (const event of forecast.events) {
        expect(event.expectedAt >= generated.asOf && event.expectedAt <= generated.horizonEnd, `seed ${seed}`).toBe(true);
      }
    }
  });

  it("is reproducible: the same input always yields the same forecast", () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const generated = generateCase(seed);
      expect(JSON.stringify(buildForecast(generated))).toBe(JSON.stringify(buildForecast(generated)));
    }
  });

  it("leaves the consolidated position unchanged by a transfer between own accounts", () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const generated = generateCase(seed);
      const baseline = buildForecast(generated);
      const transferDate = addDaysIso(generated.asOf, 1);
      const withTransfer = buildForecast({
        ...generated,
        events: [
          ...generated.events,
          { id: "transfer-out", logicalKey: "transfer:out", expectedAt: transferDate, amountMinor: -123_456, sourceType: "transfer", confidence: "ACTUAL" },
          { id: "transfer-in", logicalKey: "transfer:in", expectedAt: transferDate, amountMinor: 123_456, sourceType: "transfer", confidence: "ACTUAL" },
        ],
      });

      expect(withTransfer.days.at(-1)!.closingBalanceMinor, `seed ${seed}`).toBe(
        baseline.days.at(-1)!.closingBalanceMinor,
      );
      expect(withTransfer.minimumBalanceMinor).toBe(baseline.minimumBalanceMinor);
    }
  });
});
