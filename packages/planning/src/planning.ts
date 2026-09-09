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

export interface MonthlyOutlookEntry {
  /** `YYYY-MM`. */
  month: string;
  /** Cash this plan takes out during the month. */
  purchaseOutflowMinor: number;
  /** Lowest the balance gets during the month, and the day it happens. */
  minimumBalanceMinor: number;
  minimumBalanceDate: DateString;
  /** Where the balance ends the month. */
  closingBalanceMinor: number;
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
  /**
   * Month by month, what the plan takes out and what the balance does — the
   * shape of the question "can I get through November". Derived from the same
   * forecast the verdict is, so the two can never disagree.
   */
  monthlyOutlook: MonthlyOutlookEntry[];
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

  const outlookByMonth = new Map<string, MonthlyOutlookEntry>();
  for (const day of after.forecast.days) {
    const month = monthKey(day.date);
    const entry = outlookByMonth.get(month);
    if (!entry) {
      outlookByMonth.set(month, {
        month,
        purchaseOutflowMinor: monthlyImpactMinor[month] ?? 0,
        minimumBalanceMinor: day.closingBalanceMinor,
        minimumBalanceDate: day.date,
        closingBalanceMinor: day.closingBalanceMinor,
      });
      continue;
    }
    if (day.closingBalanceMinor < entry.minimumBalanceMinor) {
      entry.minimumBalanceMinor = day.closingBalanceMinor;
      entry.minimumBalanceDate = day.date;
    }
    entry.closingBalanceMinor = day.closingBalanceMinor;
  }

