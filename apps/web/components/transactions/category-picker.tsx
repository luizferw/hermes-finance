"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface CategoryOption {
  id: string;
  name: string;
  color: string | null;
}

/** Searchable category picker used in the inbox, drawers, and forms. */
export function CategoryPicker({
  categories,
  value,
  onSelect,
  trigger,
  align = "end",
}: {
  categories: CategoryOption[];
  value?: string | null;
  onSelect: (categoryId: string | null) => void;
  trigger: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-60 p-0" align={align}>
        <Command>
          <CommandInput placeholder="Search categories…" />
          <CommandList>
            <CommandEmpty>No category found.</CommandEmpty>
            <CommandGroup>
              {categories.map((category) => (
                <CommandItem
                  key={category.id}
                  value={category.name}
                  onSelect={() => {
                    onSelect(category.id === value ? null : category.id);
                    setOpen(false);
                  }}
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: category.color ?? "var(--muted-foreground)" }}
                  />
                  {category.name}
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    className={cn(
                      "ml-auto size-4",
                      value === category.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Small outline button trigger for the picker. */
export function CategoryPickerButton({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <Button variant="outline" size="sm" className={cn("h-7 text-xs", className)}>
      {label}
    </Button>
  );
}
