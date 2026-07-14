"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDataTransferHorizontalIcon,
  ChartLineData01Icon,
  Home01Icon,
  InboxIcon,
  Invoice01Icon,
  MagicWand01Icon,
  MoreHorizontalIcon,
  PieChart01Icon,
  PlusSignIcon,
  RepeatIcon,
  Settings01Icon,
  Target01Icon,
  Upload01Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { MobileQuickAdd } from "@/components/home/mobile-quick-add";

type IconType = typeof Home01Icon;

const PRIMARY: { title: string; href: string; icon: IconType }[] = [
  { title: "Today", href: "/overview", icon: Home01Icon },
  { title: "Transactions", href: "/transactions", icon: ArrowDataTransferHorizontalIcon },
  { title: "Future", href: "/plan", icon: PieChart01Icon },
];

// Reuses the per-page `?new=1` dialog-open convention (and Import CSV route).
const QUICK_ADD: { label: string; href: string; icon: IconType }[] = [
  { label: "New account", href: "/accounts?new=1", icon: Wallet01Icon },
  { label: "New budget", href: "/plan/budgets?new=1", icon: PieChart01Icon },
  { label: "New rule", href: "/automations?new=1", icon: MagicWand01Icon },
  { label: "Import CSV", href: "/transactions/import", icon: Upload01Icon },
];

const MORE: { title: string; href: string; icon: IconType }[] = [
  { title: "Inbox", href: "/inbox", icon: InboxIcon },
  { title: "Accounts", href: "/accounts", icon: Wallet01Icon },
  { title: "Bills", href: "/plan/bills", icon: Invoice01Icon },
  { title: "Recurring", href: "/plan/recurring", icon: RepeatIcon },
  { title: "Goals", href: "/plan/goals", icon: Target01Icon },
  { title: "Trends", href: "/reports", icon: ChartLineData01Icon },
  { title: "Automations", href: "/automations", icon: MagicWand01Icon },
  { title: "Settings", href: "/settings", icon: Settings01Icon },
];

export function MobileBottomNav() {
  const pathname = usePathname();
  const [addOpen, setAddOpen] = React.useState(false);
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-ledger bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
      <div className="mx-auto grid h-16 max-w-lg grid-cols-5 items-center px-2 pb-[env(safe-area-inset-bottom)]">
        <NavLink item={PRIMARY[0]!} active={isActive(PRIMARY[0]!.href)} />
        <NavLink item={PRIMARY[1]!} active={isActive(PRIMARY[1]!.href)} />

        <Sheet open={addOpen} onOpenChange={setAddOpen}>
          <SheetTrigger
            aria-label="Quick add"
            className="mx-auto flex size-12 -translate-y-2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 transition active:scale-95"
          >
            <HugeiconsIcon icon={PlusSignIcon} className="size-6" />
          </SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-2xl">
            <SheetHeader>
              <SheetTitle>Quick add</SheetTitle>
            </SheetHeader>

            <MobileQuickAdd onDone={() => setAddOpen(false)} />

            <div className="mt-1 grid grid-cols-2 gap-1 border-t border-border/60 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
              {QUICK_ADD.map((a) => (
                <SheetClose asChild key={a.href}>
                  <Link
                    href={a.href}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:bg-muted"
                  >
                    <HugeiconsIcon icon={a.icon} className="size-4 text-muted-foreground" />
                    {a.label}
                  </Link>
                </SheetClose>
              ))}
            </div>
          </SheetContent>
        </Sheet>

        <NavLink item={PRIMARY[2]!} active={isActive(PRIMARY[2]!.href)} />

        <Sheet>
          <SheetTrigger
            aria-label="More"
            className="flex flex-col items-center justify-center gap-0.5 text-muted-foreground"
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} className="size-5" />
            <span className="text-[10px] font-medium">More</span>
          </SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-2xl">
            <SheetHeader>
              <SheetTitle>More</SheetTitle>
            </SheetHeader>
            <div className="grid grid-cols-2 gap-1 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
              {MORE.map((item) => (
                <SheetClose asChild key={item.href}>
                  <Link
                    href={item.href}
                    className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm hover:bg-muted ${
                      isActive(item.href) ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    <HugeiconsIcon icon={item.icon} className="size-5" />
                    {item.title}
                  </Link>
                </SheetClose>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  );
}

function NavLink({
  item,
  active,
}: {
  item: { title: string; href: string; icon: IconType };
  active: boolean;
}) {
  return (
    <Link
      href={item.href}
      className={`flex flex-col items-center justify-center gap-0.5 ${
        active ? "text-primary" : "text-muted-foreground"
      }`}
    >
      <HugeiconsIcon icon={item.icon} className="size-5" />
      <span className="text-[10px] font-medium">{item.title}</span>
    </Link>
  );
}
