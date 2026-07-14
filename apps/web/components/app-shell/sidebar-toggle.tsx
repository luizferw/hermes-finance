"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * The Spine Control — the single, custom-drawn toggle that opens, closes,
 * collapses, and expands the sidebar. One glyph carries every state: a ledger
 * "panel" whose fern margin (the spine) physically widens when the nav is open
 * and shrinks to a sliver when it isn't, animated on the same exponential curve
 * as the real sidebar so the icon and the panel move as one system. Stroke is
 * pixel-snapped and `non-scaling-stroke`d, so the divider stays crisp at any
 * scale or density — never a blurred raster hamburger.
 *
 * Drives the desktop collapse/expand (`state`) and the mobile open/close
 * (`openMobile`), choosing label, ARIA, and glyph state from whichever applies.
 */
export function SidebarToggle({
  className,
  size = 32,
  tone = "muted",
}: {
  className?: string;
  /** Square hit-target in px. */
  size?: number;
  /** Resting icon color. */
  tone?: "muted" | "foreground";
}) {
  const { state, isMobile, openMobile, toggleSidebar } = useSidebar();
  const open = isMobile ? openMobile : state === "expanded";

  const label = isMobile
    ? open
      ? "Close menu"
      : "Open menu"
    : open
      ? "Collapse sidebar"
      : "Expand sidebar";

  const button = (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      aria-controls="app-sidebar-nav"
      data-open={open}
      onClick={toggleSidebar}
      style={{ width: size, height: size }}
      className={cn(
        "group/toggle relative inline-flex shrink-0 items-center justify-center rounded-[0.5rem] outline-none",
        tone === "muted" ? "text-muted-foreground" : "text-foreground",
        "transition-[color,background-color,transform] duration-[var(--duration-state)] ease-[var(--ease-out-quint)]",
        "hover:bg-foreground/[0.05] hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/60",
        "active:scale-[0.93] active:bg-foreground/[0.07]",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      <ToggleGlyph open={open} />
    </button>
  );

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        {label}
        {!isMobile && (
          <kbd
            data-slot="kbd"
            className="ml-0.5 flex h-4 items-center rounded-sm bg-background/15 px-1 font-amount text-[10px] tracking-normal"
          >
            ⌘B
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The glyph. A rounded ledger panel; inside, the fern spine margin and its
 * divider scale together on the X axis (origin pinned to the left edge), so the
 * margin grows from a thin closed sliver to the full open column. The divider
 * keeps a constant 1.75px stroke via `non-scaling-stroke` while it slides, and
 * a faint directional caret in the body fades in on hover to spell out the next
 * action without crowding the resting state.
 */
function ToggleGlyph({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="overflow-visible"
    >
      <rect x="3.25" y="4.25" width="17.5" height="15.5" rx="3" />

      {/* The spine margin + divider — scaled as one group, origin at the left
          edge, so it reads as the sidebar widening/narrowing in place. */}
      <g
        className="transition-transform duration-[var(--duration-spatial)] ease-[var(--ease-out-expo)]"
        style={{
          transform: open ? "scaleX(1)" : "scaleX(0.34)",
          transformOrigin: "3.25px 12px",
        }}
      >
        <path
          d="M9 4.25 H6.25 a3 3 0 0 0 -3 3 V16.75 a3 3 0 0 0 3 3 H9 Z"
          fill="var(--primary)"
          fillOpacity={open ? 0.2 : 0.32}
          stroke="none"
          className="transition-[fill-opacity] duration-[var(--duration-spatial)]"
        />
        <line
          x1="9"
          y1="4.5"
          x2="9"
          y2="19.5"
          vectorEffect="non-scaling-stroke"
        />
      </g>

      {/* Directional hint: points the way the panel will move on click. Resting
          at 0 opacity, surfacing only on hover/focus. */}
      <path
        d={open ? "M15.5 9.5 L13 12 L15.5 14.5" : "M13.5 9.5 L16 12 L13.5 14.5"}
        strokeWidth={1.6}
        className="opacity-0 transition-opacity duration-[var(--duration-state)] group-hover/toggle:opacity-55 group-focus-visible/toggle:opacity-55"
      />
    </svg>
  );
}
