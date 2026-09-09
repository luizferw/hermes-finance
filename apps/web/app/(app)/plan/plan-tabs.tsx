"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = [
  { href: "/plan", label: "Horizon" },
  { href: "/plan/goals", label: "Goals" },
  { href: "/plan/bills", label: "Bills" },
  { href: "/plan/recurring", label: "Recurring" },
  { href: "/plan/budgets", label: "Budgets" },
  { href: "/plan/commitments", label: "Commitments" },
  { href: "/plan/cards", label: "Cards" },
  { href: "/plan/purchases", label: "Purchases" },
  { href: "/plan/reserves", label: "Reserves" },
];

export function PlanTabs() {
  const pathname = usePathname();
  // Longest matching href wins so `/plan/goals` selects Goals, not Horizon.
  const active = TABS.reduce<string | undefined>((best, tab) => {
    const match = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    return match && tab.href.length > (best?.length ?? -1) ? tab.href : best;
  }, undefined);
  return (
    <Tabs value={active}>
      <TabsList className="w-full sm:w-auto">
        {TABS.map((tab) => (
          <TabsTrigger key={tab.href} value={tab.href} asChild className="flex-1 sm:flex-none">
            <Link href={tab.href}>{tab.label}</Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
