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
import { peakCardUsage, type CardActivity, type CardCharge } from "./card-usage";

export interface SafeToSpendInput {
  forecastInput: BuildForecastInput;
  hardReserveMinor: number;
}

export interface SafeToSpendResult {
  safeToSpendMinor: number;
  /**
   * `minimumBalanceMinor - hardReserveMinor`, unclamped.
   *
   * `safeToSpendMinor` answers "how much may I spend", so it floors at zero —
   * you cannot spend a negative amount. That floor also erases the only number
   * that matters once the trough is already under the reserve: how far under.
   * Two plans that both report zero safe-to-spend are not the same plan, and
   * this is what tells them apart.
   */
  surplusMinor: number;
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
    surplusMinor: available,
    minimumBalanceMinor: forecast.minimumBalanceMinor,
    minimumBalanceDate: forecast.minimumBalanceDate,
    hardReserveViolated: forecast.minimumBalanceMinor < input.hardReserveMinor,
    forecast,
  };
}

export interface SpendingRoomInput {
  forecastInput: BuildForecastInput;
  hardReserveMinor: number;
  /**
   * The day the money actually leaves the account. Today for cash; for a card
   * purchase, the due date of the statement the charge lands on — which is what
   * makes this answer larger than the cash one, and later.
   */
  settlementDate: DateString;
}

export interface SpendingRoomResult {
  /**
   * How much may be spent today, settling on `settlementDate`, and still land on
   * the floor. Negative means the forecast is already that far below it.
   */
  spendingRoomMinor: number;
  settlementDate: DateString;
  /** The level the trough must not fall below. See the note on the floor. */
  floorMinor: number;
  /** The forecast's trough as it stands, before spending anything. */
  troughMinor: number;
  troughDate: DateString;
  /** The trough from the settlement date onward — the part a spend eats into. */
  troughAfterSettlementMinor: number;
  troughAfterSettlementDate: DateString;
  /** True when the forecast is already under the hard reserve without spending. */
  hardReserveViolated: boolean;
  forecast: Forecast;
}

/**
 * How much can be spent today without deepening the forecast's low point.
 *
 * `calculateSafeToSpend` answers the cash question: money gone today, so every
 * day of the horizon is exposed to it. A card purchase is a different question —
 * the cash leaves on the statement's due date, so the days before it are
 * untouched and only the trough from that date onward constrains the amount.
 * That is why a card can absorb a purchase that cash cannot.
 *
 * The result is deliberately allowed to go negative, and that is the whole
 * reason it is not `calculateSafeToSpend`. A negative room is not "nothing to
 * spend" — it is a number with its own meaning: the forecast lands that far
 * below the floor next month before anything new is bought. Flooring it at zero
 * would erase the only figure that says how much trouble is already booked.
 */
