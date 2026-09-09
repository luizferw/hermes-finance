"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Download04Icon,
  FilterIcon,
  PlusSignIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { minorToMajor } from "@kosh/domain";
import {
  approveTransactions,
  deleteTransaction,
  updateTransaction,
} from "@/modules/transactions/mutations";
import { formatDate, formatDateCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { Amount } from "@/components/transactions/amount";
import { CategoryBadge } from "@/components/transactions/category-badge";
import { StatusBadge } from "@/components/transactions/status-badge";
import {
  CategoryPicker,
  type CategoryOption,
} from "@/components/transactions/category-picker";
import { NewTransactionDialog } from "./new-transaction-dialog";
import { PageHeaderStrip, StripStat } from "@/components/app-shell/page-header";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

export interface AccountOption {
  id: string;
  name: string;
  currencyCode: string;
}

interface TxRow {
  id: string;
  date: string;
  description: string;
  merchant: string | null;
  rawDescription: string | null;
  notes: string | null;
  amountMinor: number;
  currencyCode: string;
  type: string;
  status: string;
  account: { id: string; name: string } | null;
  transferAccount: { id: string; name: string } | null;
  category: { id: string; name: string; icon: string | null; color: string | null } | null;
  transactionTags: Array<{ tag: { id: string; name: string } }>;
}

interface Filters {
  q: string;
  accountId: string;
  categoryId: string;
  status: string;
  type: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  q: "",
  accountId: "",
  categoryId: "",
  status: "",
  type: "",
  from: "",
  to: "",
};

const PAGE_SIZE = 50;

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

export function TransactionsClient({
  accounts,
  categories,
  tags,
  initialNewOpen,
  initialStatus,
  initialFocusId,
}: {
  accounts: AccountOption[];
  categories: CategoryOption[];
  tags: Array<{ id: string; name: string }>;
  initialNewOpen: boolean;
  initialStatus?: string;
  initialFocusId?: string;
}) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [filters, setFilters] = React.useState<Filters>({
    ...EMPTY_FILTERS,
    status: initialStatus ?? "",
  });
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  // Deep link from the command menu (?focus=<id>) opens that transaction.
  const [activeId, setActiveId] = React.useState<string | null>(initialFocusId ?? null);
  const [newOpen, setNewOpen] = React.useState(initialNewOpen);
  const [showFilters, setShowFilters] = React.useState(false);
  const debouncedQ = useDebounced(filters.q);

  const queryParams = React.useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (filters.accountId) params.set("accountId", filters.accountId);
    if (filters.categoryId) params.set("categoryId", filters.categoryId);
    if (filters.status) params.set("status", filters.status);
    if (filters.type) params.set("type", filters.type);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    return params.toString();
  }, [debouncedQ, filters, page]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["transactions", queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/transactions?${queryParams}`);
      if (!res.ok) throw new Error("Failed to load transactions");
      const json = (await res.json()) as {
        data: { items: TxRow[]; total: number; page: number; pageSize: number };
      };
      return json.data;
    },
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = queryParams !== `page=${page}&pageSize=${PAGE_SIZE}`;

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
    setSelected(new Set());
  }

  const [categoryBusyId, setCategoryBusyId] = React.useState<string | null>(null);

  /**
   * Recategorizing is the one edit worth doing without leaving the table — it
   * is what a review pass is made of. Every other field still opens the drawer.
   */
  function setCategory(id: string, categoryId: string | null) {
    setCategoryBusyId(id);
    void (async () => {
      try {
        await updateTransaction(id, { categoryId });
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not change the category");
      } finally {
        setCategoryBusyId(null);
      }
    })();
  }

  function exportSelected() {
    const rows = items.filter((i) => selected.has(i.id));
    if (rows.length === 0) return;
    const header = "date,description,merchant,category,account,type,status,amount,currency";
    const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [
        r.date,
        escape(r.description),
        escape(r.merchant ?? ""),
        escape(r.category?.name ?? ""),
        escape(r.account?.name ?? ""),
        r.type,
        r.status,
        minorToMajor(r.amountMinor, r.currencyCode).toFixed(2),
        r.currencyCode,
      ].join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kosh-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} transactions`);
  }

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));

  return (
    <>
      <PageHeaderStrip>
        {/* Ledger context — hidden on mobile, shown in the pagination footer. */}
        <div className="hidden shrink-0 items-center gap-2.5 sm:flex">
          <StripStat
            value={total.toLocaleString()}
            label={total === 1 ? "entry" : "entries"}
            accent
          />
          {hasFilters && (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-primary">
              <span className="size-1.5 rounded-full bg-primary" />
              filtered
            </span>
          )}
        </div>

        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <HugeiconsIcon
            icon={Search01Icon}
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={filters.q}
            onChange={(e) => setFilter("q", e.target.value)}
            placeholder="Filter transactions…"
            className="h-8 pl-8"
            aria-label="Filter transactions"
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 shrink-0", showFilters && "bg-accent")}
          onClick={() => setShowFilters((s) => !s)}
        >
          <HugeiconsIcon icon={FilterIcon} />
          <span className="hidden sm:inline">Filters</span>
          {hasFilters && <span className="size-1.5 rounded-full bg-primary" />}
        </Button>
        {selected.size > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="pop-in h-8 shrink-0"
            onClick={exportSelected}
          >
            <HugeiconsIcon icon={Download04Icon} />
            <span className="hidden sm:inline">Export {selected.size}</span>
            <span className="sm:hidden">{selected.size}</span>
          </Button>
        )}
        <Button
          size="sm"
          className="h-8 shrink-0"
          onClick={() => setNewOpen(true)}
        >
          <HugeiconsIcon icon={PlusSignIcon} />
          <span className="hidden sm:inline">New transaction</span>
          <span className="sm:hidden">New</span>
        </Button>
      </PageHeaderStrip>

      <div className="space-y-4 p-4 md:p-6">
      {/* Filter row */}
      {showFilters && (
        <div className="panel-in grid grid-cols-2 gap-2 rounded-lg border border-ledger bg-muted/30 p-3 sm:grid-cols-3 lg:grid-cols-6">
          <FilterSelect
            placeholder="Account"
            value={filters.accountId}
            onChange={(v) => setFilter("accountId", v)}
            options={accounts.map((a) => ({ value: a.id, label: a.name }))}
          />
          <FilterSelect
            placeholder="Category"
            value={filters.categoryId}
            onChange={(v) => setFilter("categoryId", v)}
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
          />
          <FilterSelect
            placeholder="Status"
            value={filters.status}
            onChange={(v) => setFilter("status", v)}
            options={[
              { value: "posted", label: "Posted" },
              { value: "reviewed", label: "Reviewed" },
              { value: "imported", label: "Needs review" },
              { value: "pending", label: "Draft" },
              { value: "rejected", label: "Rejected" },
            ]}
          />
          <FilterSelect
            placeholder="Type"
            value={filters.type}
            onChange={(v) => setFilter("type", v)}
            options={[
              { value: "expense", label: "Expense" },
              { value: "income", label: "Income" },
              { value: "transfer", label: "Transfer" },
            ]}
          />
          <Input
            type="date"
            value={filters.from}
            onChange={(e) => setFilter("from", e.target.value)}
            aria-label="From date"
          />
          <Input
            type="date"
            value={filters.to}
            onChange={(e) => setFilter("to", e.target.value)}
            aria-label="To date"
          />
        </div>
      )}

      {/* Table / cards */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyTitle>Couldn’t load transactions</EmptyTitle>
            <EmptyDescription>Check your connection and try again.</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </Empty>
      ) : items.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Search01Icon} />
            </EmptyMedia>
            <EmptyTitle>
              {hasFilters ? "Nothing matches these filters" : "No transactions yet"}
            </EmptyTitle>
            <EmptyDescription>
              {hasFilters
                ? "Try widening the date range or clearing filters."
                : "Add a transaction or import a bank statement to get started."}
            </EmptyDescription>
          </EmptyHeader>
          {hasFilters ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          ) : (
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <HugeiconsIcon icon={PlusSignIcon} /> New transaction
            </Button>
          )}
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="hidden items-center gap-3 border-b border-ledger px-4 py-2 md:flex">
            <Checkbox
              checked={allSelected}
              onCheckedChange={() =>
                setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))
              }
              aria-label="Select page"
            />
            <span className="micro-label w-24">Date</span>
            <span className="micro-label flex-1">Description</span>
            <span className="micro-label w-36">Category</span>
            <span className="micro-label w-28">Account</span>
            <span className="micro-label w-24">Status</span>
            <span className="micro-label w-28 text-right">Amount</span>
          </div>
          <ul className="divide-y divide-dashed">
            {items.map((tx, i) => (
              <li
                key={tx.id}
                style={{ "--i": i } as React.CSSProperties}
                className={cn(
                  "row-in flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors duration-150 ease-[var(--ease-out-quint)] hover:bg-accent/50 active:bg-accent/60 md:items-center md:py-2.5",
                  selected.has(tx.id) && "bg-accent/40",
                )}
                onClick={() => setActiveId(tx.id)}
              >
                <span onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selected.has(tx.id)}
                    onCheckedChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(tx.id)) next.delete(tx.id);
                        else next.add(tx.id);
                        return next;
                      })
                    }
                    aria-label={`Select ${tx.description}`}
                  />
                </span>
                <span className="hidden w-24 font-amount text-xs text-muted-foreground md:block">
                  {formatDateCompact(tx.date)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {tx.merchant ?? tx.description}
                    {tx.type === "transfer" && tx.transferAccount && (
                      <span className="text-muted-foreground">
                        {" "}
                        → {tx.transferAccount.name}
                      </span>
                    )}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2 md:hidden">
                    <span className="font-amount text-xs text-muted-foreground">
                      {formatDateCompact(tx.date)}
                    </span>
                    <span onClick={(e) => e.stopPropagation()}>
                      <CategoryPicker
                        categories={categories}
                        value={tx.category?.id}
                        align="start"
                        onSelect={(categoryId) => setCategory(tx.id, categoryId)}
                        trigger={
                          <button
                            type="button"
                            disabled={categoryBusyId === tx.id}
                            aria-label={`Change the category of ${tx.description}`}
                            className="rounded-md outline-none disabled:opacity-50"
                          >
                            <CategoryBadge
                              category={tx.category}
                              className="px-1.5 py-0 text-[10px]"
                            />
                          </button>
                        }
                      />
                    </span>
                  </div>
                  {tx.transactionTags.length > 0 && (
                    <span className="mt-0.5 hidden gap-1 md:flex">
                      {tx.transactionTags.map(({ tag }) => (
                        <Badge
                          key={tag.id}
                          variant="outline"
                          className="px-1.5 py-0 text-[10px] text-muted-foreground"
                        >
                          #{tag.name}
                        </Badge>
                      ))}
                    </span>
                  )}
                </div>
                <span
                  className="hidden w-36 md:block"
                  onClick={(e) => e.stopPropagation()}
                >
                  <CategoryPicker
                    categories={categories}
                    value={tx.category?.id}
                    align="start"
                    onSelect={(categoryId) => setCategory(tx.id, categoryId)}
                    trigger={
                      <button
                        type="button"
                        disabled={categoryBusyId === tx.id}
                        aria-label={`Change the category of ${tx.description}`}
                        className="rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
                      >
                        <CategoryBadge category={tx.category} />
                      </button>
                    }
                  />
                </span>
                <span className="hidden w-28 truncate text-xs text-muted-foreground md:block">
                  {tx.account?.name}
                </span>
                <span className="hidden w-24 md:block">
                  <StatusBadge status={tx.status} />
                </span>
                <span className="w-28 text-right">
                  <Amount
                    amountMinor={tx.amountMinor}
                    currencyCode={tx.currencyCode}
                    className="text-sm"
                  />
                </span>
              </li>
            ))}
          </ul>
          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-ledger px-4 py-2.5 text-sm">
            <span className="text-xs text-muted-foreground">
              {total} transactions · page {page} of {pageCount}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
      </div>

      <TransactionDetailSheet
        transactionId={activeId}
        onClose={() => setActiveId(null)}
        categories={categories}
        isMobile={isMobile}
        onChanged={() => {
          refetch();
          router.refresh();
        }}
      />

      <NewTransactionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        accounts={accounts}
        categories={categories}
        tags={tags}
        onCreated={() => {
          refetch();
          router.refresh();
        }}
      />
    </>
  );
}

