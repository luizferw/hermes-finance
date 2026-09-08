import {
  ArrowDataTransferHorizontalIcon,
  Calendar03Icon,
  ChartLineData01Icon,
  Compass01Icon,
  CreditCardIcon,
  Home01Icon,
  InboxIcon,
  Invoice01Icon,
  MagicWand01Icon,
  PieChart01Icon,
  RepeatIcon,
  Settings01Icon,
  ShoppingBag01Icon,
  Target01Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";

export interface NavItem {
  title: string;
  href: string;
  icon: typeof Home01Icon;
  /** Show the inbox review count badge. */
  showInboxBadge?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

/**
 * Navigation is organised around *intent*, not data tables — the spaces a
 * person moves through. "Today" is the confidence home (where you stand right
 * now); "Money" is what you hold and what moved; "Future" is where you're
 * headed; "Patterns" is how you behave over time.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { title: "Today", href: "/overview", icon: Home01Icon },
      { title: "Inbox", href: "/inbox", icon: InboxIcon, showInboxBadge: true },
    ],
  },
  {
    label: "Money",
    items: [
      { title: "Accounts", href: "/accounts", icon: Wallet01Icon },
      {
        title: "Transactions",
        href: "/transactions",
        icon: ArrowDataTransferHorizontalIcon,
      },
    ],
  },
  {
    label: "Future",
    items: [
      { title: "Horizon", href: "/plan", icon: Compass01Icon },
      { title: "Goals", href: "/plan/goals", icon: Target01Icon },
      { title: "Bills", href: "/plan/bills", icon: Invoice01Icon },
      { title: "Recurring", href: "/plan/recurring", icon: RepeatIcon },
      { title: "Budgets", href: "/plan/budgets", icon: PieChart01Icon },
      { title: "Commitments", href: "/plan/commitments", icon: Calendar03Icon },
      { title: "Cards", href: "/plan/cards", icon: CreditCardIcon },
      { title: "Purchases", href: "/plan/purchases", icon: ShoppingBag01Icon },
    ],
  },
  {
    label: "Patterns",
    items: [
      { title: "Trends", href: "/reports", icon: ChartLineData01Icon },
      { title: "Automations", href: "/automations", icon: MagicWand01Icon },
    ],
  },
  {
    items: [{ title: "Settings", href: "/settings", icon: Settings01Icon }],
  },
];

/**
 * Resolve a pathname to its nav location for breadcrumbs. Longest-prefix wins
 * so `/transactions/import` resolves to the Transactions item, not a shorter
 * sibling.
 */
export function findNavLocation(pathname: string): {
  sectionLabel?: string;
  item?: NavItem;
} {
  let best: { sectionLabel?: string; item?: NavItem } = {};
  let bestLen = -1;
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (
        (pathname === item.href || pathname.startsWith(`${item.href}/`)) &&
        item.href.length > bestLen
      ) {
        best = { sectionLabel: section.label, item };
        bestLen = item.href.length;
      }
    }
  }
  return best;
}