export function calculateSpendingRoom(input: SpendingRoomInput): SpendingRoomResult {
  assertMinorUnits(input.hardReserveMinor, "hardReserveMinor");
  if (input.hardReserveMinor < 0) throw new Error("hardReserveMinor must not be negative");
  assertValidDate(input.settlementDate, "settlementDate");

  const forecast = buildForecast(input.forecastInput);
  const days = forecast.days;

  let troughAfter = Number.POSITIVE_INFINITY;
  let troughAfterDate = input.settlementDate;
  for (const day of days) {
    if (day.date < input.settlementDate) continue;
    if (day.closingBalanceMinor < troughAfter) {
      troughAfter = day.closingBalanceMinor;
      troughAfterDate = day.date;
    }
  }
  // A settlement past the horizon is not constrained by anything we modelled,
  // and claiming unlimited room would be a lie by omission. The horizon's own
  // trough is the honest bound.
  if (troughAfter === Number.POSITIVE_INFINITY) {
    troughAfter = forecast.minimumBalanceMinor;
    troughAfterDate = forecast.minimumBalanceDate;
  }

  // The floor is the reserve, which is zero when none is configured. "How much
  // can I spend and still reach zero" is the question; holding some other floor
  // would answer a different one.
  const floorMinor = input.hardReserveMinor;

  return {
    spendingRoomMinor: troughAfter - floorMinor,
    settlementDate: input.settlementDate,
    floorMinor,
    troughMinor: forecast.minimumBalanceMinor,
    troughDate: forecast.minimumBalanceDate,
    troughAfterSettlementMinor: troughAfter,
    troughAfterSettlementDate: troughAfterDate,
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

/** A card's limit at its busiest over the horizon, without and with what is being simulated. */
export interface CardUsageSummary {
  cardId: string;
  creditLimitMinor: number;
  /** Limit taken today. */
  committedMinor: number;
  baselinePeakMinor: number;
  baselinePeakDate: DateString;
  peakMinor: number;
  peakDate: DateString;
  /** How far past the limit the peak goes; 0 when it fits. */
  exceededMinor: number;
}

/**
 * What an option charges to its card: every instalment is taken from the limit
 * on the purchase day and freed on the date it is paid.
 */
function cardChargesFor(option: PaymentOption, chargedAt: DateString): CardCharge[] {
  const card = option.card;
  if (!card) return [];
  return option.cashEvents
    .filter((event) => event.amountMinor < 0)
    .map((event) => ({
      cardId: card.cardId,
      chargedAt,
      settlesAt: event.expectedAt,
      amountMinor: -event.amountMinor,
    }));
}

/**
 * Peak usage of one card with and without `added`, over the forecast's
 * horizon. `activity` is what the forecast already expects on the cards.
 */
function cardUsageWith(
  card: CardConstraint,
  activity: CardActivity | undefined,
  added: CardCharge[],
  forecastInput: BuildForecastInput,
): CardUsageSummary {
  assertMinorUnits(card.creditLimitMinor, `card ${card.cardId}.creditLimitMinor`);
  assertMinorUnits(card.committedMinor, `card ${card.cardId}.committedMinor`);
  const usage = {
    asOf: forecastInput.asOf,
    horizonEnd: forecastInput.horizonEnd,
    committedMinor: card.committedMinor,
    debtPayments: (activity?.debtPayments ?? []).filter((payment) => payment.cardId === card.cardId),
  };
  const expected = (activity?.charges ?? []).filter((charge) => charge.cardId === card.cardId);
  const baseline = peakCardUsage({ ...usage, charges: expected });
  const withAdded = peakCardUsage({ ...usage, charges: [...expected, ...added] });
  return {
    cardId: card.cardId,
    creditLimitMinor: card.creditLimitMinor,
    committedMinor: card.committedMinor,
    baselinePeakMinor: baseline.peakMinor,
    baselinePeakDate: baseline.peakDate,
    peakMinor: withAdded.peakMinor,
    peakDate: withAdded.peakDate,
    exceededMinor: Math.max(0, withAdded.peakMinor - card.creditLimitMinor),
  };
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
  /**
   * When the purchase is made, which is when a card charge takes up the limit.
   * Defaults to the forecast's `asOf`.
   */
  purchaseDate?: DateString;
}

export type RejectionCode =
  | "HARD_RESERVE_VIOLATED"
  | "NEGATIVE_BALANCE"
  | "CREDIT_LIMIT_EXCEEDED"
  | "DEADLINE_EXCEEDED";

/**
 * The forecast already below the floor or the hard reserve before anything is
 * bought. Reported whenever it happens, because every verdict measured against
 * it reads differently: the bar is no longer "stay above the floor" but "do
 * not lower the trough".
 */
export interface BaselineBreach {
  minimumBalanceMinor: number;
  minimumBalanceDate: DateString;
  floorMinor: number;
  hardReserveMinor: number;
}

interface Trough {
  minimumBalanceMinor: number;
  minimumBalanceDate: DateString;
}

/** Set when `before` already sits under the floor, or under a hard reserve above zero. */
function baselineBreachOf(before: Trough, floorMinor: number, hardReserveMinor: number): BaselineBreach | undefined {
  const short =
    before.minimumBalanceMinor < floorMinor ||
    (hardReserveMinor > 0 && before.minimumBalanceMinor < hardReserveMinor);
  return short
    ? {
        minimumBalanceMinor: before.minimumBalanceMinor,
        minimumBalanceDate: before.minimumBalanceDate,
        floorMinor,
        hardReserveMinor,
      }
    : undefined;
}

/**
 * The balance constraints of PRD §22, judged the same way by every entry point —
 * the comparator, a single simulation, a plan and the recommender.
 *
 * With a healthy baseline: NEGATIVE_BALANCE when the trough after falls below
 * the floor, HARD_RESERVE_VIOLATED when it falls below the hard reserve. A hard
 * reserve of zero is the floor itself, so it is never reported a second time.
 *
 * With the baseline already short, rejecting everything would answer nothing:
 * a purchase whose settlements all land after the low point would be refused
 * for a hole that was already there. So the bar becomes "do not lower the
 * trough". A purchase that leaves it where it was passes; one that lowers it
 * is rejected with whichever level it is under.
 */
function balanceVerdict(
  before: Trough,
  after: Trough,
  floorMinor: number,
  hardReserveMinor: number,
): { rejections: RejectionCode[]; reasons: string[] } {
  const rejections: RejectionCode[] = [];
  const reasons: string[] = [];
  const trough = `trough ${after.minimumBalanceMinor} on ${after.minimumBalanceDate}`;
  const breach = baselineBreachOf(before, floorMinor, hardReserveMinor);

  if (breach) {
    const level =
      before.minimumBalanceMinor < floorMinor
        ? `the ${floorMinor} floor`
        : `the hard reserve of ${hardReserveMinor}`;
    reasons.push(
      `the forecast already falls to ${before.minimumBalanceMinor} on ${before.minimumBalanceDate} before this purchase, below ${level}, so the bar is not lowering that trough`,
    );
    if (after.minimumBalanceMinor < before.minimumBalanceMinor) {
      if (after.minimumBalanceMinor < floorMinor) rejections.push("NEGATIVE_BALANCE");
      if (hardReserveMinor > 0 && after.minimumBalanceMinor < hardReserveMinor) {
        rejections.push("HARD_RESERVE_VIOLATED");
      }
      reasons.push(
        `lowers the trough from ${before.minimumBalanceMinor} to ${after.minimumBalanceMinor} on ${after.minimumBalanceDate}`,
      );
    } else {
      reasons.push(`does not lower the trough (${trough})`);
    }
    return { rejections, reasons };
  }

  if (after.minimumBalanceMinor < floorMinor) {
    rejections.push("NEGATIVE_BALANCE");
    reasons.push(
      `projected balance falls to ${after.minimumBalanceMinor} on ${after.minimumBalanceDate}, below the ${floorMinor} floor`,
    );
  }
  if (hardReserveMinor > 0) {
    if (after.minimumBalanceMinor < hardReserveMinor) {
      rejections.push("HARD_RESERVE_VIOLATED");
      reasons.push(`breaks the hard reserve of ${hardReserveMinor} (${trough})`);
    } else {
      reasons.push(`keeps the hard reserve of ${hardReserveMinor} (${trough})`);
    }
  } else if (rejections.length === 0) {
    reasons.push(`stays at or above the ${floorMinor} floor (${trough})`);
  }
  return { rejections, reasons };
}

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
  /** How much of the card's limit the option leaves in use at its busiest, when charged to a card. */
  cardUsage?: CardUsageSummary;
  /**
   * `creditLimitMinor − cardUsage.peakMinor`: the limit still free on the card's
   * busiest day with this option. Undefined for an option on no card, which
   * takes none of any limit and so ranks as having the most headroom.
   */
  cardHeadroomAtPeakMinor?: number;
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
  /** Statement payments and expected charges on the cards; see `CardActivity`. */
  cardActivity?: CardActivity;
}

/** The criteria options are ranked by, in the order they are applied. */
export type ComparisonCriterion =
  | "feasibility"
  | "rejectionCount"
  | "totalCostMinor"
  | "minimumBalanceMinor"
  | "peakMonthlyOutflowMinor"
  | "lastPaymentDate"
  | "softReserveShortfallMinor"
  | "cardHeadroomAtPeakMinor"
  | "id";

export interface RankedOption {
  /** 1 is best. */
  rank: number;
  optionId: string;
  label: string;
  feasible: boolean;
  rejections: RejectionCode[];
  /** The option ranked immediately above this one; null for the first. */
  comparedWithOptionId: string | null;
  /** The first criterion on which this option lost to that one; null for the first. */
  decidedBy: ComparisonCriterion | null;
  /** That comparison in words, with both raw values. */
  explanation: string;
}

export interface PaymentComparison {
  options: PaymentOptionResult[];
  /** Undefined when every option breaks a hard constraint. */
  recommendedOptionId?: string;
  /**
   * Every option, best first: feasible ones by the comparator's criteria, then
   * the infeasible ones by fewest rejections and the same criteria. Present
   * whatever the status, so the least-bad option is always visible.
   */
  ranking: RankedOption[];
  /** Set when nothing is feasible: the top of `ranking`. Never a recommendation. */
  leastBadOptionId?: string;
  /** Set when the forecast is already short before buying; see `BaselineBreach`. */
  baselineBreach?: BaselineBreach;
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

  const baseline = calculateSafeToSpend({
    hardReserveMinor: input.hardReserveMinor,
    forecastInput: input.forecastInput,
  });
  const baselineBreach = baselineBreachOf(baseline, floorMinor, input.hardReserveMinor);

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

    const { rejections, reasons } = balanceVerdict(baseline, result, floorMinor, input.hardReserveMinor);

    let creditLimitExceededMinor: number | undefined;
    let cardUsage: CardUsageSummary | undefined;
    if (option.card) {
      const cardName = option.card.label ?? option.card.cardId;
      cardUsage = cardUsageWith(
        option.card,
        input.cardActivity,
        cardChargesFor(option, option.purchaseDate ?? input.forecastInput.asOf),
        input.forecastInput,
      );
      if (cardUsage.exceededMinor > 0) {
        creditLimitExceededMinor = cardUsage.exceededMinor;
        rejections.push("CREDIT_LIMIT_EXCEEDED");
        reasons.push(
          `card ${cardName} reaches ${cardUsage.peakMinor} of its ${cardUsage.creditLimitMinor} limit on ${cardUsage.peakDate}, ${creditLimitExceededMinor} over`,
        );
      } else {
        reasons.push(
          `fits the limit of card ${cardName}: at most ${cardUsage.peakMinor} of ${cardUsage.creditLimitMinor} in use, on ${cardUsage.peakDate}`,
        );
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
      cardUsage,
      cardHeadroomAtPeakMinor: cardUsage ? cardUsage.creditLimitMinor - cardUsage.peakMinor : undefined,
      lastPaymentDate,
      installments: option.installments ?? 1,
      peakMonthlyOutflowMinor,
      forecast: result.forecast,
    };
  });

  if (options.length === 0) {
    return { options, ranking: [], status: "INSUFFICIENT_DATA", blockers: ["no payment option was supplied"] };
  }

  const ranking = rankOptions(options);
  const best = options.find((option) => option.id === ranking[0]!.optionId)!;
  if (!best.feasible) {
    return {
      options,
      ranking,
      leastBadOptionId: best.id,
      baselineBreach,
      status: "NO_FEASIBLE_OPTION",
      blockers: options.map((option) => `${option.label}: ${option.rejections.join(", ")}`),
    };
  }

  return { options, ranking, recommendedOptionId: best.id, baselineBreach, status: "OK", blockers: [] };
}

