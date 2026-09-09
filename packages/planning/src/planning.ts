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

export interface PlanItemOption {
  itemId: string;
  /** Human name of the item, used in explanations. */
  label: string;
  /** The one way this item is being paid. Alternatives belong to comparePaymentOptions. */
  option: PaymentOption;
  /** Latest date this item may finish being paid. */
  deadline?: DateString;
}

export interface PlanItemContribution {
  itemId: string;
  label: string;
  totalCostMinor: number;
  installments: number;
  lastPaymentDate?: DateString;
  /** Only this item's own failures — a deadline it cannot meet. */
  rejections: RejectionCode[];
  reasons: string[];
}

export interface CardLoad {
  cardId: string;
  label: string;
  creditLimitMinor: number;
  /** Already taken by billed and projected installments before this plan. */
  committedMinor: number;
  /** Added by every item in this plan charged to this card. */
  planChargedMinor: number;
  /** How far past the limit the plan pushes this card; 0 when it fits. */
  exceededMinor: number;
}

export interface SimulatePurchasePlanInput {
  forecastInput: BuildForecastInput;
  hardReserveMinor: number;
  softReserves?: SoftReserve[];
  minimumAllowedBalanceMinor?: number;
  /** The plan's own target date; every item must be paid off by it. */
  targetDate?: DateString;
  items: PlanItemOption[];
}

export interface PurchasePlanSimulation {
  totalCostMinor: number;
  items: PlanItemContribution[];
  safeToSpendBeforeMinor: number;
  safeToSpendAfterMinor: number;
  minimumBalanceBeforeMinor: number;
  minimumBalanceBeforeDate: DateString;
  minimumBalanceAfterMinor: number;
  minimumBalanceAfterDate: DateString;
  hardReserveViolated: boolean;
  softReserveImpacts: SoftReserveImpact[];
  /** One entry per card the plan charges, with every item's share summed. */
  cards: CardLoad[];
  /** Cash the whole plan adds, keyed by `YYYY-MM`. */
  monthlyImpactMinor: Record<string, number>;
  lastPaymentDate?: DateString;
  feasible: boolean;
  rejections: RejectionCode[];
  reasons: string[];
  forecastAfter: Forecast;
}

/**
 * Answers "can I buy all of this?" — the question a purchase plan exists for.
 *
 * Not the same as simulating each item and reading the results side by side.
 * Two items on one card share that card's limit, and every item competes for
 * the same cash on the same days, so the constraints only bind correctly when
 * the whole basket lands on one forecast. Running them separately would clear
 * a plan that the sum of its parts cannot afford.
 *
 * Each item arrives with the single option it is actually being paid by;
 * choosing between alternatives is `comparePaymentOptions`' job, upstream.
 */