function FilterSelect({
  placeholder,
  value,
  onChange,
  options,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select
      value={value || "all"}
      onValueChange={(v) => onChange(v === "all" ? "" : v)}
    >
      <SelectTrigger className="w-full" aria-label={placeholder}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All {placeholder.toLowerCase()}s</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface TxDetail extends TxRow {
  valueDate: string | null;
  narration: string | null;
  upiReference: string | null;
  counterpartyUpiId: string | null;
  utrNumber: string | null;
  externalId: string | null;
  importFile: { id: string; fileName: string } | null;
  recurringTransaction: { id: string; name: string } | null;
  splits: Array<{
    id: string;
    amountMinor: number;
    description: string | null;
    category: { id: string; name: string; color: string | null } | null;
  }>;
  metadata: Array<{ id: string; key: string; value: string }>;
}

function TransactionDetailSheet({
  transactionId,
  onClose,
  categories,
  isMobile,
  onChanged,
}: {
  transactionId: string | null;
  onClose: () => void;
  categories: CategoryOption[];
  isMobile: boolean;
  onChanged: () => void;
}) {
  const [isPending, startTransition] = React.useTransition();
  const [notesDraft, setNotesDraft] = React.useState<string | null>(null);

  const { data: tx, refetch } = useQuery({
    queryKey: ["transaction", transactionId],
    enabled: !!transactionId,
    queryFn: async () => {
      const res = await fetch(`/api/transactions/${transactionId}`);
      if (!res.ok) throw new Error("Failed to load transaction");
      const json = (await res.json()) as { data: TxDetail };
      return json.data;
    },
  });

  function act(action: () => Promise<unknown>, message: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(message);
        refetch();
        onChanged();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed");
      }
    });
  }

  return (
    <Sheet open={!!transactionId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "overflow-y-auto",
          isMobile ? "max-h-[85vh] rounded-t-xl" : "sm:max-w-md",
        )}
      >
        {!tx ? (
          <div className="space-y-4 p-4">
            {/* Keep an accessible title present while loading (Radix requirement). */}
            <SheetHeader className="sr-only">
              <SheetTitle>Transaction details</SheetTitle>
              <SheetDescription>Loading transaction…</SheetDescription>
            </SheetHeader>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-10 w-1/2" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="pr-8 text-base">{tx.description}</SheetTitle>
              <SheetDescription className="flex items-center gap-2">
                <StatusBadge status={tx.status} />
                <span>{formatDate(tx.date)}</span>
                {tx.valueDate && tx.valueDate !== tx.date && (
                  <span className="text-xs">value {formatDateCompact(tx.valueDate)}</span>
                )}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <Amount
                amountMinor={tx.amountMinor}
                currencyCode={tx.currencyCode}
                className="text-3xl font-medium"
              />

              <div className="space-y-2">
                <p className="micro-label">Category</p>
                <CategoryPicker
                  categories={categories}
                  value={tx.category?.id}
                  align="start"
                  onSelect={(categoryId) =>
                    act(
                      () => updateTransaction(tx.id, { categoryId }),
                      "Category updated",
                    )
                  }
                  trigger={
                    <button type="button">
                      <CategoryBadge category={tx.category} />
                    </button>
                  }
                />
              </div>

              {tx.splits.length > 1 && (
                <div className="space-y-2">
                  <p className="micro-label">Splits</p>
                  <ul className="space-y-1.5 rounded-lg border border-ledger p-3">
                    {tx.splits.map((split) => (
                      <li
                        key={split.id}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <CategoryBadge
                            category={split.category}
                            className="px-1.5 py-0 text-[10px]"
                          />
                          {split.description && (
                            <span className="truncate text-xs text-muted-foreground">
                              {split.description}
                            </span>
                          )}
                        </span>
                        <Amount
                          amountMinor={split.amountMinor}
                          currencyCode={tx.currencyCode}
                          className="text-xs"
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {tx.transactionTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tx.transactionTags.map(({ tag }) => (
                    <Badge key={tag.id} variant="outline" className="text-muted-foreground">
                      #{tag.name}
                    </Badge>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <p className="micro-label">Notes</p>
                <Textarea
                  value={notesDraft ?? tx.notes ?? ""}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  placeholder="Add a note…"
                  rows={2}
                />
                {notesDraft !== null && notesDraft !== (tx.notes ?? "") && (
                  <Button
                    size="sm"
                    disabled={isPending}
                    onClick={() =>
                      act(
                        () => updateTransaction(tx.id, { notes: notesDraft }),
                        "Notes saved",
                      )
                    }
                  >
                    {isPending && <Spinner />} Save notes
                  </Button>
                )}
              </div>

              <Separator className="border-ledger" />

              <dl className="space-y-2.5 text-sm">
                <Row label="Account" value={tx.account?.name} />
                {tx.transferAccount && (
                  <Row label="Transfer to" value={tx.transferAccount.name} />
                )}
                <Row label="Raw description" value={tx.rawDescription} mono />
                <Row label="Narration" value={tx.narration} mono />
                <Row label="UPI ref" value={tx.upiReference} mono />
                <Row label="UTR" value={tx.utrNumber} mono />
                <Row label="External ID" value={tx.externalId} mono />
                {tx.metadata.map((meta) => (
                  <Row key={meta.id} label={meta.key} value={meta.value} mono />
                ))}
                <Row
                  label="Source"
                  value={
                    tx.importFile
                      ? `Imported from ${tx.importFile.fileName}`
                      : tx.recurringTransaction
                        ? `Recurring: ${tx.recurringTransaction.name}`
                        : "Manual entry"
                  }
                />
              </dl>

              <div className="flex gap-2 pt-2">
                {(tx.status === "imported" || tx.status === "pending") && (
                  <Button
                    className="flex-1"
                    disabled={isPending}
                    onClick={() =>
                      act(() => approveTransactions({ ids: [tx.id] }), "Approved")
                    }
                  >
                    <HugeiconsIcon icon={Tick02Icon} /> Approve
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="flex-1 text-destructive hover:text-destructive"
                  disabled={isPending}
                  onClick={() => {
                    if (!window.confirm("Delete this transaction? It can't be undone from the UI.")) return;
                    act(async () => {
                      await deleteTransaction(tx.id);
                      onClose();
                    }, "Transaction deleted");
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} /> Delete
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Row({
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
