import { cn } from "@/lib/utils";
import { formatAmount } from "@/lib/format";

/**
 * The canonical money rendering: mono, tabular, green for inflows with an
 * explicit + sign, plain ink for outflows.
 */
export function Amount({
  amountMinor,
  currencyCode,
  className,
  muted = false,
}: {
  amountMinor: number;
  currencyCode: string;
  className?: string;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "font-amount whitespace-nowrap",
        amountMinor > 0 && !muted && "text-success",
        muted && "text-muted-foreground",
        className,
      )}
    >
      {formatAmount(amountMinor, currencyCode)}
    </span>
  );
}
