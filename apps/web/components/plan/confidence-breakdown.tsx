import type { Confidence } from "@hermes-finance/forecast";
import type { ConfidenceBreakdown } from "@/modules/finance/queries";
import { cn } from "@/lib/utils";

const ORDER: Confidence[] = ["ACTUAL", "CONFIRMED", "HIGH", "MEDIUM", "LOW"];
const LABEL: Record<Confidence, string> = {
  ACTUAL: "Actual",
  CONFIRMED: "Confirmed",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};
const COLOR: Record<Confidence, string> = {
  ACTUAL: "var(--chart-1)",
  CONFIRMED: "var(--chart-2)",
  HIGH: "var(--chart-3)",
  MEDIUM: "var(--chart-4)",
  LOW: "var(--chart-5)",
};

/**
 * How much of the forecast rests on facts versus assumptions (PRD §61), as
 * one proportional bar — real and confirmed money reads as solid ground,
 * estimated money reads as a lighter share, before a single percentage is
 * parsed.
 */
export function ConfidenceBreakdownMeter({ breakdown }: { breakdown: ConfidenceBreakdown }) {
  if (breakdown.totalMinor === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        Nothing projected yet in this window.
      </p>
    );
  }

  const tiers = ORDER.filter((tier) => breakdown.sharePercent[tier] > 0);

  return (
    <div>
      <div className="flex h-2.5 w-full gap-1 overflow-hidden rounded-full bg-foreground/[0.05]">
        {tiers.map((tier, i) => (
          <span
            key={tier}
            className={cn("grow-x h-full rounded-full", i === tiers.length - 1 && "flex-1")}
            style={
              {
                width: `${breakdown.sharePercent[tier]}%`,
                background: COLOR[tier],
                "--i": i,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {tiers.map((tier) => (
          <div key={tier} className="flex items-baseline gap-2">
            <span
              aria-hidden
              className="size-2 shrink-0 translate-y-px rounded-[3px]"
              style={{ background: COLOR[tier] }}
            />
            <dt className="text-muted-foreground">{LABEL[tier]}</dt>
            <dd className="font-amount tabular-nums">{breakdown.sharePercent[tier]}%</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
