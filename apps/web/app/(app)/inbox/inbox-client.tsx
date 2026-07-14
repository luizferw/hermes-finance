"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  InboxIcon,
  MagicWand01Icon,
  Tick02Icon,
  MultiplicationSignIcon,
} from "@hugeicons/core-free-icons";
import type { RuleSuggestion } from "@kosh/domain";
import {
  approveTransactions,
  bulkCategorize,
  rejectTransactions,
  restoreTransactions,
  updateTransaction,
} from "@/modules/transactions/mutations";
import { formatDate, formatDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { Amount } from "@/components/transactions/amount";
import { CategoryBadge } from "@/components/transactions/category-badge";
import { StatusBadge } from "@/components/transactions/status-badge";
import {
  CategoryPicker,
  type CategoryOption,
} from "@/components/transactions/category-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface InboxItem {
  id: string;
  description: string;
  rawDescription: string | null;
  narration: string | null;
  date: string;
  amountMinor: number;
  currencyCode: string;
  status: string;
  type: string;
  notes: string | null;
  upiReference: string | null;
  counterpartyUpiId: string | null;
  utrNumber: string | null;
  externalId: string | null;
  account: { id: string; name: string } | null;
  category: { id: string; name: string; icon: string | null; color: string | null } | null;
  suspectedDuplicateOf: {
    id: string;
    description: string;
    date: string;
    amountMinor: number;
  } | null;
  importFileName: string | null;
}

type TabKey = "all" | "uncategorized" | "duplicates" | "rejected";