export function simulatePurchasePlan(input: SimulatePurchasePlanInput): PurchasePlanSimulation {
  const softReserves = input.softReserves ?? [];
  const floorMinor = input.minimumAllowedBalanceMinor ?? 0;
  assertMinorUnits(floorMinor, "minimumAllowedBalanceMinor");
  if (input.targetDate) assertValidDate(input.targetDate, "targetDate");

  const planEvents = input.items.flatMap((item) => item.option.cashEvents);

  // assertDistinctLogicalKeys checks each option against the ledger and against
  // itself, which is enough when options are alternatives. Here they are
  // simultaneous, so two items can collide with each other — and a collision
  // silently drops one item's settlement, quietly making the plan affordable.
  const seenKeys = new Set(input.forecastInput.events.map((event) => event.logicalKey));
  for (const item of input.items) {
    assertMinorUnits(item.option.totalCostMinor, `item ${item.itemId}.totalCostMinor`);
    for (const event of item.option.cashEvents) {
      if (seenKeys.has(event.logicalKey)) {
        throw new Error(
          `item ${item.itemId} cash event logicalKey "${event.logicalKey}" collides with another commitment in this plan`,
        );
      }
      seenKeys.add(event.logicalKey);
    }
  }

  const before = calculateSafeToSpend({
    hardReserveMinor: input.hardReserveMinor,
    forecastInput: input.forecastInput,
  });
  const after = calculateSafeToSpend({
    hardReserveMinor: input.hardReserveMinor,
    forecastInput: { ...input.forecastInput, events: [...input.forecastInput.events, ...planEvents] },
  });

  const rejections: RejectionCode[] = [];
  const reasons: string[] = [];

  if (after.minimumBalanceMinor < floorMinor) {
    rejections.push("NEGATIVE_BALANCE");
    reasons.push(
      `projected balance falls to ${after.minimumBalanceMinor} on ${after.minimumBalanceDate}, below the ${floorMinor} floor`,
    );
  }
  if (after.hardReserveViolated) {
    rejections.push("HARD_RESERVE_VIOLATED");
    reasons.push(
      `breaks hard reserve of ${input.hardReserveMinor} (trough ${after.minimumBalanceMinor} on ${after.minimumBalanceDate})`,
    );
  } else {
    reasons.push(
      `keeps hard reserve ${input.hardReserveMinor} (trough ${after.minimumBalanceMinor} on ${after.minimumBalanceDate})`,
    );
  }

  // Card limits are shared, so they are summed across the plan rather than
  // checked per item. Two 60%-of-limit purchases both pass alone and fail here.
  const cardById = new Map<string, CardLoad>();
  for (const item of input.items) {
    const card = item.option.card;
    if (!card) continue;
    const load = cardById.get(card.cardId) ?? {
      cardId: card.cardId,
      label: card.label ?? card.cardId,
      creditLimitMinor: card.creditLimitMinor,
      committedMinor: card.committedMinor,
      planChargedMinor: 0,
      exceededMinor: 0,
    };
    load.planChargedMinor += item.option.totalCostMinor;
    cardById.set(card.cardId, load);
  }
  const cards = [...cardById.values()].map((load) => ({
    ...load,
    exceededMinor: Math.max(0, load.committedMinor + load.planChargedMinor - load.creditLimitMinor),
  }));
  for (const load of cards) {
    if (load.exceededMinor > 0) {
      rejections.push("CREDIT_LIMIT_EXCEEDED");
      reasons.push(`${load.label} goes ${load.exceededMinor} over its limit once every item on it is charged`);
    }
  }

  const items = input.items.map((item): PlanItemContribution => {
    const { lastPaymentDate } = summarizeOption(item.option);
    const itemRejections: RejectionCode[] = [];
    const itemReasons: string[] = [];
    const limit = item.deadline ?? input.targetDate;
    if (limit && lastPaymentDate && lastPaymentDate > limit) {
      itemRejections.push("DEADLINE_EXCEEDED");
      itemReasons.push(`last payment on ${lastPaymentDate} falls after ${limit}`);
    }
    return {
      itemId: item.itemId,
      label: item.label,
      totalCostMinor: item.option.totalCostMinor,
      installments: item.option.installments ?? 1,
      lastPaymentDate,
      rejections: itemRejections,
      reasons: itemReasons,
    };
  });

  for (const item of items) {
    if (item.rejections.includes("DEADLINE_EXCEEDED")) {
      if (!rejections.includes("DEADLINE_EXCEEDED")) rejections.push("DEADLINE_EXCEEDED");
      reasons.push(`${item.label}: ${item.reasons[0]}`);
    }
  }

  const monthlyImpactMinor: Record<string, number> = {};
  for (const event of planEvents) {
    if (event.amountMinor >= 0) continue;
    const key = monthKey(event.expectedAt);
    monthlyImpactMinor[key] = (monthlyImpactMinor[key] ?? 0) + -event.amountMinor;
  }

  const settlementDates = planEvents.map((event) => event.expectedAt).sort();

  return {
    totalCostMinor: input.items.reduce((total, item) => total + item.option.totalCostMinor, 0),
    items,
    safeToSpendBeforeMinor: before.safeToSpendMinor,
    safeToSpendAfterMinor: after.safeToSpendMinor,
    minimumBalanceBeforeMinor: before.minimumBalanceMinor,
    minimumBalanceBeforeDate: before.minimumBalanceDate,
    minimumBalanceAfterMinor: after.minimumBalanceMinor,
    minimumBalanceAfterDate: after.minimumBalanceDate,
    hardReserveViolated: after.hardReserveViolated,
    softReserveImpacts: evaluateSoftReserves(after.minimumBalanceMinor, softReserves),
    cards,
    monthlyImpactMinor,
    lastPaymentDate: settlementDates.at(-1),
    feasible: rejections.length === 0,
    rejections,
    reasons,
    forecastAfter: after.forecast,
  };
}
