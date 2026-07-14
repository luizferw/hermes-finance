import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

/** Headline number card with a micro-label eyebrow. */
export function StatCard({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: string;
  hint?: React.ReactNode;
  tone?: "positive" | "negative" | "neutral";
  className?: string;
}) {
  return (
    <Card className={cn("gap-1.5 px-5 py-4", className)}>
      <p className="micro-label">{label}</p>
      <p
        className={cn(
          "font-amount text-xl leading-tight font-medium tracking-tight sm:text-2xl",
          tone === "positive" && "text-success",
          tone === "negative" && "text-destructive",
        )}
      >
        {value}
      </p>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}