export function InboxClient({
  items,
  rejected,
  categories,
  suggestions,
}: {
  items: InboxItem[];
  rejected: InboxItem[];
  categories: CategoryOption[];
  suggestions: RuleSuggestion[];
}) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [tab, setTab] = React.useState<TabKey>("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [active, setActive] = React.useState<InboxItem | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const uncategorized = items.filter((i) => !i.category);
  const duplicates = items.filter((i) => i.suspectedDuplicateOf);
  const visible =
    tab === "all"
      ? items
      : tab === "uncategorized"
        ? uncategorized
        : tab === "duplicates"
          ? duplicates
          : rejected;

  const allVisibleSelected =
    visible.length > 0 && visible.every((i) => selected.has(i.id));

  function toggleAll() {
    setSelected((prev) => {
      if (allVisibleSelected) return new Set();
      const next = new Set(prev);
      visible.forEach((i) => next.add(i.id));
      return next;
    });
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function run(
    action: () => Promise<unknown>,
    successMessage: (result: unknown) => string,
  ) {
    startTransition(async () => {
      try {
        const result = await action();
        toast.success(successMessage(result));
        setSelected(new Set());
        setActive(null);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed");
      }
    });
  }

  const selectedIds = [...selected];

  return (
    <div className="space-y-4">
      {/* Rule suggestion banner */}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ledger bg-chart-4/5 px-3 py-2.5 text-sm">
          <HugeiconsIcon icon={MagicWand01Icon} className="size-4 text-chart-4" />
          <span className="text-muted-foreground">
            “{suggestions[0]!.token}” keeps showing up ({suggestions[0]!.occurrences}
            ×).
          </span>
          <Link
            href={`/automations?new=1&contains=${encodeURIComponent(suggestions[0]!.token)}${suggestions[0]!.suggestedCategoryId ? `&category=${suggestions[0]!.suggestedCategoryId}` : ""}`}
            className="font-medium text-primary hover:underline"
          >
            Create a rule →
          </Link>
        </div>
      )}

      {/* Tabs + bulk bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList>
            <TabsTrigger value="all">
              All <CountChip value={items.length} />
            </TabsTrigger>
            <TabsTrigger value="uncategorized">
              Needs category <CountChip value={uncategorized.length} />
            </TabsTrigger>
            <TabsTrigger value="duplicates">
              Duplicates <CountChip value={duplicates.length} />
            </TabsTrigger>
            <TabsTrigger value="rejected">Rejected</TabsTrigger>
          </TabsList>
        </Tabs>

        {selectedIds.length > 0 && tab !== "rejected" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {selectedIds.length} selected
            </span>
            <CategoryPicker
              categories={categories}
              onSelect={(categoryId) => {
                if (!categoryId) return;
                run(
                  () => bulkCategorize({ ids: selectedIds, categoryId }),
                  () => `Categorized ${selectedIds.length} transactions`,
                );
              }}
              trigger={
                <Button variant="outline" size="sm" disabled={isPending}>
                  Set category
                </Button>
              }
            />
            <Button
              size="sm"
              disabled={isPending}
              onClick={() =>
                run(
                  () => approveTransactions({ ids: selectedIds }),
                  () => `Approved ${selectedIds.length} transactions`,
                )
              }
            >
              {isPending ? <Spinner /> : <HugeiconsIcon icon={Tick02Icon} />}
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              className="text-destructive hover:text-destructive"
              onClick={() =>
                run(
                  () => rejectTransactions({ ids: selectedIds }),
                  () => `Rejected ${selectedIds.length} transactions`,
                )
              }
            >
              <HugeiconsIcon icon={MultiplicationSignIcon} />
              Reject
            </Button>
          </div>
        )}
        {selectedIds.length > 0 && tab === "rejected" && (
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() =>
              run(
                () => restoreTransactions({ ids: selectedIds }),
                () => `Restored ${selectedIds.length} to inbox`,
              )
            }
          >
            Restore to inbox
          </Button>
        )}
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={InboxIcon} />
            </EmptyMedia>
            <EmptyTitle>
              {tab === "rejected" ? "Nothing rejected" : "Inbox zero"}
            </EmptyTitle>
            <EmptyDescription>
              {tab === "rejected"
                ? "Rejected transactions land here for 30 days."
                : "Imported and recurring transactions wait here for review. Import a CSV to fill it up."}
            </EmptyDescription>
          </EmptyHeader>
          {tab !== "rejected" && (
            <Button asChild variant="outline" size="sm">
              <Link href="/transactions/import">Import CSV</Link>
            </Button>
          )}
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {/* Desktop header row */}
          <div className="hidden items-center gap-3 border-b border-ledger px-4 py-2 md:flex">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={toggleAll}
              aria-label="Select all"
            />
            <span className="micro-label flex-1">Description</span>
            <span className="micro-label w-28">Account</span>
            <span className="micro-label w-20">Date</span>
            <span className="micro-label w-36">Category</span>
            <span className="micro-label w-24 text-right">Amount</span>
          </div>
          <ul className="divide-y divide-dashed">
            {visible.map((item) => (
              <li
                key={item.id}
                className={cn(
                  "flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/50 md:items-center",
                  selected.has(item.id) && "bg-accent/40",
                )}
                onClick={() => setActive(item)}
              >
                <span
                  onClick={(e) => e.stopPropagation()}
                  className="pt-0.5 md:pt-0"
                >
                  <Checkbox
                    checked={selected.has(item.id)}
                    onCheckedChange={() => toggle(item.id)}
                    aria-label={`Select ${item.description}`}
                  />
                </span>

                {/* Mobile: stacked card; desktop: row */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {item.description}
                    </p>
                    {item.suspectedDuplicateOf && (
                      <Badge className="shrink-0 gap-1 border-transparent bg-warning/15 text-warning-foreground dark:text-warning">
                        <HugeiconsIcon icon={Copy01Icon} className="size-3" />
                        duplicate?
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-amount text-xs text-muted-foreground">
                    {item.rawDescription ?? item.notes ?? "—"}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2 md:hidden">
                    <span className="text-xs text-muted-foreground">
                      {formatDateShort(item.date)} · {item.account?.name}
                    </span>
                    <CategoryBadge
                      category={item.category}
                      className="px-1.5 py-0 text-[10px]"
                    />
                  </div>
                </div>

                <span className="hidden w-28 truncate text-xs text-muted-foreground md:block">
                  {item.account?.name}
                </span>
                <span className="hidden w-20 text-xs text-muted-foreground md:block">
                  {formatDateShort(item.date)}
                </span>
                <span
                  className="hidden w-36 md:block"
                  onClick={(e) => e.stopPropagation()}
                >
                  <CategoryPicker
                    categories={categories}
                    value={item.category?.id}
                    onSelect={(categoryId) =>
                      run(
                        () => updateTransaction(item.id, { categoryId }),
                        () => "Category updated",
                      )
                    }
                    trigger={
                      <button type="button" className="text-left">
                        <CategoryBadge category={item.category} />
                      </button>
                    }
                  />
                </span>
                <span className="w-24 text-right">
                  <Amount
                    amountMinor={item.amountMinor}
                    currencyCode={item.currencyCode}
                    className="text-sm"
                  />
                  <span className="mt-0.5 block md:hidden">
                    <StatusBadge status={item.status} className="text-[10px]" />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Detail drawer */}
      <Sheet open={!!active} onOpenChange={(open) => !open && setActive(null)}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={cn(
            "overflow-y-auto",
            isMobile ? "max-h-[85vh] rounded-t-xl" : "sm:max-w-md",
          )}
        >
          {active && (
            <>
              <SheetHeader>
                <SheetTitle className="pr-8 text-base">
                  {active.description}
                </SheetTitle>
                <SheetDescription className="flex items-center gap-2">
                  <StatusBadge status={active.status} />
                  <span>{formatDate(active.date)}</span>
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-5 px-4 pb-6">
                <p>
                  <Amount
                    amountMinor={active.amountMinor}
                    currencyCode={active.currencyCode}
                    className="text-3xl font-medium"
                  />
                </p>

                {active.suspectedDuplicateOf && (
                  <div className="rounded-lg border border-warning/40 bg-warning/8 p-3 text-sm">
                    <p className="flex items-center gap-1.5 font-medium">
                      <HugeiconsIcon icon={Copy01Icon} className="size-4" />
                      Possible duplicate
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      Matches “{active.suspectedDuplicateOf.description}” on{" "}
                      {formatDate(active.suspectedDuplicateOf.date)}. Reject this
                      one if it is the same transaction.
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <p className="micro-label">Category</p>
                  <CategoryPicker
                    categories={categories}
                    value={active.category?.id}
                    align="start"
                    onSelect={(categoryId) =>
                      run(
                        () => updateTransaction(active.id, { categoryId }),
                        () => "Category updated",
                      )
                    }
                    trigger={
                      <button type="button">
                        <CategoryBadge category={active.category} />
                      </button>
                    }
                  />
                </div>

                <Separator className="border-ledger" />

                <dl className="space-y-2.5 text-sm">
                  <DetailRow label="Account" value={active.account?.name} />
                  <DetailRow
                    label="Raw description"
                    value={active.rawDescription}
                    mono
                  />
                  <DetailRow label="Narration" value={active.narration} mono />
                  <DetailRow label="UPI ref" value={active.upiReference} mono />
                  <DetailRow
                    label="Counterparty UPI"
                    value={active.counterpartyUpiId}
                    mono
                  />
                  <DetailRow label="UTR" value={active.utrNumber} mono />
                  <DetailRow label="External ID" value={active.externalId} mono />
                  <DetailRow
                    label="Source"
                    value={
                      active.importFileName
                        ? `Imported from ${active.importFileName}`
                        : active.status === "pending"
                          ? "Generated from a recurring template"
                          : "Manual entry"
                    }
                  />
                </dl>

                {active.status !== "rejected" ? (
                  <div className="flex gap-2 pt-2">
                    <Button
                      className="flex-1"
                      disabled={isPending}
                      onClick={() =>
                        run(
                          () => approveTransactions({ ids: [active.id] }),
                          () => "Approved",
                        )
                      }
                    >
                      {isPending ? <Spinner /> : <HugeiconsIcon icon={Tick02Icon} />}
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1 text-destructive hover:text-destructive"
                      disabled={isPending}
                      onClick={() =>
                        run(
                          () => rejectTransactions({ ids: [active.id] }),
                          () => "Rejected",
                        )
                      }
                    >
                      <HugeiconsIcon icon={MultiplicationSignIcon} />
                      Reject
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={isPending}
                    onClick={() =>
                      run(
                        () => restoreTransactions({ ids: [active.id] }),
                        () => "Restored to inbox",
                      )
                    }
                  >
                    Restore to inbox
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function CountChip({ value }: { value: number }) {
  return (
    <span className="ml-1.5 rounded-full bg-muted px-1.5 font-amount text-[10px] text-muted-foreground">
      {value}
    </span>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("text-right break-all", mono && "font-amount text-xs")}>
        {value}
      </dd>
    </div>
  );
}
