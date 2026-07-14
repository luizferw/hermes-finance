/**
 * Ask-kosh intent parser. Deterministic, no AI: maps a natural-language
 * question to one of a finite set of *query intents* the app can answer with
 * real data, or returns null so the caller falls back to quick-entry / search.
 *
 * This is the line the brief draws — the model may interpret phrasing later,
 * but application code retrieves and computes every figure. Nothing here
 * computes a balance; it only classifies what the user is asking for.
 */
import { parseAmountToMinor } from "../shared/money";

export type AskPeriod = "this_month" | "last_month";

export type AskIntent =
  /** "food spending this month", "where did my money go", "show spending" */
  | { kind: "spending"; period: AskPeriod; categoryQuery: string | null }
  /** "transactions above 5000", "find transactions over ₹5,000" */
  | { kind: "find_above"; amountMinor: number }
  /** "what's due soon", "upcoming bills" */
  | { kind: "due_soon" }
  /** "show pending entries", "what needs review" */
  | { kind: "pending" }
  /** "show subscriptions", "recurring" */
  | { kind: "recurring" }
  /** "compare this month with last month" */
  | { kind: "compare_months" }
  /** "take me to imports", "open accounts" — deterministic navigation */
  | { kind: "navigate"; target: NavTarget };

export type NavTarget =
  | "imports"
  | "accounts"
  | "inbox"
  | "reports"
  | "goals"
  | "budgets"
  | "bills";

const NAV_WORDS: Record<string, NavTarget> = {
  import: "imports",
  imports: "imports",
  account: "accounts",
  accounts: "accounts",
  inbox: "inbox",
  review: "inbox",
  report: "reports",
  reports: "reports",
  trends: "reports",
  goal: "goals",
  goals: "goals",
  budget: "budgets",
  budgets: "budgets",
  bill: "bills",
  bills: "bills",
};

function periodFrom(text: string): AskPeriod {
  return /last\s+month|previous\s+month/.test(text) ? "last_month" : "this_month";
}

/**
 * Pull a category name out of a spending question: "food spending this month"
 * -> "food". Strips the framing words; null when the question is global
 * ("where did my money go").
 */
function categoryFrom(text: string): string | null {
  const cleaned = text
    .replace(
      /\b(show|me|my|the|how much|did|i|spend|spent|spending|on|for|this|last|month|where|go|gone|went|money|of|in|breakdown|by|category|categories)\b/g,
      " ",
    )
    .replace(/[?₹$.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

export function parseAskIntent(input: string): AskIntent | null {
  if (typeof input !== "string") return null;
  const text = input.trim().toLowerCase();
  if (text.length < 2) return null;

  // Navigation — "take me to X", "open X", "go to X".
  const navMatch = text.match(/^(?:take me to|open|go to|show me)\s+(.+)$/);
  if (navMatch) {
    const word = (navMatch[1] ?? "").trim().split(/\s+/)[0]!.replace(/[^a-z]/g, "");
    const target = NAV_WORDS[word];
    if (target) return { kind: "navigate", target };
  }

  // Amount threshold — "above/over/more than 5000".
  const aboveMatch = text.match(/(?:above|over|more than|greater than|>)\s*([₹$]?[\d,.]+k?)/);
  if (aboveMatch && /transaction|spend|expense|payment|find|show/.test(text)) {
    const amt = parseAmountToMinor(aboveMatch[1] ?? "", "INR");
    if (amt !== null && amt > 0) return { kind: "find_above", amountMinor: Math.abs(amt) };
  }

  if (/compar/.test(text) && /month/.test(text)) return { kind: "compare_months" };
  if (/subscription|recurring/.test(text)) return { kind: "recurring" };
  if (/\b(due|upcoming)\b/.test(text) && /bill|due|soon|upcoming/.test(text)) {
    return { kind: "due_soon" };
  }
  if (/\bpending\b|needs? review|to review|unreviewed/.test(text)) {
    return { kind: "pending" };
  }
  if (/spend|spent|spending|where.*money|money.*go/.test(text)) {
    return { kind: "spending", period: periodFrom(text), categoryQuery: categoryFrom(text) };
  }

  return null;
}
