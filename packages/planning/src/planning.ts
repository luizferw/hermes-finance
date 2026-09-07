import { buildForecast, type BuildForecastInput, type Forecast, type ForecastEvent } from "@hermes-finance/forecast";

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

function assertMinorUnits(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must use finite integer minor units`);
  }
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

export interface PaymentOption {
  id: string;
  label: string;
  totalCostMinor: number;
  /** Cash settlement events only. Card purchase classification stays in the ledger. */
  cashEvents: ForecastEvent[];
}

export interface ComparePaymentOptionsInput extends SafeToSpendInput {
  options: PaymentOption[];
}

export interface PaymentOptionResult {
  id: string;
  label: string;
  totalCostMinor: number;
  minimumBalanceMinor: number;
  minimumBalanceDate: string;
  hardReserveViolated: boolean;
  safeToSpendAfterMinor: number;
  forecast: Forecast;
}

export interface PaymentComparison {
  options: PaymentOptionResult[];
  /** Undefined when every option breaks a hard constraint. */
  recommendedOptionId?: string;
}

/**
 * V1 deterministic payment comparator. Feasibility (hard reserve) precedes
 * cost, then liquidity. Credit limits and deadlines belong to the next adapter
 * once those normalized inputs exist.
 */
export function comparePaymentOptions(input: ComparePaymentOptionsInput): PaymentComparison {
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

  const options = input.options.map((option) => {
    const result = calculateSafeToSpend({
      hardReserveMinor: input.hardReserveMinor,
      forecastInput: {
        ...input.forecastInput,
        events: [...input.forecastInput.events, ...option.cashEvents],
      },
    });
    return {
      id: option.id,
      label: option.label,
      totalCostMinor: option.totalCostMinor,
      minimumBalanceMinor: result.minimumBalanceMinor,
      minimumBalanceDate: result.minimumBalanceDate,
      hardReserveViolated: result.hardReserveViolated,
      safeToSpendAfterMinor: result.safeToSpendMinor,
      forecast: result.forecast,
    };
  });

  const viable = options
    .filter((option) => !option.hardReserveViolated)
    .sort((left, right) =>
      left.totalCostMinor - right.totalCostMinor || right.minimumBalanceMinor - left.minimumBalanceMinor || left.id.localeCompare(right.id),
    );

  return { options, recommendedOptionId: viable[0]?.id };
}
