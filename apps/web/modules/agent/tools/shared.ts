import "server-only";
import { z, type ZodType } from "zod";
import { addMonthsClamped, formatMoney, majorToMinor, todayIso } from "@kosh/domain";
import { listAccounts } from "@/modules/accounts/queries";
import { listCategories } from "@/modules/taxonomy/queries";
import type { PreparedWrite, ReadTool, ReadToolResult, ResponseBlock, Scope, ToolContext, WriteTool } from "../types";

/* ── definition helpers (infer arg type from the zod schema) ────────────── */

export function read<S extends ZodType>(t: {
  name: string;
  title: string;
  description: string;
  requiredScope: Scope;
  input: S;
  execute: (ctx: ToolContext, args: z.infer<S>) => Promise<ReadToolResult>;
}): ReadTool<z.infer<S>> {
  return { kind: "read", risk: "read", ...t };
}

export function write<S extends ZodType>(t: {
  name: string;
  title: string;
  description: string;
  risk: "write" | "sensitive";
  requiredScope: Scope;
  input: S;
  prepare: (ctx: ToolContext, args: z.infer<S>) => Promise<PreparedWrite>;
  execute: WriteTool<z.infer<S>>["execute"];
}): WriteTool<z.infer<S>> {
  return { kind: "write", ...t };
}

/* ── shared resolution (names → owned ids; never trust model ids blindly) ─ */

export async function resolveAccount(userId: string, hint?: string) {
  const accounts = (await listAccounts(userId)).filter((a) => !a.isArchived);
  if (!hint) return accounts[0] ?? null;
  const h = hint.toLowerCase();
  return (
    accounts.find((a) => a.name.toLowerCase() === h) ??
    accounts.find((a) => a.name.toLowerCase().includes(h)) ??
    accounts[0] ??
    null
  );
}

export async function resolveCategory(userId: string, hint?: string | null) {
  if (!hint) return null;
  const cats = await listCategories(userId);
  const h = hint.toLowerCase();
  return (
    cats.find((c) => c.name.toLowerCase() === h) ??
    cats.find((c) => c.name.toLowerCase().includes(h)) ??
    null
  );
}

export function monthIsoFor(period?: "this_month" | "last_month") {
  return period === "last_month" ? addMonthsClamped(todayIso(), -1) : todayIso();
}

export function monthLabel(iso: string) {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(
    new Date(`${iso.slice(0, 7)}-01T00:00:00`),
  );
}

export function currencyWarning(
  defaultCurrency: string,
  currencies: string[],
): ResponseBlock | undefined {
  const otherCurrencies = [...new Set(currencies)].filter(
    (currency) => currency !== defaultCurrency,
  );
  return otherCurrencies.length
    ? {
        type: "currencyWarning",
        defaultCurrency,
        otherCurrencies,
        text: `Totals use ${defaultCurrency}. Other currencies are shown separately and are not added to it.`,
      }
    : undefined;
}

export function currencyWarningBlocks(defaultCurrency: string, currencies: string[]) {
  const warning = currencyWarning(defaultCurrency, currencies);
  return warning ? [warning] : undefined;
}

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const currencyCodeInput = z.string().regex(/^[A-Za-z]{3}$/, "Use a 3-letter ISO 4217 code");

/**
 * Account by name, with no fallback. `resolveAccount` defaults to the first
 * account when nothing matches, which is right for "add an expense" but wrong
 * here: an item's account decides whether it settles on a card's cycles, so a
 * typo must fail loudly instead of quietly projecting onto another account.
 */
export async function resolveNamedAccount(userId: string, name: string) {
  const accounts = (await listAccounts(userId)).filter((a) => !a.isArchived);
  const h = name.toLowerCase();
  const account =
    accounts.find((a) => a.name.toLowerCase() === h) ??
    accounts.find((a) => a.name.toLowerCase().includes(h));
  if (!account) throw new Error(`No account matching "${name}".`);
  return account;
}

export function formatMajor(amount: number, currency: string) {
  return formatMoney(majorToMinor(amount, currency), currency);
}

