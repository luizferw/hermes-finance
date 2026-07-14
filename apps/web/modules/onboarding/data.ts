/**
 * Static onboarding data shared by the client wizard and the server action.
 * No DB, no secrets — safe to import from both.
 */

export interface Region {
  key: string;
  label: string;
  flag: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  currencyCode: string;
  locale: string;
  /** First month of the financial year (1-12). */
  financialYearStartMonth: number;
}

export const REGIONS: Region[] = [
  { key: "IN", label: "India", flag: "🇮🇳", country: "IN", currencyCode: "INR", locale: "en-IN", financialYearStartMonth: 4 },
  { key: "PK", label: "Pakistan", flag: "🇵🇰", country: "PK", currencyCode: "PKR", locale: "en-PK", financialYearStartMonth: 7 },
  { key: "BD", label: "Bangladesh", flag: "🇧🇩", country: "BD", currencyCode: "BDT", locale: "en-BD", financialYearStartMonth: 7 },
  { key: "LK", label: "Sri Lanka", flag: "🇱🇰", country: "LK", currencyCode: "LKR", locale: "en-LK", financialYearStartMonth: 4 },
  { key: "GLOBAL", label: "Global", flag: "🌐", country: "US", currencyCode: "USD", locale: "en-US", financialYearStartMonth: 1 },
];

export function regionByKey(key: string): Region | undefined {
  return REGIONS.find((r) => r.key === key);
}

export interface SeedCategory {
  name: string;
  color: string;
}

// A small, India-tuned spending taxonomy. Three tiers so we never dump 80
// categories on a new user. recommended ⊃ minimal, advanced ⊃ recommended.
const MINIMAL: SeedCategory[] = [
  { name: "Food & Dining", color: "#ef4444" },
  { name: "Groceries", color: "#f97316" },
  { name: "Transport", color: "#eab308" },
  { name: "Bills & Utilities", color: "#06b6d4" },
  { name: "Shopping", color: "#a855f7" },
  { name: "Other", color: "#94a3b8" },
];

const RECOMMENDED_EXTRA: SeedCategory[] = [
  { name: "Rent", color: "#3b82f6" },
  { name: "Entertainment", color: "#ec4899" },
  { name: "Health", color: "#10b981" },
  { name: "Education", color: "#6366f1" },
  { name: "Subscriptions", color: "#8b5cf6" },
  { name: "Travel", color: "#14b8a6" },
];

const ADVANCED_EXTRA: SeedCategory[] = [
  { name: "Fuel", color: "#f59e0b" },
  { name: "Personal Care", color: "#d946ef" },
  { name: "Gifts & Donations", color: "#f43f5e" },
  { name: "Insurance", color: "#0ea5e9" },
  { name: "EMI & Loans", color: "#64748b" },
  { name: "Household", color: "#84cc16" },
  { name: "Investments", color: "#22c55e" },
  { name: "Kids", color: "#fb7185" },
];

export const CATEGORY_TIERS = {
  minimal: MINIMAL,
  recommended: [...MINIMAL, ...RECOMMENDED_EXTRA],
  advanced: [...MINIMAL, ...RECOMMENDED_EXTRA, ...ADVANCED_EXTRA],
} as const;

export type CategoryTier = keyof typeof CATEGORY_TIERS;
