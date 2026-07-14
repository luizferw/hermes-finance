"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { BrandInitial, BrandWordmark } from "@/components/brand";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NAV_SECTIONS, findNavLocation } from "./nav";
import { UserMenu } from "./user-menu";

interface AppSidebarProps {
  user: { name: string; email: string };
  inboxCount: number;
}

/**
 * "The Ledger Spine" — nav reads like the bound margin of a ledger. The active
 * page lifts forward as a crisp white card-page with a fern index-tab, and that
 * single surface physically glides between entries on navigation (measured +
 * transform-animated). Hover paints a quiet tonal wash; collapsed mode keeps
 * the spine, the tab, and tooltips.
 */
export function AppSidebar({ user, inboxCount }: AppSidebarProps) {
  const pathname = usePathname();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-0">
        <div
          className={cn(
            "flex h-14 items-center px-4",
            collapsed ? "justify-center px-0" : "gap-2",
          )}
        >
          <Link
            href="/overview"
            aria-label="Kosh overview"
            onClick={() => setOpenMobile(false)}
            className="rounded-md px-1 outline-none ring-sidebar-ring transition-opacity duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:opacity-70 focus-visible:ring-2"
          >
            {collapsed ? <BrandInitial /> : <BrandWordmark />}
          </Link>
          {/* Mobile gets an explicit close; the desktop collapse/expand lives in
              the masthead (and the rail), so the spine header stays uncluttered. */}
          {!collapsed && isMobile && (
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setOpenMobile(false)}
              className="ml-auto flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-[color,background-color,transform] duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:scale-[0.93]"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-[18px]" strokeWidth={1.9} />
            </button>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent id="app-sidebar-nav" className="gap-0 px-2.5 py-1">
        <SpineNav
          pathname={pathname}
          collapsed={collapsed}
          inboxCount={inboxCount}
          onNavigate={() => setOpenMobile(false)}
          // Re-measure the gliding page when the collapse state changes (group
          // labels swap for dividers, shifting row offsets).
          relayoutKey={String(collapsed)}
        />
      </SidebarContent>

      <SidebarFooter className="border-t border-border/70 p-2">
        <UserMenu user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function SpineNav({
  pathname,
  collapsed,
  inboxCount,
  onNavigate,
  relayoutKey,
}: {
  pathname: string;
  collapsed: boolean;
  inboxCount: number;
  onNavigate: () => void;
  relayoutKey: string;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const [top, setTop] = React.useState<number | null>(null);

  // Longest-prefix match: `/plan/goals` resolves to Goals, not the `/plan`
  // Horizon item, so exactly one row is ever active.
  const activeHref = findNavLocation(pathname).item?.href;

  // Measure only the active row's offset — every row is the same height, so the
  // lifted "page" is a fixed-height surface that just translates between rows
  // (transform-only = composited, no layout/paint cost per frame). Runs after
  // paint; a ResizeObserver keeps it aligned through font load and width change.
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const el = list.querySelector<HTMLElement>('[data-active="true"]');
      setTop(el ? el.offsetTop : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [pathname, relayoutKey]);

  return (
    <div ref={listRef} className="relative">
      {/* The lifted page — a single shared surface that glides to the active row. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-0 h-9 rounded-lg bg-card ring-1 ring-foreground/[0.08] transition-[transform,opacity] duration-[var(--duration-spatial)] ease-[var(--ease-out-expo)] will-change-transform",
          top === null ? "opacity-0" : "opacity-100",
        )}
        style={{ transform: `translateY(${top ?? 0}px)` }}
      >
        {/* Fern index-tab on the spine. */}
        <span className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
      </div>

      {NAV_SECTIONS.map((section, idx) => (
        <div key={section.label ?? idx} className={cn(idx > 0 && "mt-5")}>
          {section.label &&
            (collapsed ? (
              <div
                aria-hidden
                className="mx-auto mb-1 h-px w-5 bg-sidebar-border/80"
              />
            ) : (
              <div className="flex items-center gap-2 px-2.5 pb-1.5">
                <span className="micro-label">{section.label}</span>
                <span className="h-px flex-1 bg-sidebar-border/60" />
              </div>
            ))}

          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const isActive = item.href === activeHref;
              const showBadge = item.showInboxBadge && inboxCount > 0;

              const row = (
                <Link
                  href={item.href}
                  data-active={isActive}
                  onClick={onNavigate}
                  className={cn(
                    "group/row relative z-10 flex h-9 items-center gap-3 rounded-lg px-2.5 text-[0.8125rem] leading-none outline-none ring-sidebar-ring transition-colors duration-[var(--duration-state)] ease-[var(--ease-out-quint)] focus-visible:ring-2",
                    isActive
                      ? "font-medium text-foreground"
                      : "text-sidebar-foreground/70 hover:bg-foreground/[0.035] hover:text-foreground",
                    collapsed && "justify-center px-0",
                  )}
                >
                  <span className="relative shrink-0">
                    <HugeiconsIcon
                      icon={item.icon}
                      strokeWidth={isActive ? 2 : 1.7}
                      className={cn(
                        "size-[18px] transition-colors duration-[var(--duration-state)] ease-[var(--ease-out-quint)]",
                        isActive
                          ? "text-primary"
                          : "text-muted-foreground group-hover/row:text-foreground",
                      )}
                    />
                    {/* Collapsed: a fern dot stands in for the count badge. */}
                    {collapsed && showBadge && (
                      <span className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-primary ring-2 ring-sidebar" />
                    )}
                  </span>

                  {!collapsed && (
                    <span className="flex-1 truncate">{item.title}</span>
                  )}

                  {!collapsed && showBadge && (
                    <span className="font-amount rounded-full bg-primary/12 px-1.5 py-0.5 text-[0.6875rem] font-medium text-primary tabular-nums">
                      {inboxCount}
                    </span>
                  )}
                </Link>
              );

              if (!collapsed) return <React.Fragment key={item.href}>{row}</React.Fragment>;
              return (
                <Tooltip key={item.href} delayDuration={0}>
                  <TooltipTrigger asChild>{row}</TooltipTrigger>
                  <TooltipContent side="right" sideOffset={10}>
                    {item.title}
                    {showBadge ? ` · ${inboxCount}` : ""}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
