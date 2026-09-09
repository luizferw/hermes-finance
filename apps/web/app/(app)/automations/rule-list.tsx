"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreVerticalIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { deleteRule, runRule, setRuleActive } from "@/modules/rules/mutations";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditRuleDialog } from "./edit-rule-dialog";

export interface RuleRow {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  runOnImport: boolean;
  matchAll: boolean;
  conditions: Array<{ field: string; value: string }>;
  actions: Array<{ type: string; value: string | null }>;
  lastRun: {
    matchedCount: number;
    appliedCount: number;
    error: string | null;
    startedAt: string;
  } | null;
}

export function RuleList({
  rules,
  accounts,
  categories,
  tags,
  currencyCode,
}: {
  rules: RuleRow[];
  accounts: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  currencyCode: string;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  function act(id: string, action: () => Promise<unknown>, message: string) {
    setBusyId(id);
    startTransition(async () => {
      try {
        await action();
        toast.success(message);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <ul className="divide-y divide-dashed">
        {rules.map((rule) => (
          <li
            key={rule.id}
            className={cn("flex items-center gap-3 px-4 py-3", !rule.isActive && "opacity-60")}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate font-medium">{rule.name}</p>
                <Badge variant={rule.isActive ? "secondary" : "outline"}>
                  {rule.isActive ? "Active" : "Paused"}
                </Badge>
                {rule.runOnImport && (
                  <Badge className="bg-primary/10 text-primary">On import</Badge>
                )}
              </div>
              {rule.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {rule.description}
                </p>
              )}
              <p className="mt-1 truncate text-xs text-muted-foreground">
                When{" "}
                {rule.conditions
                  .map(formatCondition)
                  .join(rule.matchAll ? " and " : " or ")}{" "}
                - then{" "}
                {rule.actions.map(formatAction).join(", ")}
              </p>
              {rule.lastRun && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Last run: {rule.lastRun.matchedCount} matched,{" "}
                  {rule.lastRun.appliedCount} changed
                  {rule.lastRun.error && (
                    <span className="text-destructive"> - {rule.lastRun.error}</span>
                  )}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={isPending && busyId === rule.id}
              onClick={() =>
                act(rule.id, () => runRule(rule.id), `${rule.name} finished`)
              }
            >
              <HugeiconsIcon icon={PlayIcon} />
              Run
            </Button>
            <EditRuleDialog
              rule={rule}
              accounts={accounts}
              categories={categories}
              tags={tags}
              currencyCode={currencyCode}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={isPending && busyId === rule.id}
                >
                  <HugeiconsIcon icon={MoreVerticalIcon} />
                  <span className="sr-only">Rule actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() =>
                    act(
                      rule.id,
                      () => setRuleActive(rule.id, !rule.isActive),
                      rule.isActive ? "Rule paused" : "Rule resumed",
                    )
                  }
                >
                  {rule.isActive ? "Pause" : "Resume"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => act(rule.id, () => deleteRule(rule.id), "Rule deleted")}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatCondition(condition: { field: string; value: string }) {
  return `${condition.field.replaceAll("_", " ")} "${condition.value}"`;
}

function formatAction(action: { type: string; value: string | null }) {
  return action.value
    ? `${action.type.replaceAll("_", " ")} "${action.value}"`
    : action.type.replaceAll("_", " ");
}