const softShortfall = (option: PaymentOptionResult): number =>
  option.softReserveImpacts.reduce((total, impact) => total + impact.shortfallMinor, 0);

/** An option on no card takes none of any limit: it has the most headroom there is. */
const headroom = (option: PaymentOptionResult): number =>
  option.cardHeadroomAtPeakMinor ?? Number.POSITIVE_INFINITY;

interface Criterion {
  name: ComparisonCriterion;
  /** Negative when `left` ranks first. */
  compare: (left: PaymentOptionResult, right: PaymentOptionResult) => number;
  /** The value shown in an explanation. */
  value: (option: PaymentOptionResult) => string | number;
  /** How the better value reads, for the explanation. */
  better: string;
}

const byNumber = (difference: number) => (difference === 0 ? 0 : difference < 0 ? -1 : 1);

/**
 * The comparator's ranking, criterion by criterion. Feasible options first;
 * among infeasible ones, fewer broken constraints first. Then: lowest total
 * cost, highest trough, lowest peak monthly outflow, earliest last payment,
 * lowest soft-reserve shortfall, most card headroom left at the card's peak
 * (so a tie between two cards goes to the one left with more free limit rather
 * than to whichever id sorts first), and the id last so the order is total.
 */
const CRITERIA: Criterion[] = [
  {
    name: "feasibility",
    compare: (left, right) => Number(right.feasible) - Number(left.feasible),
    value: (option) => (option.feasible ? "feasible" : "infeasible"),
    better: "feasible",
  },
  {
    name: "rejectionCount",
    compare: (left, right) => left.rejections.length - right.rejections.length,
    value: (option) => option.rejections.length,
    better: "fewer broken constraints",
  },
  {
    name: "totalCostMinor",
    compare: (left, right) => left.totalCostMinor - right.totalCostMinor,
    value: (option) => option.totalCostMinor,
    better: "lower total cost",
  },
  {
    name: "minimumBalanceMinor",
    compare: (left, right) => right.minimumBalanceMinor - left.minimumBalanceMinor,
    value: (option) => option.minimumBalanceMinor,
    better: "higher minimum balance",
  },
  {
    name: "peakMonthlyOutflowMinor",
    compare: (left, right) => left.peakMonthlyOutflowMinor - right.peakMonthlyOutflowMinor,
    value: (option) => option.peakMonthlyOutflowMinor,
    better: "lower peak monthly outflow",
  },
  {
    name: "lastPaymentDate",
    compare: (left, right) => (left.lastPaymentDate ?? "").localeCompare(right.lastPaymentDate ?? ""),
    value: (option) => option.lastPaymentDate ?? "none",
    better: "earlier last payment",
  },
  {
    name: "softReserveShortfallMinor",
    compare: (left, right) => softShortfall(left) - softShortfall(right),
    value: softShortfall,
    better: "lower soft-reserve shortfall",
  },
  {
    name: "cardHeadroomAtPeakMinor",
    compare: (left, right) => byNumber(headroom(right) - headroom(left)),
    value: (option) => option.cardHeadroomAtPeakMinor ?? "no card limit used",
    better: "more card limit left free at the peak",
  },
  {
    name: "id",
    compare: (left, right) => left.id.localeCompare(right.id),
    value: (option) => option.id,
    better: "id sorts first",
  },
];