  return {
    monthlyOutlook: [...outlookByMonth.values()],
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

export interface RecommendationCandidateItem {
  itemId: string;
  label: string;
  /** Latest date this item may finish being paid. */
  deadline?: DateString;
  /**
   * Cap on how many installments this item may be split into — a seller that
   * only takes 3x, or none at all (1). Enforced here as well as upstream: the
   * cap is the user's fact about the world, and a recommendation that quietly
   * exceeds it is not a recommendation, it is a wrong answer.
   */
  maxInstallments?: number;
  /**
   * Every way this item could be paid, generated upstream where the real card
   * cycles live. The engine picks among them; it does not invent them.
   */
  candidates: PaymentOption[];
}

export interface RecommendPurchasePlanInput {
  forecastInput: BuildForecastInput;
  hardReserveMinor: number;
  softReserves?: SoftReserve[];
  minimumAllowedBalanceMinor?: number;
  /** The plan's target date; an item without its own deadline inherits it. */
  targetDate?: DateString;
  items: RecommendationCandidateItem[];
}

export interface RecommendedChoice {
  itemId: string;
  label: string;
  optionId: string;
  optionLabel: string;
  totalCostMinor: number;
  installments: number;
  /** What each instalment costs. Equal to the total for a single payment. */
  installmentAmountMinor: number;
  firstPaymentDate?: DateString;
  lastPaymentDate?: DateString;
  /** The card it is charged to, when it is charged to one. */
  cardId?: string;
  cardLabel?: string;
  /** Balance trough once this item is paid for this way. */
  minimumBalanceMinor: number;
  minimumBalanceDate: DateString;
  /** How many ways of paying it were workable at all, this one included. */
  workableCount: number;
  /**
   * Why this way was picked, in minor units. Written for the agent, MCP and
   * the audit trail — a screen should render the structured fields above
   * through its own formatter instead of printing these.
   */
  reasons: string[];
}

export interface BlockedItem {
  itemId: string;
  label: string;
  maxInstallments?: number;
  limitDate?: DateString;
  /** How many of its candidates failed for each reason. */
  cappedCount: number;
  lateCount: number;
  overCardCount: number;
  belowFloorCount: number;
  /** Best trough among the candidates that only failed on the balance floor. */
  bestFloorBreachMinor?: number;
  bestFloorBreachDate?: DateString;
}

export interface PurchasePlanRecommendation {
  status: "OK" | "NO_FEASIBLE_PLAN" | "INSUFFICIENT_DATA";
  choices: RecommendedChoice[];
  /**
   * Set when the forecast is under water before any purchase. The list is not
   * what broke; nothing could have been recommended against it.
   */
  baselineBreach?: { minimumBalanceMinor: number; minimumBalanceDate: DateString };
  /** One entry per item no candidate worked for, as data rather than prose. */
  blockedItems: BlockedItem[];
  /** The basket verdict for the chosen set. Absent when nothing was chosen. */
  simulation?: PurchasePlanSimulation;
  /** How far the best attempt still falls short of the reserve, and when. */
  shortfallMinor?: number;
  shortfallDate?: DateString;
  blockers: string[];
}

interface CandidateVerdict {
  option: PaymentOption;
  /** Trough of the whole basket if this candidate is added to what is chosen. */
  minimumBalanceMinor: number;
  minimumBalanceDate: DateString;
  breaksDeadline: boolean;
  breaksCard: boolean;
  breaksFloor: boolean;
  breaksInstallmentCap: boolean;
  acceptable: boolean;
}

/**
 * Recommends how to pay for a whole list.
 *
 * The objective is to preserve cash: among the ways that break nothing, it
 * takes the one that leaves the balance's low point highest, even when that
 * costs more in total. Ties go to the cheaper option, then to fewer
 * installments, then to the option id, so the same inputs always produce the
 * same recommendation.
 *
 * This is a greedy pass in deadline order, not a proven optimum — it commits
 * to each item before seeing the next. That is the honest trade for an answer
 * that can explain itself item by item, which per R6 matters more here than
 * squeezing out the last cruzeiro. When it reports that a list does not fit,
 * that verdict is sound: the failure is that no candidate for some item keeps
 * the basket whole, and the shortfall is measured against the best attempt.
 *
 * It never defers or drops an item to make a list fit. Deciding that a bin
 * matters less than a floor is the user's call, not the engine's.
 */
export function recommendPurchasePlan(input: RecommendPurchasePlanInput): PurchasePlanRecommendation {
  const floorMinor = input.minimumAllowedBalanceMinor ?? 0;
  assertMinorUnits(floorMinor, "minimumAllowedBalanceMinor");
  if (input.targetDate) assertValidDate(input.targetDate, "targetDate");

  const withCandidates = input.items.filter((item) => item.candidates.length > 0);
  if (withCandidates.length === 0) {
    return {
      status: "INSUFFICIENT_DATA",
      choices: [],
      blockedItems: [],
      blockers: ["no item has a way of being paid to choose from"],
    };
  }

  // Earliest deadline first: the most constrained item picks while the most
  // room is still available. Then the most expensive, because a card's limit
  // is scarce and shared — deciding a whole list in id order let a 400 item
  // take installments that a 2400 item then could not, and the big one paid
  // cash. Id last, so the order never depends on how the rows arrived.
  const cheapestCandidateMinor = (item: RecommendationCandidateItem) =>
    Math.min(...item.candidates.map((candidate) => candidate.totalCostMinor));
  const ordered = [...withCandidates].sort((left, right) => {
    const leftBy = left.deadline ?? input.targetDate ?? "9999-12-31";
    const rightBy = right.deadline ?? input.targetDate ?? "9999-12-31";
    return (
      leftBy.localeCompare(rightBy) ||
      cheapestCandidateMinor(right) - cheapestCandidateMinor(left) ||
      left.itemId.localeCompare(right.itemId)
    );
  });

  // Measured before anything is bought. An item can only be blamed for a
  // breach it causes: when the forecast is already under water, every
  // candidate reports the same trough, and saying "this item leaves you at
  // -643" nine times names the wrong culprit for a hole that was already
  // there.
  const baseline = calculateSafeToSpend({
    hardReserveMinor: input.hardReserveMinor,
    forecastInput: input.forecastInput,
  });
  const alreadyShort =
    baseline.minimumBalanceMinor < floorMinor || baseline.hardReserveViolated;
  const baselineBreach = alreadyShort
    ? {
        minimumBalanceMinor: baseline.minimumBalanceMinor,
        minimumBalanceDate: baseline.minimumBalanceDate,
      }
    : undefined;
  // Refusing to answer at all was the wrong call. Someone whose October is
  // already short still needs to know what their list would cost and when —
  // they just must not be told a purchase is fine when it deepens the hole.
  // So the bar becomes "do not make it worse": no candidate may push the
  // trough below where it already sits. The breach is reported either way.
  const effectiveFloorMinor = alreadyShort ? baseline.minimumBalanceMinor : floorMinor;

  const chosenEvents: ForecastEvent[] = [];
  const cardChargedMinor = new Map<string, number>();
  const choices: RecommendedChoice[] = [];
  const blockedItems: BlockedItem[] = [];
  const blockers: string[] = [];
  let bestEffortTrough: { minimumBalanceMinor: number; minimumBalanceDate: DateString } | undefined;
  let failed = false;

  for (const item of ordered) {
    const limitDate = item.deadline ?? input.targetDate;

    const verdicts = item.candidates.map((option): CandidateVerdict => {
      const { lastPaymentDate } = summarizeOption(option);
      const result = calculateSafeToSpend({
        hardReserveMinor: input.hardReserveMinor,
        forecastInput: {
          ...input.forecastInput,
          events: [...input.forecastInput.events, ...chosenEvents, ...option.cashEvents],
        },
      });

      const breaksDeadline = Boolean(limitDate && lastPaymentDate && lastPaymentDate > limitDate);
      const card = option.card;
      const breaksCard = card
        ? card.committedMinor + (cardChargedMinor.get(card.cardId) ?? 0) + option.totalCostMinor >
          card.creditLimitMinor
        : false;
      const breaksFloor =
        result.minimumBalanceMinor < effectiveFloorMinor ||
        (!alreadyShort && result.hardReserveViolated);
      const breaksInstallmentCap =
        item.maxInstallments !== undefined && (option.installments ?? 1) > item.maxInstallments;

      return {
        option,
        minimumBalanceMinor: result.minimumBalanceMinor,
        minimumBalanceDate: result.minimumBalanceDate,
        breaksDeadline,
        breaksCard,
        breaksFloor,
        breaksInstallmentCap,
        acceptable: !breaksDeadline && !breaksCard && !breaksFloor && !breaksInstallmentCap,
      };
    });

    // Preserve cash: highest trough wins, then cheaper, then fewer
    // installments, then id. Every comparison is total and deterministic.
    const byPreference = (left: CandidateVerdict, right: CandidateVerdict) =>
      right.minimumBalanceMinor - left.minimumBalanceMinor ||
      left.option.totalCostMinor - right.option.totalCostMinor ||
      (left.option.installments ?? 1) - (right.option.installments ?? 1) ||
      left.option.id.localeCompare(right.option.id);

    const acceptable = verdicts.filter((verdict) => verdict.acceptable).sort(byPreference);
    const picked = acceptable[0];

    if (!picked) {
      failed = true;
      const nearest = [...verdicts].sort(byPreference)[0]!;
      if (!bestEffortTrough || nearest.minimumBalanceMinor < bestEffortTrough.minimumBalanceMinor) {
        bestEffortTrough = {
          minimumBalanceMinor: nearest.minimumBalanceMinor,
          minimumBalanceDate: nearest.minimumBalanceDate,
        };
      }
      // Every candidate's reason, not the top-ranked one's. The best-trough
      // candidate is usually the longest instalment plan, so reporting only
      // its failure blamed a deadline for items whose real wall was an
      // exhausted card or the balance floor.
      const capped = verdicts.filter((verdict) => verdict.breaksInstallmentCap).length;
      const late = verdicts.filter(
        (verdict) => !verdict.breaksInstallmentCap && verdict.breaksDeadline,
      ).length;
      const overCard = verdicts.filter(
        (verdict) => !verdict.breaksInstallmentCap && !verdict.breaksDeadline && verdict.breaksCard,
      ).length;
      const floorBreakers = verdicts
        .filter(
          (verdict) =>
            !verdict.breaksInstallmentCap &&
            !verdict.breaksDeadline &&
            !verdict.breaksCard &&
            verdict.breaksFloor,
        )
        // Best of a bad set: quoting any other candidate's trough would put a
        // number in the sentence that no rejected option actually produces.
        .sort((left, right) => right.minimumBalanceMinor - left.minimumBalanceMinor);
      const belowFloor = floorBreakers.length;
      const parts: string[] = [];
      if (capped > 0) parts.push(`${capped} exceed the ${item.maxInstallments}x it allows`);
      if (late > 0) parts.push(`${late} finish after ${limitDate}`);
      if (overCard > 0) parts.push(`${overCard} go over a card's remaining limit`);
      if (belowFloor > 0) {
        const best = floorBreakers[0]!;
        parts.push(
          `${belowFloor} would drop the balance to ${best.minimumBalanceMinor} on ${best.minimumBalanceDate}`,
        );
      }
      const why = `no way of paying it works — ${parts.join(", ")}`;
      blockers.push(`${item.label}: ${why}`);
      blockedItems.push({
        itemId: item.itemId,
        label: item.label,
        maxInstallments: item.maxInstallments,
        limitDate,
        cappedCount: capped,
        lateCount: late,
        overCardCount: overCard,
        belowFloorCount: belowFloor,
        bestFloorBreachMinor: floorBreakers[0]?.minimumBalanceMinor,
        bestFloorBreachDate: floorBreakers[0]?.minimumBalanceDate,
      });
      // Keep going: the remaining items still say something about the gap.
      continue;
    }

    chosenEvents.push(...picked.option.cashEvents);
    if (picked.option.card) {
      const card = picked.option.card;
      cardChargedMinor.set(
        card.cardId,
        (cardChargedMinor.get(card.cardId) ?? 0) + picked.option.totalCostMinor,
      );
    }

    const runnersUp = acceptable.length - 1;
    const { lastPaymentDate } = summarizeOption(picked.option);
    const settlements = [...picked.option.cashEvents].sort((left, right) =>
      left.expectedAt.localeCompare(right.expectedAt),
    );
    choices.push({
      itemId: item.itemId,
      label: item.label,
      optionId: picked.option.id,
      optionLabel: picked.option.label,
      totalCostMinor: picked.option.totalCostMinor,
      installments: picked.option.installments ?? 1,
      installmentAmountMinor: Math.abs(settlements[0]?.amountMinor ?? picked.option.totalCostMinor),
      firstPaymentDate: settlements[0]?.expectedAt,
      lastPaymentDate,
      cardId: picked.option.card?.cardId,
      cardLabel: picked.option.card?.label,
      minimumBalanceMinor: picked.minimumBalanceMinor,
      minimumBalanceDate: picked.minimumBalanceDate,
      workableCount: acceptable.length,
      reasons: [
        `leaves the balance at ${picked.minimumBalanceMinor} on ${picked.minimumBalanceDate}, the highest of ${acceptable.length} workable ${acceptable.length === 1 ? "way" : "ways"} to pay it`,
        ...(runnersUp > 0 ? [`${runnersUp} other option${runnersUp === 1 ? "" : "s"} also fit but left less cash`] : []),
        ...(limitDate && lastPaymentDate ? [`paid off by ${lastPaymentDate}, within ${limitDate}`] : []),
      ],
    });
  }

  if (failed || choices.length !== ordered.length) {
    const reserveGap =
      bestEffortTrough && bestEffortTrough.minimumBalanceMinor < input.hardReserveMinor
        ? input.hardReserveMinor - bestEffortTrough.minimumBalanceMinor
        : undefined;
    return {
      status: "NO_FEASIBLE_PLAN",
      choices,
      blockedItems,
      baselineBreach,
      shortfallMinor: reserveGap,
      shortfallDate: reserveGap !== undefined ? bestEffortTrough?.minimumBalanceDate : undefined,
      blockers,
    };
  }

  const chosenById = new Map(choices.map((choice) => [choice.itemId, choice.optionId]));
  const simulation = simulatePurchasePlan({
    forecastInput: input.forecastInput,
    hardReserveMinor: input.hardReserveMinor,
    softReserves: input.softReserves,
    minimumAllowedBalanceMinor: input.minimumAllowedBalanceMinor,
    targetDate: input.targetDate,
    items: ordered.map((item) => ({
      itemId: item.itemId,
      label: item.label,
      deadline: item.deadline,
      option: item.candidates.find((candidate) => candidate.id === chosenById.get(item.itemId))!,
    })),
  });

  return { status: "OK", choices, simulation, baselineBreach, blockedItems: [], blockers: [] };
}
