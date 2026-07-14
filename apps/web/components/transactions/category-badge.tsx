import { HugeiconsIcon } from "@hugeicons/react";
import {
  Briefcase01Icon,
  Car01Icon,
  CreditCardIcon,
  FavouriteIcon,
  Film01Icon,
  FlashIcon,
  Home09Icon,
  PackageIcon,
  Restaurant01Icon,
  ShoppingBag01Icon,
  ShoppingCart01Icon,
  TagsIcon,
  Tv01Icon,
  AirplaneTakeOff01Icon,
  ChartUpIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/** Maps the icon slugs stored on categories to actual icons. */
const CATEGORY_ICONS: Record<string, typeof TagsIcon> = {
  briefcase: Briefcase01Icon,
  home: Home09Icon,
  cart: ShoppingCart01Icon,
  utensils: Restaurant01Icon,
  car: Car01Icon,
  bolt: FlashIcon,
  tv: Tv01Icon,
  bag: ShoppingBag01Icon,
  heart: FavouriteIcon,
  film: Film01Icon,
  plane: AirplaneTakeOff01Icon,
  "trending-up": ChartUpIcon,
  "credit-card": CreditCardIcon,
  package: PackageIcon,
};

export interface CategoryLike {
  name: string;
  icon?: string | null;
  color?: string | null;
}

export function CategoryBadge({
  category,
  className,
}: {
  category: CategoryLike | null | undefined;
  className?: string;
}) {
  if (!category) {
    return (
      <Badge
        variant="outline"
        className={cn("border-dashed text-muted-foreground", className)}
      >
        Uncategorized
      </Badge>
    );
  }
  const icon = category.icon ? CATEGORY_ICONS[category.icon] : undefined;
  return (
    <Badge variant="secondary" className={cn("gap-1.5 font-normal", className)}>
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: category.color ?? "var(--muted-foreground)" }}
      />
      {icon && <HugeiconsIcon icon={icon} className="size-3" strokeWidth={1.8} />}
      {category.name}
    </Badge>
  );
}