function rankOptions(options: PaymentOptionResult[]): RankedOption[] {
  const sorted = [...options].sort((left, right) => {
    for (const criterion of CRITERIA) {
      const result = criterion.compare(left, right);
      if (result !== 0) return result;
    }
    return 0;
  });
  return sorted.map((option, index): RankedOption => {
    const above = sorted[index - 1];
    if (!above) {
      return {
        rank: 1,
        optionId: option.id,
        label: option.label,
        feasible: option.feasible,
        rejections: option.rejections,
        comparedWithOptionId: null,
        decidedBy: null,
        explanation: option.feasible
          ? "ranked first"
          : "ranked first among options that all break a hard constraint: the least bad, not a recommendation",
      };
    }
    const criterion = CRITERIA.find((candidate) => candidate.compare(above, option) !== 0)!;
    return {
      rank: index + 1,
      optionId: option.id,
      label: option.label,
      feasible: option.feasible,
      rejections: option.rejections,
      comparedWithOptionId: above.id,
      decidedBy: criterion.name,
      explanation: `below ${above.label} on ${criterion.name} (${criterion.better}): ${criterion.value(above)} vs ${criterion.value(option)}`,
    };
  });
}

export interface SimulatePurchaseInput extends SafeToSpendInput {
  option: PaymentOption;
  softReserves?: SoftReserve[];
  minimumAllowedBalanceMinor?: number;
  maxLastPaymentDate?: DateString;
  /** Statement payments and expected charges on the cards; see `CardActivity`. */
  cardActivity?: CardActivity;
}

