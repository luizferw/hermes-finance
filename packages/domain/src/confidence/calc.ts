/**
 * Financial confidence — an honest composite of how safe and in-control the
 * money actually is, derived only from real signals (no invented gauge).
 *
 * Six factors, each scored 0–100 from existing data and each weighted by how
 * much it drives the *felt* sense of safety. A factor that doesn't apply yet
 * (no budgets, no goals, no income recorded this month) is dropped and its
 * weight redistributed across the rest, so the score never punishes someone
 * for not using a feature.
 *
 * The composite resolves to a calm band word ("Secure" … "Stretched") and a
 * split of factors into what's *lifting* confidence and what's *weighing* on
 * it — the two questions a person actually asks of their finances.
 */

export type FactorStatus = "lifting" | "steady" | "weighing";
export type ConfidenceBand = "secure" | "steady" | "finding" | "stretched";

export type FactorKey =
  | "runway"
  | "cashflow"
  | "plan"
  | "obligations"
  | "goals"
  | "upkeep";

export interface ConfidenceFactor {
  key: FactorKey;
  /** Human label, e.g. "Runway". */
  label: string;
  /** 0–100 sub-score. */
  score: number;
  status: FactorStatus;
  /** Currency-free one-line read, e.g. "4.2 months of expenses covered". */
  note: string;
  /** Where to go act on this factor. */
  href: string;
  /** Normalised contribution weight after redistribution (0–1). */
  weight: number;
}

export interface ConfidenceResult {
  /** 0–100 composite. */
  score: number;
  band: ConfidenceBand;
  /** Calm one-line read of the band, given the score. */
  read: string;
  factors: ConfidenceFactor[];
  /** Factors at or above the lifting threshold, strongest first. */
  lifting: ConfidenceFactor[];
  /** Factors below the steady threshold, weakest first. */
  weighing: ConfidenceFactor[];
  /** Inbox clear AND nothing overdue — the daily "stayed on top" signal. */
  onTop: boolean;
}

export interface ConfidenceInput {
  /** Sum of positive (asset) balances on net-worth accounts, minor units. */
  liquidAssetsMinor: number;
  /** Trailing average monthly spend, minor units (0 when unknown). */
  avgMonthlySpendMinor: number;
  /** This month's income / expense, minor units (expense positive). */
  incomeThisMonthMinor: number;
  expenseThisMonthMinor: number;
  /** Active budgets this month and how many are over. */
  budgetsTotal: number;
  budgetsOver: number;
  /** Upcoming bills (next ~2 weeks) total + how many are overdue. */
  upcomingBillsTotalMinor: number;
  billsOverdue: number;
  /** Savings goals and how many are on/ahead of pace (achieved counts). */
  goalsTotal: number;
  goalsOnTrack: number;
  /** Items waiting in the inbox to review. */
  inboxCount: number;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

const BASE_WEIGHTS: Record<FactorKey, number> = {
  runway: 0.3,
  cashflow: 0.2,
  plan: 0.15,
  obligations: 0.15,
  goals: 0.1,
  upkeep: 0.1,
};

const LABELS: Record<FactorKey, string> = {
  runway: "Runway",
  cashflow: "Cashflow",
  plan: "On plan",
  obligations: "Obligations",
  goals: "Goals",
  upkeep: "Upkeep",
};

const HREFS: Record<FactorKey, string> = {
  runway: "/accounts",
  cashflow: "/reports",
  plan: "/plan/budgets",
  obligations: "/plan/bills",
  goals: "/plan/goals",
  upkeep: "/inbox",
};

const LIFTING_AT = 65;
const WEIGHING_AT = 45;

function statusFor(score: number): FactorStatus {
  if (score >= LIFTING_AT) return "lifting";
  if (score < WEIGHING_AT) return "weighing";
  return "steady";
}

/** Build one factor, or null when it doesn't apply yet. */
function buildFactor(
  key: FactorKey,
  applies: boolean,
  score: number,
  note: string,
): { key: FactorKey; score: number; note: string } | null {
  if (!applies) return null;
  return { key, score: clamp(Math.round(score)), note };
}

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const raw: Array<{ key: FactorKey; score: number; note: string }> = [];

  // ── Runway — months of spending the liquid pile covers. The single biggest
  //    driver of how safe money feels. 6 months reads as fully secure.
  {
    const spend = input.avgMonthlySpendMinor;
    if (spend > 0) {
      const months = input.liquidAssetsMinor / spend;
      const f = buildFactor(
        "runway",
        true,
        (months / 6) * 100,
        months >= 0.05
          ? `${months.toFixed(1)} months of expenses covered`
          : "No buffer against expenses yet",
      );
      if (f) raw.push(f);
    } else if (input.liquidAssetsMinor > 0) {
      raw.push({ key: "runway", score: 100, note: "Cash on hand, nothing going out" });
    }
  }

