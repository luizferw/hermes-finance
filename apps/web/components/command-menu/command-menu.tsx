"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  HealthIcon,
  PlusSignIcon,
  Search01Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { NAV_SECTIONS } from "@/components/app-shell/nav";
import { formatAmount, formatDateShort } from "@/lib/format";
import { useQuickAdd } from "@/hooks/use-quick-add";

const CommandMenuContext = React.createContext<{
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
} | null>(null);

interface TxResult {
  id: string;
  description: string;
  amountMinor: number;
  currencyCode: string;
  date: string;
  account?: { name: string } | null;
}

const CREATE_ACTIONS = [
  { label: "New transaction", href: "/transactions?new=1", icon: PlusSignIcon },
  { label: "Import CSV", href: "/transactions/import", icon: Upload01Icon },
  { label: "New account", href: "/accounts?new=1", icon: PlusSignIcon },
  { label: "New rule", href: "/automations?new=1", icon: PlusSignIcon },
  { label: "New budget", href: "/plan/budgets?new=1", icon: PlusSignIcon },
] as const;

export function CommandMenuProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<TxResult[]>([]);
  const [searching, setSearching] = React.useState(false);
  // Controlled highlighted item so async results deterministically take focus
  // (cmdk otherwise keeps the previously-selected value across re-renders).
  const [active, setActive] = React.useState("");
  const router = useRouter();

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  // Debounced, abortable live transaction search. All state writes happen in
  // async callbacks (never synchronously in the effect body).
  React.useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      fetch(`/api/transactions?q=${encodeURIComponent(term)}&pageSize=6`, {
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((json) => setResults(json.data.items as TxResult[]))
        .catch((err) => {
          if (err?.name !== "AbortError") setResults([]);
        })
        .finally(() => setSearching(false));
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setResults([]);
      setActive("");
    }
  }

  const go = React.useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [router],
  );

  // Quick-add: "coffee 180 upi" -> a transaction draft, saved in one keystroke.
  // Shared brain with the Home ask bar and the mobile sheet.
  const qa = useQuickAdd(query, {
    enabled: open,
    onSaved: () => {
      onOpenChange(false);
      router.refresh();
    },
  });
  const { draft, account: draftAccount, canSave: canQuickAdd } = qa;

  const term = query.trim().toLowerCase();
  const hasQuery = term.length > 0;
  const matches = (label: string) => !hasQuery || label.toLowerCase().includes(term);

  const navItems = NAV_SECTIONS.flatMap((section) => section.items)
    .concat([{ title: "Self-hosting health", href: "/settings/health", icon: HealthIcon }])
    .filter((item) => matches(item.title));
  const createItems = CREATE_ACTIONS.filter((a) => matches(a.label));
  const showTransactions = term.length >= 2;
  const hasResults = showTransactions && results.length > 0;

  // Default highlight: a matched transaction (jump-to-match), else the top
  // command. Recomputed only when the candidate set changes; arrow-key
  // navigation in between is preserved via `active`.
  const defaultActive = canQuickAdd
    ? "qa-add"
    : hasResults
    ? `tx-${results[0]!.id}`
    : createItems[0]
      ? createItems[0].label
      : navItems[0]
        ? `nav-${navItems[0].href}`
        : showTransactions
          ? "tx-see-all"
          : "";
  // Adjust state during render when the default changes (React's recommended
  // alternative to a setState-in-effect), so cmdk highlights the right item.
  const [prevDefault, setPrevDefault] = React.useState(defaultActive);
  if (defaultActive !== prevDefault) {
    setPrevDefault(defaultActive);
    setActive(defaultActive);
  }

  return (
    <CommandMenuContext.Provider value={{ setOpen }}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Command menu"
        description="Jump anywhere, search transactions, or create something"
        shouldFilter={false}
        commandValue={active}
        onCommandValueChange={setActive}
      >
        <CommandInput
          placeholder="Search transactions or type a command…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {canQuickAdd && (
            <>
              <CommandGroup heading="Quick add">
                <CommandItem value="qa-add" onSelect={() => qa.save()}>
                  <HugeiconsIcon icon={PlusSignIcon} />
                  <span className="min-w-0 flex-1 truncate">
                    {draft!.description || draft!.merchant || "Transaction"}
                    {draft!.method ? ` · ${draft!.method}` : ""}
                    {draft!.categoryHint ? ` · #${draft!.categoryHint}` : ""}
                    <span className="text-muted-foreground"> → {draftAccount!.name}</span>
                  </span>
                  <span className="ml-2 shrink-0 font-amount tabular-nums">
                    {formatAmount(
                      draft!.type === "income" ? draft!.amountMinor : -draft!.amountMinor,
                      draftAccount!.currencyCode,
                    )}
                  </span>
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
            </>
          )}
          {showTransactions && hasResults && (
            <CommandGroup heading="Transactions">
              {results.map((tx) => (
                <CommandItem
                  key={tx.id}
                  value={`tx-${tx.id}`}
                  onSelect={() => go(`/transactions?focus=${tx.id}`)}
                >
                  <HugeiconsIcon icon={Search01Icon} />
                  <span className="min-w-0 flex-1 truncate">{tx.description}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatDateShort(tx.date)}
                  </span>
                  <span className="ml-2 shrink-0 font-amount tabular-nums">
                    {formatAmount(tx.amountMinor, tx.currencyCode)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {createItems.length > 0 && (
            <>
              {showTransactions && hasResults && <CommandSeparator />}
              <CommandGroup heading="Create">
                {createItems.map((action) => (
                  <CommandItem key={action.href} value={action.label} onSelect={() => go(action.href)}>
                    <HugeiconsIcon icon={action.icon} />
                    {action.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {navItems.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Go to">
                {navItems.map((item) => (
                  <CommandItem key={item.href} value={`nav-${item.href}`} onSelect={() => go(item.href)}>
                    <HugeiconsIcon icon={item.icon} />
                    {item.title}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {showTransactions && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Search">
                <CommandItem
                  value="tx-see-all"
                  onSelect={() => go(`/transactions?q=${encodeURIComponent(query.trim())}`)}
                >
                  <HugeiconsIcon icon={Search01Icon} />
                  {searching
                    ? `Searching transactions for “${query.trim()}”…`
                    : `See all transactions matching “${query.trim()}”`}
                </CommandItem>
              </CommandGroup>
            </>
          )}

          {!showTransactions && navItems.length === 0 && createItems.length === 0 && (
            <CommandEmpty>No results found.</CommandEmpty>
          )}
        </CommandList>
      </CommandDialog>
    </CommandMenuContext.Provider>
  );
}

/**
 * Ledger search affordance for the masthead. A quiet inset field on wide
 * viewports — hairline ring, paper-tinted fill, a mono ⌘K chip — collapsing to
 * a single crisp icon button below `sm` where bar width is scarce. Both forms
 * open the same command palette.
 */
export function CommandMenuTrigger() {
  const ctx = React.useContext(CommandMenuContext);
  if (!ctx) return null;
  const open = () => ctx.setOpen(true);
  return (
    <>
      <button
        type="button"
        aria-label="Search"
        onClick={open}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-[color,background-color] duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:hidden"
      >
        <HugeiconsIcon icon={Search01Icon} className="size-[18px]" strokeWidth={1.8} />
      </button>

      <button
        type="button"
        onClick={open}
        className="group/search hidden h-8 w-48 items-center gap-2.5 rounded-lg bg-foreground/[0.035] px-2.5 text-left text-muted-foreground ring-1 ring-border/70 outline-none transition-[color,background-color,box-shadow] duration-[var(--duration-state)] ease-[var(--ease-out-quint)] ring-inset hover:bg-foreground/[0.055] hover:text-foreground hover:ring-border focus-visible:ring-2 focus-visible:ring-ring/60 sm:flex md:w-56 lg:w-64"
      >
        <HugeiconsIcon
          icon={Search01Icon}
          className="size-4 shrink-0 transition-colors group-hover/search:text-foreground"
          strokeWidth={1.8}
        />
        <span className="flex-1 truncate text-xs">Search transactions…</span>
        <kbd className="pointer-events-none flex h-5 items-center gap-0.5 rounded-sm bg-background px-1.5 font-amount text-[10px] text-muted-foreground ring-1 ring-border/70 ring-inset">
          ⌘K
        </kbd>
      </button>
    </>
  );
}
