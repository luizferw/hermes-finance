import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  pending: {
    label: "Draft",
    className: "bg-warning/12 text-warning-foreground dark:text-warning border-transparent",
  },
  imported: {
    label: "Needs review",
    className: "bg-chart-2/12 text-chart-2 border-transparent",
  },
  reviewed: {
    label: "Reviewed",
    className: "bg-primary/10 text-primary border-transparent",
  },
  posted: {
    label: "Posted",
    className: "bg-muted text-muted-foreground border-transparent",
  },
  rejected: {
    label: "Rejected",
    className: "bg-destructive/10 text-destructive border-transparent",
  },
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.posted!;
  return <Badge className={cn(style.className, className)}>{style.label}</Badge>;
}