  // ── Cashflow — are you keeping money this month? Savings rate maps 0%→35,
  //    30%→100; spending more than you earn falls away fast.
  if (input.incomeThisMonthMinor > 0) {
    const rate =
      (input.incomeThisMonthMinor - input.expenseThisMonthMinor) /
      input.incomeThisMonthMinor;
    const pct = Math.round(rate * 100);
    raw.push({
      key: "cashflow",
      score: clamp(Math.round(35 + rate * 217)),
      note:
        rate > 0
          ? `Keeping ${pct}% of what you earn`
          : rate === 0
            ? "Spending exactly what you earn"
            : "Spending more than you earn",
    });
  } else if (input.expenseThisMonthMinor > 0) {
    // Money going out with no income recorded yet this month — a real, if soft, drag.
    raw.push({ key: "cashflow", score: 32, note: "Spending with no income yet this month" });
  }

  // ── On plan — share of budgets within their limit; an overspend stings more
  //    than a near-miss, so each one over drags the score harder than 1/N.
  if (input.budgetsTotal > 0) {
    const over = input.budgetsOver;
    raw.push({
      key: "plan",
      score: clamp(100 - (over / input.budgetsTotal) * 130),
      note:
        over === 0
          ? `All ${input.budgetsTotal} budgets on track`
          : `${over} of ${input.budgetsTotal} budgets over`,
    });
  }

  // ── Obligations — can the liquid pile cover what's due, and is anything late?
  //    Overdue is the felt failure, so it dominates the score.
  if (input.upcomingBillsTotalMinor > 0 || input.billsOverdue > 0) {
    const covered =
      input.upcomingBillsTotalMinor === 0 ||
      input.liquidAssetsMinor >= input.upcomingBillsTotalMinor;
    let score = covered ? 100 : 55;
    score -= input.billsOverdue * 35;
    raw.push({
      key: "obligations",
      score: clamp(score),
      note:
        input.billsOverdue > 0
          ? `${input.billsOverdue} ${input.billsOverdue === 1 ? "bill" : "bills"} overdue`
          : covered
            ? "What's due is covered"
            : "What's due exceeds your cash",
    });
  }

  // ── Goals — share of savings goals on or ahead of pace.
  if (input.goalsTotal > 0) {
    const ratio = input.goalsOnTrack / input.goalsTotal;
    raw.push({
      key: "goals",
      score: clamp(ratio * 100),
      note:
        input.goalsOnTrack === input.goalsTotal
          ? `All ${input.goalsTotal} goals on pace`
          : `${input.goalsOnTrack} of ${input.goalsTotal} goals on pace`,
    });
  }

  // ── Upkeep — the habit layer. A clear inbox means the numbers can be trusted;
  //    a backlog erodes that quietly. Floors at 30 so it nudges, never dominates.
  raw.push({
    key: "upkeep",
    score: input.inboxCount === 0 ? 100 : clamp(100 - input.inboxCount * 4, 30, 95),
    note:
      input.inboxCount === 0
        ? "Inbox clear — numbers are current"
        : `${input.inboxCount} to review`,
  });

  // Redistribute base weights across the factors that actually applied.
  const totalBase = raw.reduce((s, f) => s + BASE_WEIGHTS[f.key], 0) || 1;
  const factors: ConfidenceFactor[] = raw.map((f) => ({
    key: f.key,
    label: LABELS[f.key],
    score: f.score,
    status: statusFor(f.score),
    note: f.note,
    href: HREFS[f.key],
    weight: BASE_WEIGHTS[f.key] / totalBase,
  }));

  const score = clamp(
    Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0)),
  );
  const band = confidenceBand(score);

  const lifting = factors
    .filter((f) => f.status === "lifting")
    .sort((a, b) => b.score - a.score);
  const weighing = factors
    .filter((f) => f.status === "weighing")
    .sort((a, b) => a.score - b.score);

  return {
    score,
    band,
    read: bandRead(band, score),
    factors,
    lifting,
    weighing,
    onTop: input.inboxCount === 0 && input.billsOverdue === 0,
  };
}

export function confidenceBand(score: number): ConfidenceBand {
  if (score >= 80) return "secure";
  if (score >= 62) return "steady";
  if (score >= 42) return "finding";
  return "stretched";
}

export const BAND_LABEL: Record<ConfidenceBand, string> = {
  secure: "Secure",
  steady: "Steady",
  finding: "Finding footing",
  stretched: "Stretched",
};

function bandRead(band: ConfidenceBand, score: number): string {
  switch (band) {
    case "secure":
      return "Your money is on solid ground. Keep doing what you're doing.";
    case "steady":
      return "You're in control. A few things could be even stronger.";
    case "finding":
      return score >= 50
        ? "Coming together. A couple of moves would steady things."
        : "Finding your footing. Small, steady steps from here.";
    case "stretched":
      return "Things feel tight right now. Start with what's weighing most.";
  }
}
