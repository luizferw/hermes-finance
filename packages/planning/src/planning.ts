import {
  addMonthsClampedIso,
  assertMinorUnits,
  assertValidDate,
  buildForecast,
  type BuildForecastInput,
  type Confidence,
  type DateString,
  type Forecast,
  type ForecastEvent,
} from "@hermes-finance/forecast";

export interface SafeToSpendInput {
  forecastInput: BuildForecastInput;
  hardReserveMinor: number;
}

export interface SafeToSpendResult {
  safeToSpendMinor: number;
  minimumBalanceMinor: number;
  minimumBalanceDate: string;
  hardReserveViolated: boolean;
  forecast: Forecast;
}

/**
 * Computes an immediate discretionary outflow that never takes the forecast
 * below the configured hard reserve. It deliberately evaluates the minimum
 * daily balance, rather than only the balance at the horizon end.
 */
export function calculateSafeToSpend(input: SafeToSpendInput): SafeToSpendResult {
  assertMinorUnits(input.hardReserveMinor, "hardReserveMinor");
  if (input.hardReserveMinor < 0) throw new Error("hardReserveMinor must not be negative");
  const forecast = buildForecast(input.forecastInput);
  const available = forecast.minimumBalanceMinor - input.hardReserveMinor;
  return {
    safeToSpendMinor: Math.max(0, available),
    minimumBalanceMinor: forecast.minimumBalanceMinor,
    minimumBalanceDate: forecast.minimumBalanceDate,
    hardReserveViolated: forecast.minimumBalanceMinor < input.hardReserveMinor,
    forecast,
  };
}

/** Credit headroom for the card an option would be charged to. */
export interface CardConstraint {
  cardId: string;
  /** Human name of the card, used in explanations. Falls back to the id. */
  label?: string;
  creditLimitMinor: number;
  /** Amount of the limit already taken by billed and projected installments. */
  committedMinor: number;
}

/** A goal-backed reserve that a simulation may breach, with a warning. */
export interface SoftReserve {
  id: string;
  name: string;
  amountMinor: number;
}

export interface SoftReserveImpact {
  id: string;
  name: string;
  /** How far below the soft reserve the trough falls, in positive minor units. */
  shortfallMinor: number;
}

export interface PaymentOption {
  id: string;
  label: string;
  totalCostMinor: number;
  /** Cash settlement events only. Card purchase classification stays in the ledger. */
  cashEvents: ForecastEvent[];
  /** Set when the option is charged to a credit card, so the limit can be checked. */
  card?: CardConstraint;
  /** Number of installments; 1 (or omitted) means a single settlement. */
  installments?: number;
}

export type RejectionCode =
  | "HARD_RESERVE_VIOLATED"
  | "NEGATIVE_BALANCE"
  | "CREDIT_LIMIT_EXCEEDED"
  | "DEADLINE_EXCEEDED";

export interface PaymentOptionResult {
  id: string;
  label: string;
  totalCostMinor: number;
  minimumBalanceMinor: number;
  minimumBalanceDate: string;
  hardReserveViolated: boolean;
  safeToSpendAfterMinor: number;
  /** True when the option breaks no hard constraint and may be recommended. */
  feasible: boolean;
  /** Machine-readable hard-constraint breaches, in evaluation order. */
  rejections: RejectionCode[];
  /** Deterministic explanation lines; the LLM may rephrase but never recompute. */
  reasons: string[];
  softReserveImpacts: SoftReserveImpact[];
  /** Positive when the option would exceed the card limit. */
  creditLimitExceededMinor?: number;
  /** Date the option's last cash settlement lands. */
  lastPaymentDate?: string;
  installments: number;
  /** Largest single calendar-month cash outflow the option creates. */
  peakMonthlyOutflowMinor: number;
  forecast: Forecast;
}

export type ComparisonStatus = "OK" | "NO_FEASIBLE_OPTION" | "INSUFFICIENT_DATA";

export interface ComparePaymentOptionsInput extends SafeToSpendInput {
  options: PaymentOption[];
  /** Soft goals: breaching them warns, it never rejects an option. */
  softReserves?: SoftReserve[];
  /** Latest acceptable date for an option's final settlement. */
  maxLastPaymentDate?: DateString;
  /**
   * Floor the projected balance may never cross. Defaults to 0: an option that
   * drives the account negative is not a recommendation.
   */
  minimumAllowedBalanceMinor?: number;
}

export interface PaymentComparison {
  options: PaymentOptionResult[];
  /** Undefined when every option breaks a hard constraint. */
  recommendedOptionId?: string;
  status: ComparisonStatus;
  /** Populated when `status` is not `OK`, explaining what blocked a recommendation. */
  blockers: string[];
}

