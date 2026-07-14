"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Logout01Icon,
  Moon02Icon,
  PaintBoardIcon,
  Settings01Icon,
  Sun01Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";

export function UserMenu({ user }: { user: { name: string; email: string } }) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;
  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "group/user flex w-full items-center gap-3 rounded-lg p-1.5 text-left outline-none ring-sidebar-ring transition-colors duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:bg-foreground/[0.04] focus-visible:ring-2 data-[state=open]:bg-foreground/[0.05]",
            collapsed && "justify-center p-1",
          )}
        >
          <Avatar className="size-8 shrink-0 rounded-lg ring-1 ring-primary/15">
            <AvatarFallback className="rounded-lg bg-primary/12 text-xs font-semibold text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <>
              <span className="flex min-w-0 flex-col text-left leading-tight">
                <span className="truncate text-[0.8125rem] font-medium text-foreground">
                  {user.name}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </span>
              <HugeiconsIcon
                icon={UnfoldMoreIcon}
                className="ml-auto size-4 shrink-0 text-muted-foreground transition-colors group-hover/user:text-foreground"
                strokeWidth={1.8}
              />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-60"
      >
        <DropdownMenuLabel className="flex items-center gap-2.5 py-2">
          <Avatar className="size-8 shrink-0 rounded-lg ring-1 ring-primary/15">
            <AvatarFallback className="rounded-lg bg-primary/12 text-xs font-semibold text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[0.8125rem] font-medium text-foreground">
              {user.name}
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {user.email}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <HugeiconsIcon icon={Settings01Icon} /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <HugeiconsIcon icon={PaintBoardIcon} className="mr-2 size-4" />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <HugeiconsIcon icon={Sun01Icon} /> Light
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <HugeiconsIcon icon={Moon02Icon} /> Dark
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>
              System
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={async () => {
            await signOut();
            router.push("/login");
            router.refresh();
          }}
        >
          <HugeiconsIcon icon={Logout01Icon} /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
