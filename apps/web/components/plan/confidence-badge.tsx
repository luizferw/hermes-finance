import type { Confidence } from "@hermes-finance/forecast";
import { cn } from "@/lib/utils";

const LABEL: Record<Confidence, string> = {
  ACTUAL: "Actual",
  CONFIRMED: "Confirmed",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

const TONE: Record<Confidence, string> = {
  ACTUAL: "bg-primary/10 text-primary",
  CONFIRMED: "bg-primary/10 text-primary",
  HIGH: "bg-muted text-muted-foreground",
  MEDIUM: "bg-warning/10 text-warning",
  LOW: "bg-muted text-muted-foreground/70",
};

/**
 * How sure the engine is about a projected figure, from real transaction
 * (ACTUAL) down to a loose pattern (LOW). Never carries urgency on its own —
 * low confidence means "assumed", not "wrong".
 */
export function ConfidenceBadge({
  confidence,
  className,
}: {
  confidence: Confidence;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-full px-2 py-0.5 text-[0.625rem] font-medium whitespace-nowrap",
        TONE[confidence],
        className,
      )}
    >
      {LABEL[confidence]}
    </span>
  );
}