function monthKey(date: DateString): string {
  return date.slice(0, 7);
}

function summarizeOption(option: PaymentOption): {
  lastPaymentDate?: string;
  peakMonthlyOutflowMinor: number;
} {
  const outflowByMonth = new Map<string, number>();
  let lastPaymentDate: string | undefined;

  for (const event of option.cashEvents) {
    assertValidDate(event.expectedAt, `option ${option.id} cash event.expectedAt`);
    if (!lastPaymentDate || event.expectedAt > lastPaymentDate) lastPaymentDate = event.expectedAt;
    if (event.amountMinor < 0) {
      const key = monthKey(event.expectedAt);
      outflowByMonth.set(key, (outflowByMonth.get(key) ?? 0) + -event.amountMinor);
    }
  }

  return {
    lastPaymentDate,
    peakMonthlyOutflowMinor: Math.max(0, ...outflowByMonth.values()),
  };
}

function evaluateSoftReserves(minimumBalanceMinor: number, softReserves: SoftReserve[]): SoftReserveImpact[] {
  const impacts: SoftReserveImpact[] = [];
  for (const reserve of softReserves) {
    assertMinorUnits(reserve.amountMinor, `softReserve ${reserve.id}.amountMinor`);
    if (minimumBalanceMinor < reserve.amountMinor) {
      impacts.push({
        id: reserve.id,
        name: reserve.name,
        shortfallMinor: reserve.amountMinor - minimumBalanceMinor,
      });
    }
  }
  return impacts;
}

function assertDistinctLogicalKeys(input: ComparePaymentOptionsInput): void {
  const baseLogicalKeys = new Set(input.forecastInput.events.map((event) => event.logicalKey));
  for (const option of input.options) {
    assertMinorUnits(option.totalCostMinor, `option ${option.id}.totalCostMinor`);
    const optionLogicalKeys = new Set<string>();
    for (const event of option.cashEvents) {
      if (baseLogicalKeys.has(event.logicalKey) || optionLogicalKeys.has(event.logicalKey)) {
        throw new Error(`option ${option.id} cash event logicalKey collides with an existing commitment`);
      }
      optionLogicalKeys.add(event.logicalKey);
    }
  }
}

/**
 * Deterministic payment comparator.
 *
 * Hard constraints are applied first and in the PRD's order — balance floor,
 * hard reserve, credit limit, deadline — and only then are feasible options
 * ranked by cost, liquidity, installment concentration, debt duration and soft
 * goal impact. Every option carries the reasons behind its verdict so a
 * recommendation is always explainable without re-deriving any number.
 */
