import { cn } from "@/lib/utils";

/**
 * Kosh has no symbol — the wordmark is the logo. Instrument Serif, tightened,
 * set in ink. `BrandInitial` is the wordmark reduced to "K" for the collapsed
 * sidebar rail.
 */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-serif text-[1.6rem] leading-none tracking-[-0.015em] text-foreground",
        className,
      )}
    >
      Kosh
    </span>
  );
}

export function BrandInitial({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-serif text-2xl leading-none tracking-[-0.015em] text-foreground",
        className,
      )}
      aria-hidden
    >
      K
    </span>
  );
}