export interface PurchaseSimulation {
  optionId: string;
  label: string;
  totalCostMinor: number;
  /**
   * Cash leaving the account on `firstSettlementDate` — the first settlement,
   * which is only today for a non-card payment made today. For a card it is the
   * first instalment, on the first statement's due date. The name is kept for
   * compatibility.
   */
  immediateImpactMinor: number;
  /** When the first cash settlement lands; undefined only for an option with none. */
  firstSettlementDate?: DateString;
  /** Cash outflow the option adds, keyed by `YYYY-MM`, in chronological order. */
  monthlyImpactMinor: Record<string, number>;
  safeToSpendBeforeMinor: number;
  safeToSpendAfterMinor: number;
  minimumBalanceBeforeMinor: number;
  minimumBalanceAfterMinor: number;
  minimumBalanceDateAfter: string;
  hardReserveViolated: boolean;
  softReserveImpacts: SoftReserveImpact[];
  creditLimitExceededMinor?: number;
  /**
   * @deprecated Same number as `cardUsage.peakMinor` (limit in use on the
   * card's busiest day with the purchase); kept for compatibility.
   */
  cardUtilizationAfterMinor?: number;
  /** The card's limit at its busiest, without and with the purchase. */
  cardUsage?: CardUsageSummary;
  /** `creditLimitMinor − cardUsage.peakMinor`, when charged to a card. */
  cardHeadroomAtPeakMinor?: number;
  lastPaymentDate?: string;
  installments: number;
  feasible: boolean;
  rejections: RejectionCode[];
  reasons: string[];
  /** Set when the forecast is already short before buying; see `BaselineBreach`. */
  baselineBreach?: BaselineBreach;
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
    cardActivity: input.cardActivity,
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
    firstSettlementDate: firstDate,
    monthlyImpactMinor,
    safeToSpendBeforeMinor: before.safeToSpendMinor,
    safeToSpendAfterMinor: after.safeToSpendAfterMinor,
    minimumBalanceBeforeMinor: before.minimumBalanceMinor,
    minimumBalanceAfterMinor: after.minimumBalanceMinor,
    minimumBalanceDateAfter: after.minimumBalanceDate,
    hardReserveViolated: after.hardReserveViolated,
    softReserveImpacts: after.softReserveImpacts,
    creditLimitExceededMinor: after.creditLimitExceededMinor,
    cardUtilizationAfterMinor: after.cardUsage?.peakMinor,
    cardUsage: after.cardUsage,
    cardHeadroomAtPeakMinor: after.cardHeadroomAtPeakMinor,
    lastPaymentDate: after.lastPaymentDate,
    installments: after.installments,
    feasible: after.feasible,
    rejections: after.rejections,
    reasons: after.reasons,
    baselineBreach: comparison.baselineBreach,
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
  /** Latest date the item is needed by — when it must be bought, not paid off. */
  deadline?: DateString;
  /** When the purchase happens. Compared against `deadline`. */
  purchaseDate?: DateString;
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

/** One card the plan charges: its limit at its busiest, without and with every item on it. */
export interface CardLoad extends CardUsageSummary {
  label: string;
  /** Added by every item in this plan charged to this card. */
  planChargedMinor: number;
}

/** One settlement of one plan item, landing in one month. */
export interface PlanItemMonthlyOutflow {
  itemId: string;
  label: string;
  /** Cash leaving for this item this month, as a positive magnitude. */
  amountMinor: number;
  /** Which settlement of the item this is, and of how many. `1 of 1` when paid outright. */
  installmentNumber: number;
  totalInstallments: number;
}

export interface MonthlyOutlookEntry {
  /** `YYYY-MM`. */
  month: string;
  /** Cash this plan takes out during the month. */
  purchaseOutflowMinor: number;
  /**
   * What made up that outflow, one entry per settlement, in date order.
   * Sums to `purchaseOutflowMinor` — a month's total and its parts are read off
   * the same events, so the table can never show a total its rows contradict.
   */
  items: PlanItemMonthlyOutflow[];
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
  /**
   * Statement payments and expected charges on the cards over the horizon.
   * Without it nothing is paid down and nothing else is charged, so the peak
   * is today's debt plus the whole plan.
   */
  cardActivity?: CardActivity;
}

export interface PurchasePlanSimulation {
  totalCostMinor: number;
  items: PlanItemContribution[];
  safeToSpendBeforeMinor: number;
  safeToSpendAfterMinor: number;
  /** The same two figures unclamped — negative once the trough is under the reserve. */
  safeToSpendSurplusBeforeMinor: number;
  safeToSpendSurplusAfterMinor: number;
  minimumBalanceBeforeMinor: number;
  minimumBalanceBeforeDate: DateString;
  minimumBalanceAfterMinor: number;
  minimumBalanceAfterDate: DateString;
  hardReserveViolated: boolean;
  softReserveImpacts: SoftReserveImpact[];
  /** One entry per card the plan charges, with every item's share summed. */
  cards: CardLoad[];
  /** Cash the whole plan adds, keyed by `YYYY-MM`, in chronological order. */
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
  /** Set when the forecast is already short before buying; see `BaselineBreach`. */
  baselineBreach?: BaselineBreach;
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

  const { rejections, reasons } = balanceVerdict(before, after, floorMinor, input.hardReserveMinor);

  // Card limits are shared, so the plan's items are charged together rather
  // than checked one by one: two 60%-of-limit purchases both pass alone and
  // fail here. And a limit is freed as statements are paid, so what counts is
  // the most in use on any one day, not the sum of everything ever charged.
  const byCard = new Map<string, { card: CardConstraint; planChargedMinor: number; charges: CardCharge[] }>();
  for (const item of input.items) {
    const card = item.option.card;
    if (!card) continue;
    const entry = byCard.get(card.cardId) ?? { card, planChargedMinor: 0, charges: [] };
    entry.planChargedMinor += item.option.totalCostMinor;
    entry.charges.push(
      ...cardChargesFor(item.option, item.purchaseDate ?? item.option.purchaseDate ?? input.forecastInput.asOf),
    );
    byCard.set(card.cardId, entry);
  }
  const cards = [...byCard.values()].map(({ card, planChargedMinor, charges }): CardLoad => ({
    ...cardUsageWith(card, input.cardActivity, charges, input.forecastInput),
    label: card.label ?? card.cardId,
    planChargedMinor,
  }));
  for (const load of cards) {
    if (load.exceededMinor > 0) {
      rejections.push("CREDIT_LIMIT_EXCEEDED");
      reasons.push(
        `${load.label} reaches ${load.peakMinor} of its ${load.creditLimitMinor} limit on ${load.peakDate}, ${load.exceededMinor} over`,
      );
    }
  }

