import {
  CreditCardIcon,
  Invoice01Icon,
  PieChart01Icon,
  InboxIcon,
  BankIcon,
} from "@hugeicons/core-free-icons";

/**
 * Deterministic "ask kosh" suggestions. The assistant navigates, computes, and
 * controls the app — no LLM. A suggestion either asks a question kosh answers
 * inline (`ask`), routes to a real screen (`route`), or prefills the bar so the
 * user finishes a quick-entry (`prefill`). Nothing here guesses; the figures in
 * an `ask` answer are computed server-side from real data.
 */
export type SuggestionAction =
  | { type: "ask"; text: string }
  | { type: "route"; href: string }
  | { type: "prefill"; text: string };

export interface Suggestion {
  label: string;
  icon: typeof InboxIcon;
  action: SuggestionAction;
}

export const SUGGESTIONS: Suggestion[] = [
  { label: "Where did my money go?", icon: PieChart01Icon, action: { type: "ask", text: "where did my money go" } },
  { label: "What's due soon?", icon: Invoice01Icon, action: { type: "ask", text: "what's due soon" } },
  { label: "Show subscriptions", icon: CreditCardIcon, action: { type: "ask", text: "show subscriptions" } },
  { label: "Log a cash expense", icon: BankIcon, action: { type: "prefill", text: "cash " } },
  { label: "Review inbox", icon: InboxIcon, action: { type: "route", href: "/inbox" } },
];