export function comparePaymentOptions(input: ComparePaymentOptionsInput): PaymentComparison {
  assertDistinctLogicalKeys(input);
  const softReserves = input.softReserves ?? [];
  const floorMinor = input.minimumAllowedBalanceMinor ?? 0;
  assertMinorUnits(floorMinor, "minimumAllowedBalanceMinor");
  if (input.maxLastPaymentDate) assertValidDate(input.maxLastPaymentDate, "maxLastPaymentDate");

  const options = input.options.map((option): PaymentOptionResult => {
    const result = calculateSafeToSpend({
      hardReserveMinor: input.hardReserveMinor,
      forecastInput: {
        ...input.forecastInput,
        events: [...input.forecastInput.events, ...option.cashEvents],
      },
    });
    const { lastPaymentDate, peakMonthlyOutflowMinor } = summarizeOption(option);
    const softReserveImpacts = evaluateSoftReserves(result.minimumBalanceMinor, softReserves);

    const rejections: RejectionCode[] = [];
    const reasons: string[] = [];

    if (result.minimumBalanceMinor < floorMinor) {
      rejections.push("NEGATIVE_BALANCE");
      reasons.push(`projected balance falls to ${result.minimumBalanceMinor} on ${result.minimumBalanceDate}, below the ${floorMinor} floor`);
    }
    if (result.hardReserveViolated) {
      rejections.push("HARD_RESERVE_VIOLATED");
      reasons.push(`breaks the hard reserve of ${input.hardReserveMinor} (trough ${result.minimumBalanceMinor} on ${result.minimumBalanceDate})`);
    } else {
      reasons.push(`keeps the hard reserve of ${input.hardReserveMinor} (trough ${result.minimumBalanceMinor} on ${result.minimumBalanceDate})`);
    }

    let creditLimitExceededMinor: number | undefined;
    if (option.card) {
      assertMinorUnits(option.card.creditLimitMinor, `option ${option.id}.card.creditLimitMinor`);
      assertMinorUnits(option.card.committedMinor, `option ${option.id}.card.committedMinor`);
      const cardName = option.card.label ?? option.card.cardId;
      const projectedUtilization = option.card.committedMinor + option.totalCostMinor;
      if (projectedUtilization > option.card.creditLimitMinor) {
        creditLimitExceededMinor = projectedUtilization - option.card.creditLimitMinor;
        rejections.push("CREDIT_LIMIT_EXCEEDED");
        reasons.push(`exceeds the limit of card ${cardName} by ${creditLimitExceededMinor}`);
      } else {
        reasons.push(`fits the limit of card ${cardName} with ${option.card.creditLimitMinor - projectedUtilization} to spare`);
      }
    }

    if (input.maxLastPaymentDate && lastPaymentDate && lastPaymentDate > input.maxLastPaymentDate) {
      rejections.push("DEADLINE_EXCEEDED");
      reasons.push(`last payment on ${lastPaymentDate} lands after the ${input.maxLastPaymentDate} deadline`);
    } else if (lastPaymentDate) {
      reasons.push(`last payment on ${lastPaymentDate}`);
    }

    for (const impact of softReserveImpacts) {
      reasons.push(`reduces the soft goal "${impact.name}" by ${impact.shortfallMinor}`);
    }

    return {
      id: option.id,
      label: option.label,
      totalCostMinor: option.totalCostMinor,
      minimumBalanceMinor: result.minimumBalanceMinor,
      minimumBalanceDate: result.minimumBalanceDate,
      hardReserveViolated: result.hardReserveViolated,
      safeToSpendAfterMinor: result.safeToSpendMinor,
      feasible: rejections.length === 0,
      rejections,
      reasons,
      softReserveImpacts,
      creditLimitExceededMinor,
      lastPaymentDate,
      installments: option.installments ?? 1,
      peakMonthlyOutflowMinor,
      forecast: result.forecast,
    };
  });

  const softShortfall = (option: PaymentOptionResult): number =>
    option.softReserveImpacts.reduce((total, impact) => total + impact.shortfallMinor, 0);

  const viable = [...options]
    .filter((option) => option.feasible)
    .sort(
      (left, right) =>
        left.totalCostMinor - right.totalCostMinor ||
        right.minimumBalanceMinor - left.minimumBalanceMinor ||
        left.peakMonthlyOutflowMinor - right.peakMonthlyOutflowMinor ||
        (left.lastPaymentDate ?? "").localeCompare(right.lastPaymentDate ?? "") ||
        softShortfall(left) - softShortfall(right) ||
        left.id.localeCompare(right.id),
    );

  if (options.length === 0) {
    return { options, status: "INSUFFICIENT_DATA", blockers: ["no payment option was supplied"] };
  }
  if (viable.length === 0) {
    return {
      options,
      status: "NO_FEASIBLE_OPTION",
      blockers: options.map((option) => `${option.label}: ${option.rejections.join(", ")}`),
    };
  }

  return { options, recommendedOptionId: viable[0]!.id, status: "OK", blockers: [] };
}

export interface SimulatePurchaseInput extends SafeToSpendInput {
  option: PaymentOption;
  softReserves?: SoftReserve[];
  minimumAllowedBalanceMinor?: number;
  maxLastPaymentDate?: DateString;
}

export interface PurchaseSimulation {
  optionId: string;
  label: string;
  totalCostMinor: number;
  /** Cash leaving the account on the first settlement date. */
  immediateImpactMinor: number;
  /** Cash outflow the option adds, keyed by `YYYY-MM`. */
  monthlyImpactMinor: Record<string, number>;
  safeToSpendBeforeMinor: number;
  safeToSpendAfterMinor: number;
  minimumBalanceBeforeMinor: number;
  minimumBalanceAfterMinor: number;
  minimumBalanceDateAfter: string;
  hardReserveViolated: boolean;
  softReserveImpacts: SoftReserveImpact[];
  creditLimitExceededMinor?: number;
  /** Card utilization after the purchase, when the option is charged to a card. */
  cardUtilizationAfterMinor?: number;
  lastPaymentDate?: string;
  installments: number;
  feasible: boolean;
  rejections: RejectionCode[];
  reasons: string[];
  forecastAfter: Forecast;
}

/**
 * Answers "what happens to my cash if I buy this?" for a single payment option.
 *
 * Before and after are measured on the same financial snapshot, so the deltas
 * are attributable to the purchase alone rather than to a shifting baseline.
 */