  const items = input.items.map((item): PlanItemContribution => {
    const { lastPaymentDate } = summarizeOption(item.option);
    const itemRejections: RejectionCode[] = [];
    const itemReasons: string[] = [];
    const limit = item.deadline ?? input.targetDate;
    // The deadline is when the thing is needed, so it constrains the purchase.
    // Instalments running past it are normal, not a rejection.
    if (limit && item.purchaseDate && item.purchaseDate > limit) {
      itemRejections.push("DEADLINE_EXCEEDED");
      itemReasons.push(`cannot be bought until ${item.purchaseDate}, after ${limit}`);
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

  // The monthly total and its per-item breakdown are derived in one pass, from
  // the same events, so the table can never show a total its own rows disagree
  // with. Walking items rather than the flattened `planEvents` is what keeps
  // each settlement attributable — flattening loses which item paid.
  const monthlyImpactMinor: Record<string, number> = {};
  const outflowsByMonth = new Map<string, PlanItemMonthlyOutflow[]>();
  for (const item of input.items) {
    const settlements = item.option.cashEvents
      .filter((event) => event.amountMinor < 0)
      .sort((left, right) => left.expectedAt.localeCompare(right.expectedAt));
    // The engine never reads an installment number off the option: a card
    // settles one cycle per parcel, so the position in date order *is* the
    // parcel number. `installments` is only trusted for the denominator, and
    // falls back to the settlements actually produced.
    const totalInstallments = item.option.installments ?? Math.max(1, settlements.length);
    settlements.forEach((event, index) => {
      const key = monthKey(event.expectedAt);
      monthlyImpactMinor[key] = (monthlyImpactMinor[key] ?? 0) + -event.amountMinor;
      const forMonth = outflowsByMonth.get(key) ?? [];
      forMonth.push({
        itemId: item.itemId,
        label: item.label,
        amountMinor: -event.amountMinor,
        installmentNumber: index + 1,
        totalInstallments,
      });
      outflowsByMonth.set(key, forMonth);
    });
  }

  const settlementDates = planEvents.map((event) => event.expectedAt).sort();
  // Keys land in item order above; an edited item moves to the end of the
  // list, which used to put its early months after later ones.
  const chronologicalImpact = Object.fromEntries(
    Object.entries(monthlyImpactMinor).sort(([left], [right]) => left.localeCompare(right)),
  );

  const outlookByMonth = new Map<string, MonthlyOutlookEntry>();
  for (const day of after.forecast.days) {
    const month = monthKey(day.date);
    const entry = outlookByMonth.get(month);
    if (!entry) {
      outlookByMonth.set(month, {
        month,
        purchaseOutflowMinor: monthlyImpactMinor[month] ?? 0,
        items: outflowsByMonth.get(month) ?? [],
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
    safeToSpendSurplusBeforeMinor: before.surplusMinor,
    safeToSpendSurplusAfterMinor: after.surplusMinor,
    minimumBalanceBeforeMinor: before.minimumBalanceMinor,
    minimumBalanceBeforeDate: before.minimumBalanceDate,
    minimumBalanceAfterMinor: after.minimumBalanceMinor,
    minimumBalanceAfterDate: after.minimumBalanceDate,
    hardReserveViolated: after.hardReserveViolated,
    softReserveImpacts: evaluateSoftReserves(after.minimumBalanceMinor, softReserves),
    cards,
    monthlyImpactMinor: chronologicalImpact,
    lastPaymentDate: settlementDates.at(-1),
    feasible: rejections.length === 0,
    rejections,
    reasons,
    baselineBreach: baselineBreachOf(before, floorMinor, input.hardReserveMinor),
    forecastAfter: after.forecast,
  };
}

export interface RecommendationCandidateItem {
  itemId: string;
  label: string;
  /**
   * Latest date the item is needed by — when it must be *bought*, not when it
   * must be paid off. Conflating the two silently deleted every instalment
   * plan that ran past the date, which is exactly the plan someone asks for
   * when they say "I need it in December, split it over the year".
   */
  deadline?: DateString;
  /** When the purchase happens. Compared against `deadline`. */
  purchaseDate?: DateString;
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
  /** Statement payments and expected charges on the cards; see `CardActivity`. */
  cardActivity?: CardActivity;
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
  /**
   * The card's limit still free on its busiest day, with this choice and every
   * earlier one on it. Undefined when not charged to a card.
   */
  cardHeadroomAtPeakMinor?: number;
  /**
   * The criterion that put this way ahead of the next-best workable one, and
   * that one's id; undefined when it was the only workable way or nothing fit.
   */
  decidedBy?: RecommendationCriterion;
  runnerUpOptionId?: string;
  /** How many ways of paying it were workable at all, this one included. */
  workableCount: number;
  /**
   * False when nothing worked for this item and this is only the least-bad
   * way. "How would I pay for this" must always have an answer — a blank
   * screen is not a more honest one — so the choice is still made, and
   * labelled.
   */
  fits: boolean;
  /** What this way breaks, when it does not fit. */
  rejections: RejectionCode[];
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
   * what broke; the bar for every item becomes not lowering that trough.
   */
  baselineBreach?: BaselineBreach;
  /** One entry per item no candidate worked for, as data rather than prose. */
  blockedItems: BlockedItem[];
  /** The basket verdict for the chosen set. Absent when nothing was chosen. */
  simulation?: PurchasePlanSimulation;
  /** How far the best attempt still falls short of the reserve, and when. */
  shortfallMinor?: number;
  shortfallDate?: DateString;
  blockers: string[];
}

/** The criteria a recommendation picks between workable ways by, in order. */
export type RecommendationCriterion =
  | "minimumBalanceMinor"
  | "peakMonthlyOutflowMinor"
  | "totalCostMinor"
  | "installments"
  | "cardHeadroomAtPeakMinor"
  | "id";

const freeLimit = (headroomMinor: number): string =>
  Number.isFinite(headroomMinor) ? String(headroomMinor) : "no card";

interface CandidateVerdict {
  option: PaymentOption;
  /** Trough of the whole basket if this candidate is added to what is chosen. */
  minimumBalanceMinor: number;
  minimumBalanceDate: DateString;
  /** Limit free on the card's busiest day with this candidate; +∞ off-card. */
  cardHeadroomAtPeakMinor: number;
  /** The balance codes this candidate would break, judged by `balanceVerdict`. */
  balanceRejections: RejectionCode[];
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
  // Refusing to answer at all was the wrong call. Someone whose October is
  // already short still needs to know what their list would cost and when —
  // they just must not be told a purchase is fine when it deepens the hole.
  // So the bar becomes "do not make it worse": no candidate may push the
  // trough below where it already sits (`balanceVerdict`, shared with every
  // other entry point). The breach is reported either way.
  const baselineBreach = baselineBreachOf(baseline, floorMinor, input.hardReserveMinor);

  const chosenEvents: ForecastEvent[] = [];
  // What the items already chosen charge to each card, so a later item is
  // checked against the limit they leave.
  const chosenCardCharges: CardCharge[] = [];
  const choices: RecommendedChoice[] = [];
  const blockedItems: BlockedItem[] = [];
  const blockers: string[] = [];
  let bestEffortTrough: { minimumBalanceMinor: number; minimumBalanceDate: DateString } | undefined;
  let failed = false;

  for (const item of ordered) {
    const limitDate = item.deadline ?? input.targetDate;

    const verdicts = item.candidates.map((option): CandidateVerdict => {
      const result = calculateSafeToSpend({
        hardReserveMinor: input.hardReserveMinor,
        forecastInput: {
          ...input.forecastInput,
          events: [...input.forecastInput.events, ...chosenEvents, ...option.cashEvents],
        },
      });

      const breaksDeadline = Boolean(
        limitDate && item.purchaseDate && item.purchaseDate > limitDate,
      );
      const card = option.card;
      const usage = card
        ? cardUsageWith(
            card,
            input.cardActivity,
            [
              ...chosenCardCharges,
              ...cardChargesFor(option, item.purchaseDate ?? option.purchaseDate ?? input.forecastInput.asOf),
            ],
            input.forecastInput,
          )
        : undefined;
      const breaksCard = usage ? usage.exceededMinor > 0 : false;
      const balanceRejections = balanceVerdict(
        baseline,
        result,
        floorMinor,
        input.hardReserveMinor,
      ).rejections;
      const breaksFloor = balanceRejections.length > 0;
      const breaksInstallmentCap =
        item.maxInstallments !== undefined && (option.installments ?? 1) > item.maxInstallments;

      return {
        option,
        minimumBalanceMinor: result.minimumBalanceMinor,
        minimumBalanceDate: result.minimumBalanceDate,
        cardHeadroomAtPeakMinor: usage
          ? usage.creditLimitMinor - usage.peakMinor
          : Number.POSITIVE_INFINITY,
        balanceRejections,
        breaksDeadline,
        breaksCard,
        breaksFloor,
        breaksInstallmentCap,
        acceptable: !breaksDeadline && !breaksCard && !breaksInstallmentCap && !breaksFloor,
      };
    });

    // Preserve cash: highest trough first. When troughs tie — and they tie far
    // more often than they look like they should, because a trough that sits
    // before every settlement is untouched by all of them — the deciding
    // question is how much a single month has to absorb. Ranking by
    // instalment count there was backwards: it handed the shortest plan the
    // win precisely when spreading was free, so a card whose first bill lands
    // after the low point came back as 2x instead of 12x.
    //
    // Card headroom comes before the id: two cards at the same instalment
    // count tie on everything else, and letting the id decide piled a whole
    // list onto one card up to 97.5% of its limit while another sat empty.
    const preferenceCriteria: Array<[RecommendationCriterion, (left: CandidateVerdict, right: CandidateVerdict) => number]> = [
      ["minimumBalanceMinor", (left, right) => right.minimumBalanceMinor - left.minimumBalanceMinor],
      [
        "peakMonthlyOutflowMinor",
        (left, right) =>
          summarizeOption(left.option).peakMonthlyOutflowMinor - summarizeOption(right.option).peakMonthlyOutflowMinor,
      ],
      ["totalCostMinor", (left, right) => left.option.totalCostMinor - right.option.totalCostMinor],
      ["installments", (left, right) => (left.option.installments ?? 1) - (right.option.installments ?? 1)],
      ["cardHeadroomAtPeakMinor", (left, right) => byNumber(right.cardHeadroomAtPeakMinor - left.cardHeadroomAtPeakMinor)],
      ["id", (left, right) => left.option.id.localeCompare(right.option.id)],
    ];
    const byPreference = (left: CandidateVerdict, right: CandidateVerdict) => {
      for (const [, compare] of preferenceCriteria) {
        const result = compare(left, right);
        if (result !== 0) return result;
      }
      return 0;
    };

    const acceptable = verdicts.filter((verdict) => verdict.acceptable).sort(byPreference);
    const picked = acceptable[0];

    // When nothing is acceptable, "least bad" must mean fewest walls hit, not
    // just the highest trough. Two cards give near-identical troughs, so the
    // trough alone let the fallback land on the card that is already over its
    // limit while another had room — pointing at the wrong card in the one
    // case where the pointing is all the user gets.
    const brokenCount = (verdict: CandidateVerdict) =>
      Number(verdict.breaksInstallmentCap) +
      Number(verdict.breaksDeadline) +
      Number(verdict.breaksCard) +
      Number(verdict.breaksFloor);
    const nearest = [...verdicts].sort(
      (left, right) => brokenCount(left) - brokenCount(right) || byPreference(left, right),
    )[0]!;
    if (!picked) {
      failed = true;
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
    }

    // The least-bad candidate stands in when none worked, so every item is
    // answered and the basket picture below is the real one.
    const taken = picked ?? nearest;
    const takenRejections: RejectionCode[] = [...taken.balanceRejections];
    if (taken.breaksCard) takenRejections.push("CREDIT_LIMIT_EXCEEDED");
    if (taken.breaksInstallmentCap || taken.breaksDeadline) takenRejections.push("DEADLINE_EXCEEDED");
    const runnerUp = picked ? acceptable[1] : undefined;
    const decidedBy = runnerUp
      ? preferenceCriteria.find(([, compare]) => compare(taken, runnerUp) !== 0)?.[0]
      : undefined;
    chosenEvents.push(...taken.option.cashEvents);
    chosenCardCharges.push(
      ...cardChargesFor(taken.option, item.purchaseDate ?? taken.option.purchaseDate ?? input.forecastInput.asOf),
    );

    const runnersUp = Math.max(0, acceptable.length - 1);
    const { lastPaymentDate } = summarizeOption(taken.option);
    const settlements = [...taken.option.cashEvents].sort((left, right) =>
      left.expectedAt.localeCompare(right.expectedAt),
    );
    choices.push({
      itemId: item.itemId,
      label: item.label,
      optionId: taken.option.id,
      optionLabel: taken.option.label,
      totalCostMinor: taken.option.totalCostMinor,
      installments: taken.option.installments ?? 1,
      installmentAmountMinor: Math.abs(settlements[0]?.amountMinor ?? taken.option.totalCostMinor),
      firstPaymentDate: settlements[0]?.expectedAt,
      lastPaymentDate,
      cardId: taken.option.card?.cardId,
      cardLabel: taken.option.card?.label,
      minimumBalanceMinor: taken.minimumBalanceMinor,
      minimumBalanceDate: taken.minimumBalanceDate,
      cardHeadroomAtPeakMinor: Number.isFinite(taken.cardHeadroomAtPeakMinor)
        ? taken.cardHeadroomAtPeakMinor
        : undefined,
      decidedBy,
      runnerUpOptionId: runnerUp?.option.id,
      workableCount: acceptable.length,
      fits: Boolean(picked),
      rejections: takenRejections,
      reasons: picked
        ? [
            `leaves the balance at ${taken.minimumBalanceMinor} on ${taken.minimumBalanceDate}, the highest of ${acceptable.length} workable ${acceptable.length === 1 ? "way" : "ways"} to pay it`,
            ...(runnersUp > 0 ? [`${runnersUp} other option${runnersUp === 1 ? "" : "s"} also fit`] : []),
            ...(runnerUp && decidedBy
              ? [`chosen over ${runnerUp.option.label} on ${decidedBy}${decidedBy === "cardHeadroomAtPeakMinor" ? ` (${freeLimit(taken.cardHeadroomAtPeakMinor)} vs ${freeLimit(runnerUp.cardHeadroomAtPeakMinor)} of limit left free at the peak)` : ""}`]
              : []),
            ...(limitDate && lastPaymentDate ? [`paid off by ${lastPaymentDate}, within ${limitDate}`] : []),
          ]
        : [
            `no way of paying it works; this is the least-bad, leaving ${taken.minimumBalanceMinor} on ${taken.minimumBalanceDate}`,
          ],
    });
  }

  const chosenById = new Map(choices.map((choice) => [choice.itemId, choice.optionId]));
  const simulation = simulatePurchasePlan({
    forecastInput: input.forecastInput,
    hardReserveMinor: input.hardReserveMinor,
    softReserves: input.softReserves,
    minimumAllowedBalanceMinor: input.minimumAllowedBalanceMinor,
    targetDate: input.targetDate,
    cardActivity: input.cardActivity,
    items: ordered.map((item) => ({
      itemId: item.itemId,
      label: item.label,
      deadline: item.deadline,
      purchaseDate: item.purchaseDate,
      option: item.candidates.find((candidate) => candidate.id === chosenById.get(item.itemId))!,
    })),
  });

  if (failed) {
    const reserveGap =
      bestEffortTrough && bestEffortTrough.minimumBalanceMinor < input.hardReserveMinor
        ? input.hardReserveMinor - bestEffortTrough.minimumBalanceMinor
        : undefined;
    return {
      status: "NO_FEASIBLE_PLAN",
      choices,
      simulation,
      blockedItems,
      baselineBreach,
      shortfallMinor: reserveGap,
      shortfallDate: reserveGap !== undefined ? bestEffortTrough?.minimumBalanceDate : undefined,
      blockers,
    };
  }

  return { status: "OK", choices, simulation, baselineBreach, blockedItems: [], blockers: [] };
}
