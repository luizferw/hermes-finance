/**
 * Ask-kosh structured answers. Shared between the server orchestrator (which
 * computes every figure with real queries) and the client renderer (which only
 * displays). No `server-only` here so the client can import the types.
 */

export interface AskTxn {
  id: string;
  date: string;
  description: string;
  amountMinor: number;
  currencyCode: string;
  category: { name: string; color: string | null } | null;
}

export interface AskCategoryRow {
  name: string;
  color: string | null;
  spentMinor: number;
}

export interface AskBillRow {
  id: string;
  name: string;
  amountMinor: number;
  currencyCode: string;
  dueDate: string;
  daysUntilDue: number;
  overdue: boolean;
}

export interface AskFollowUp {
  label: string;
  /** Re-ask kosh with this text. */
  query: string;
}

export type AskAnswer =
  /** A single figure with an optional breakdown — "you spent ₹8,400 on food". */
  | {
      kind: "amount";
      title: string;
      amountMinor: number;
      currency: string;
      caption?: string;
      href?: string;
      breakdown?: AskCategoryRow[];
      followUps?: AskFollowUp[];
    }
  /** A ranked category breakdown — "where did my money go". */
  | {
      kind: "categories";
      title: string;
      currency: string;
      rows: AskCategoryRow[];
      totalMinor: number;
      href: string;
      followUps?: AskFollowUp[];
    }
  /** A group of transactions — "transactions above ₹5,000". */
  | {
      kind: "transactions";
      title: string;
      txns: AskTxn[];
      moreCount: number;
      href: string;
      followUps?: AskFollowUp[];
    }
  /** Upcoming commitments — "what's due soon". */
  | {
      kind: "bills";
      title: string;
      currency: string;
      rows: AskBillRow[];
      href: string;
      followUps?: AskFollowUp[];
    }
  /** Two periods side by side — "compare this month with last month". */
  | {
      kind: "compare";
      title: string;
      currency: string;
      a: { label: string; incomeMinor: number; expenseMinor: number; netMinor: number };
      b: { label: string; incomeMinor: number; expenseMinor: number; netMinor: number };
      href: string;
      followUps?: AskFollowUp[];
    }
  /** Deterministic navigation — "take me to imports". */
  | { kind: "navigate"; href: string; label: string }
  /** Nothing matched a deterministic capability; offer search. */
  | { kind: "none"; query: string };