export function simulatePurchase(input: SimulatePurchaseInput): PurchaseSimulation {
  const before = calculateSafeToSpend({
    hardReserveMinor: input.hardReserveMinor,
    forecastInput: input.forecastInput,
  });
  const comparison = comparePaymentOptions({
    forecastInput: input.forecastInput,
    hardReserveMinor: input.hardReserveMinor,
    softReserves: input.softReserves,
    minimumAllowedBalanceMinor: input.minimumAllowedBalanceMinor,
    maxLastPaymentDate: input.maxLastPaymentDate,
    options: [input.option],
  });
  const after = comparison.options[0]!;

  const settlements = [...input.option.cashEvents].sort((left, right) =>
    left.expectedAt.localeCompare(right.expectedAt),
  );
  const monthlyImpactMinor: Record<string, number> = {};
  for (const event of settlements) {
    if (event.amountMinor >= 0) continue;
    const key = monthKey(event.expectedAt);
    monthlyImpactMinor[key] = (monthlyImpactMinor[key] ?? 0) + -event.amountMinor;
  }
  const firstDate = settlements[0]?.expectedAt;
  const immediateImpactMinor = settlements
    .filter((event) => event.expectedAt === firstDate && event.amountMinor < 0)
    .reduce((total, event) => total + -event.amountMinor, 0);

  return {
    optionId: after.id,
    label: after.label,
    totalCostMinor: after.totalCostMinor,
    immediateImpactMinor,
    monthlyImpactMinor,
    safeToSpendBeforeMinor: before.safeToSpendMinor,
    safeToSpendAfterMinor: after.safeToSpendAfterMinor,
    minimumBalanceBeforeMinor: before.minimumBalanceMinor,
    minimumBalanceAfterMinor: after.minimumBalanceMinor,
    minimumBalanceDateAfter: after.minimumBalanceDate,
    hardReserveViolated: after.hardReserveViolated,
    softReserveImpacts: after.softReserveImpacts,
    creditLimitExceededMinor: after.creditLimitExceededMinor,
    cardUtilizationAfterMinor: input.option.card
      ? input.option.card.committedMinor + input.option.totalCostMinor
      : undefined,
    lastPaymentDate: after.lastPaymentDate,
    installments: after.installments,
    feasible: after.feasible,
    rejections: after.rejections,
    reasons: after.reasons,
    forecastAfter: after.forecast,
  };
}

export interface MonthlySettlementInput {
  /** Prefix for each event's `logicalKey`, e.g. `simulation:stroller:5x`. */
  logicalKeyPrefix: string;
  sourceType: string;
  /** Date of the first settlement. */
  firstPaymentDate: DateString;
  installments: number;
  /** Positive magnitude of one installment, in minor units. */
  installmentAmountMinor: number;
  /** When given, the last installment absorbs the rounding remainder. */
  totalCostMinor?: number;
  confidence?: Confidence;
}

/**
 * Builds the cash settlements a payment option would create.
 *
 * Amounts are emitted as negative cash impacts and the final installment
 * absorbs any remainder, so the settlements always sum to `totalCostMinor`
 * exactly — no cent is created or lost by division.
 */
export function monthlySettlementEvents(input: MonthlySettlementInput): ForecastEvent[] {
  assertValidDate(input.firstPaymentDate, "firstPaymentDate");
  assertMinorUnits(input.installmentAmountMinor, "installmentAmountMinor");
  if (!Number.isInteger(input.installments) || input.installments < 1) {
    throw new Error("installments must be a positive integer");
  }
  if (input.installmentAmountMinor < 0) throw new Error("installmentAmountMinor must not be negative");

  const anchorDay = Number(input.firstPaymentDate.slice(8, 10));
  const events: ForecastEvent[] = [];
  for (let index = 0; index < input.installments; index += 1) {
    const expectedAt = index === 0 ? input.firstPaymentDate : addMonthsClampedIso(input.firstPaymentDate, index, anchorDay);
    events.push({
      id: `${input.logicalKeyPrefix}:${index + 1}`,
      logicalKey: `${input.logicalKeyPrefix}:${index + 1}`,
      expectedAt,
      amountMinor: -input.installmentAmountMinor,
      sourceType: input.sourceType,
      confidence: input.confidence ?? "CONFIRMED",
    });
  }

  if (input.totalCostMinor !== undefined) {
    assertMinorUnits(input.totalCostMinor, "totalCostMinor");
    const projected = input.installmentAmountMinor * input.installments;
    const last = events.at(-1)!;
    last.amountMinor -= input.totalCostMinor - projected;
  }

  return events;
}
