"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { InboxIcon } from "@hugeicons/core-free-icons";
import { CommandMenuTrigger } from "@/components/command-menu/command-menu";
import { SidebarToggle } from "./sidebar-toggle";
import { useInboxCount } from "./chrome-context";
import { cn } from "@/lib/utils";
import { findNavLocation } from "./nav";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Right-aligned actions (buttons, filters). */
  children?: React.ReactNode;
}

/**
 * The Ledger Masthead — the running head of the page, set flush against the
 * sidebar spine. Reading left to right: the Spine Control (the one custom
 * toggle), then a folio path that resolves the route to Home › Section › Page
 * with the current leaf inked and a fern locator tab echoing the sidebar's
 * active marker. The right rail carries the always-reachable review indicator,
 * command access, and this page's own actions — each group hairline-divided so
 * the bar reads as composed zones, not a tray of loose controls. Solid surface
 * (no backdrop blur) keeps the sticky head crisp through scroll.
 */
export function PageHeader({ title, description, children }: PageHeaderProps) {
  const pathname = usePathname();
  const { sectionLabel, item } = findNavLocation(pathname);
  const atRoot = item?.href === "/overview";

  return (
    <header className="sticky top-0 z-20 border-b border-border/70 bg-background">
      <div className="flex h-14 items-center gap-2 px-2.5 md:gap-3 md:px-4">
        <SidebarToggle className="-ml-0.5" />
        <Divider className="hidden md:block" />

        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-2"
        >
          {!atRoot && (
            <>
              <HomeCrumb />
              {sectionLabel && (
                <>
                  <Chevron />
                  <span className="hidden shrink-0 text-[0.8125rem] text-muted-foreground lg:inline">
                    {sectionLabel}
                  </span>
                </>
              )}
              <Chevron className="hidden sm:inline" />
            </>
          )}

          <span className="flex min-w-0 items-center gap-2">
            {/* Fern locator tab — the same index-tab language as the active row
                in the sidebar spine, marking "you are here" in the masthead. */}
            <span
              aria-hidden
              className="h-4 w-[3px] shrink-0 rounded-full bg-primary"
            />
            <h1 className="min-w-0 shrink truncate text-[0.9375rem] leading-none font-semibold tracking-[-0.01em] text-foreground">
              {title}
            </h1>
          </span>

          {description && (
            <>
              <Divider className="hidden xl:block" />
              <p className="hidden truncate text-xs text-muted-foreground xl:block">
                {description}
              </p>
            </>
          )}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 md:gap-2.5">
          <InboxIndicator />
          <CommandMenuTrigger />
          {children && (
            <>
              <Divider />
              <div className="flex items-center gap-2">{children}</div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/** Home/Overview anchor — crisp custom roofline, fern on interaction. */
function HomeCrumb() {
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <Link
          href="/overview"
          aria-label="Overview"
          className="hidden size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 outline-none transition-[color,background-color] duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:bg-foreground/[0.05] hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60 sm:flex"
        >
          <svg
            viewBox="0 0 24 24"
            width={17}
            height={17}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 10.5 L12 4 L20 10.5" />
            <path d="M5.75 9.25 V19 a1 1 0 0 0 1 1 H17.25 a1 1 0 0 0 1 -1 V9.25" />
          </svg>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        Overview
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Review indicator — the masthead's "notifications". Surfaces the inbox queue
 * everywhere (sidebar collapsed, on any page), but only when there's something
 * to review and you're not already in the Inbox. The fern count is the signal;
 * absence is the resting state.
 */
function InboxIndicator() {
  const count = useInboxCount();
  const pathname = usePathname();
  const onInbox = pathname === "/inbox" || pathname.startsWith("/inbox/");

  if (count <= 0 || onInbox) return null;

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <Link
          href="/inbox"
          aria-label={`Review ${count} in inbox`}
          className="group/inbox relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-[color,background-color] duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <HugeiconsIcon icon={InboxIcon} className="size-[18px]" strokeWidth={1.8} />
          <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 font-amount text-[10px] leading-[15px] font-medium text-primary-foreground tabular-nums ring-2 ring-background">
            {count > 99 ? "99+" : count}
          </span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        Review {count} in inbox
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Tier-2 ledger strip. Sticks flush under the 56px masthead (`top-14`) and
 * carries page context — counts, period, totals on the left; contextual
 * controls (search, filters, actions) on the right. Solid surface, no blur, so
 * two stacked sticky bars stay smooth on scroll. Render it as the first child
 * of a page's body (full-bleed, not inside the padded `<main>`).
 */
export function PageHeaderStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-14 z-10 flex h-12 items-center gap-2.5 border-b border-border/70 bg-background px-4 md:px-6">
      {children}
    </div>
  );
}

/** A ledger stat for the strip — value set in mono tabular, label muted. */
export function StripStat({
  value,
  label,
  accent,
}: {
  value: React.ReactNode;
  label: string;
  accent?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap text-xs">
      <span
        className={cn(
          "font-amount tabular-nums",
          accent ? "text-foreground" : "text-foreground/80",
        )}
      >
        {value}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/** Hairline vertical divider between header zones. */
function Divider({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("h-5 w-px shrink-0 bg-border/80", className)}
    />
  );
}

/** Hairline chevron separator. */
function Chevron({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={cn("size-3 shrink-0 text-muted-foreground/35", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
