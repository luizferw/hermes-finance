"use client";

import * as React from "react";
import { toast } from "sonner";
import { parseQuickEntry, minorToMajor, type QuickEntryDraft } from "@kosh/domain";
import {
  createTransaction,
  recallMerchantMemory,
} from "@/modules/transactions/mutations";

export interface AccountLite {
  id: string;
  name: string;
  currencyCode: string;
}
export interface CategoryLite {
  id: string;
  name: string;
  color?: string | null;
}

export interface QuickAdd {
  draft: QuickEntryDraft | null;
  /** Target account for the draft (resolved from @hint, else first). */
  account: AccountLite | null;
  accounts: AccountLite[];
  categories: CategoryLite[];
  /** Category resolved from an explicit #hint, for preview. null otherwise. */
  resolvedCategory: CategoryLite | null;
  canSave: boolean;
  saving: boolean;
  /**
   * Saves the draft; returns true on success. Shows a toast either way.
   * `override` lets a preview surface commit inline edits (a picked account or
   * category) without re-running the parser.
   */
  save: (override?: {
    accountId?: string;
    categoryId?: string | null;
    /** Park in the inbox for review instead of posting it live. */
    review?: boolean;
  }) => Promise<boolean>;
}

/**
 * The one quick-add brain: turns a command string into a transaction draft and
 * commits it. Owns account/category lookup and merchant memory so Cmd-K, the
 * Home ask bar, and the mobile sheet all behave identically.
 *
 * The caller owns the input string. Pass `enabled` to defer the (cheap) one-off
 * accounts + categories fetch until the surface is actually visible.
 */
export function useQuickAdd(
  query: string,
  opts: { enabled?: boolean; onSaved?: () => void } = {},
): QuickAdd {
  const { enabled = true, onSaved } = opts;
  const [accounts, setAccounts] = React.useState<AccountLite[]>([]);
  const [categories, setCategories] = React.useState<CategoryLite[]>([]);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!enabled || accounts.length) return;
    const grab = (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => j.data);
    grab("/api/accounts").then((d) => setAccounts(d as AccountLite[])).catch(() => {});
    grab("/api/categories").then(setCategories).catch(() => {});
  }, [enabled, accounts.length]);

  const draft = React.useMemo(() => parseQuickEntry(query), [query]);

  const account =
    (draft?.accountHint
      ? accounts.find((a) =>
          a.name.toLowerCase().includes(draft.accountHint!.toLowerCase()),
        )
      : undefined) ??
    accounts[0] ??
    null;

  // #food -> category. Exact name first, then a contains match. Never invents.
  const resolveCategory = React.useCallback(
    (hint: string | null): CategoryLite | null => {
      if (!hint) return null;
      const h = hint.toLowerCase();
      return (
        categories.find((c) => c.name.toLowerCase() === h) ??
        categories.find((c) => c.name.toLowerCase().includes(h)) ??
        null
      );
    },
    [categories],
  );
  const resolvedCategory = resolveCategory(draft?.categoryHint ?? null);

  const canSave = !!draft && !!account;

  const save = React.useCallback(
    async (override?: {
      accountId?: string;
      categoryId?: string | null;
      review?: boolean;
    }): Promise<boolean> => {
      if (!draft || !account || saving) return false;
      setSaving(true);
      try {
        // Merchant memory: reuse the last category + account for this merchant.
        // An explicit @account hint or inline edit overrides the recall.
        const recalled = draft.merchant
          ? await recallMerchantMemory(draft.merchant)
          : null;
        const target =
          (override?.accountId
            ? accounts.find((a) => a.id === override.accountId)
            : !draft.accountHint && recalled
              ? accounts.find((a) => a.id === recalled.accountId)
              : undefined) ?? account;
        const categoryId =
          override?.categoryId !== undefined
            ? override.categoryId
            : (resolveCategory(draft.categoryHint)?.id ?? recalled?.categoryId ?? null);
        await createTransaction({
          type: draft.type,
          date: draft.date,
          accountId: target.id,
          amount: minorToMajor(draft.amountMinor, target.currencyCode),
          description: draft.description || draft.merchant || "Quick entry",
          merchant: draft.merchant ?? undefined,
          categoryId,
          tagIds: [],
          status: override?.review ? "pending" : "posted",
        });
        toast.success(override?.review ? "Saved to review" : "Added");
        onSaved?.();
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [draft, account, accounts, saving, resolveCategory, onSaved],
  );

  return {
    draft,
    account,
    accounts,
    categories,
    resolvedCategory,
    canSave,
    saving,
    save,
  };
}
