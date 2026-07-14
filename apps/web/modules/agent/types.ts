/**
 * Agent spine types — shared by the canonical tool registry, the Gemini
 * orchestrator, the MCP server, and the assistant UI. No `server-only` import:
 * the response/block types are consumed by client components too.
 */
import type { ZodType } from "zod";

/** Risk class governs whether a tool runs immediately or needs confirmation. */
export type RiskClass = "read" | "write" | "sensitive";

/** Identity is always derived server-side from the session or a scoped token —
 * never from anything the model said. */
export interface ToolContext {
  userId: string;
  /** Scopes granted to the caller (full set for an in-app session). */
  scopes: Scope[];
  /** Default currency for figures the model didn't specify. */
  currency: string;
}

export type Scope =
  | "finance:read"
  | "transactions:write"
  | "plans:write"
  | "goals:write"
  | "reviews:write"
  | "rules:read"
  | "rules:write"
  | "automations:read"
  | "automations:write";

/** External MCP is deliberately read-only until Kosh has durable approvals. */
export const MCP_READ_SCOPES = [
  "finance:read",
  "rules:read",
  "automations:read",
] as const satisfies readonly Scope[];

/* ── Structured assistant response blocks ───────────────────────────────── */

export interface MoneyFigure {
  label: string;
  amountMinor: number;
  currency: string;
  tone?: "positive" | "negative" | "neutral";
}

export interface TxnLine {
  id: string;
  date: string;
  description: string;
  amountMinor: number;
  currency: string;
  category: string | null;
}

export interface CategoryLine {
  name: string;
  color: string | null;
  spentMinor: number;
}

export interface CommitmentLine {
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  daysUntilDue: number;
  overdue: boolean;
}

export interface BudgetLine {
  id: string;
  name: string;
  plannedMinor: number;
  spentMinor: number;
  remainingMinor: number;
  ratio: number;
  isOver: boolean;
  currency: string;
}

export interface GoalLine {
  id: string;
  name: string;
  currentMinor: number;
  targetMinor: number;
  ratio: number;
  currency: string;
  targetDate: string | null;
}

export interface RecurringLine {
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
  interval: string;
  nextDate: string;
}

/** One renderable piece of an assistant answer. Figures here are computed by
 * tools, never by the model. */
export type ResponseBlock =
  | { type: "text"; text: string }
  | { type: "figure"; title: string; figure: MoneyFigure; caption?: string }
  | {
      type: "breakdown";
      title: string;
      currency: string;
      rows: CategoryLine[];
      totalMinor: number;
    }
  | { type: "transactions"; title: string; rows: TxnLine[]; moreCount: number; href?: string }
  | {
      type: "comparison";
      title: string;
      currency: string;
      a: { label: string; incomeMinor: number; expenseMinor: number; netMinor: number };
      b: { label: string; incomeMinor: number; expenseMinor: number; netMinor: number };
    }
  | { type: "accounts"; title: string; rows: Array<{ id: string; name: string; balanceMinor: number; currency: string }> }
  | { type: "commitments"; title: string; currency: string; rows: CommitmentLine[] }
  | {
      type: "safeToSpend";
      title: string;
      period: string;
      currency: string;
      safeMinor: number;
      incomeMinor: number;
      expenseMinor: number;
      committedMinor: number;
      note: string;
    }
  | { type: "budgets"; title: string; period: string; rows: BudgetLine[] }
  | { type: "goals"; title: string; rows: GoalLine[] }
  | { type: "recurring"; title: string; rows: RecurringLine[] }
  | {
      type: "cashflow";
      title: string;
      range: string;
      currency: string;
      inflowMinor: number;
      outflowMinor: number;
      netMinor: number;
    }
  | {
      type: "anomalies";
      title: string;
      currency: string;
      rows: Array<{
        name: string;
        currentMinor: number;
        priorMinor: number;
        deltaMinor: number;
        deltaPct: number | null;
        isNew: boolean;
      }>;
      note: string;
    }
  | {
      type: "missingData";
      title: string;
      items: Array<{ label: string; detail: string; href: string }>;
    }
  | {
      type: "currencyWarning";
      defaultCurrency: string;
      otherCurrencies: string[];
      text: string;
    }
  | { type: "goalProjection"; title: string; lines: string[]; figure?: MoneyFigure }
  | { type: "ruleDraft"; draft: RuleDraftBlock }
  | { type: "ruleList"; title: string; rules: RuleSummaryLine[] }
  | { type: "proposal"; proposal: ActionProposal }
  | { type: "result"; status: ExecStatus; title: string; detail?: string }
  | { type: "warning"; text: string };

/** A human-readable rule draft with its dry-run impact, shown as a native
 * builder rather than raw JSON. The concrete payload that would be saved rides
 * in a signed proposal, never reconstructed by the model. */
export interface RuleDraftBlock {
  name: string;
  matchAll: boolean;
  conditions: Array<{ field: string; value: string; label: string }>;
  actions: Array<{ type: string; value: string | null; label: string }>;
  /** Dry-run against history. */
  matchedCount: number;
  scannedCount: number;
  sample: Array<{ description: string; date: string; amountMinor: number; currency: string }>;
  warning?: string;
}

export interface RuleSummaryLine {
  id: string;
  name: string;
  isActive: boolean;
  priority: number;
  conditionCount: number;
  actionCount: number;
  lastRun?: { matched: number; applied: number; at: string } | null;
}

/* ── Action proposals & confirmation ────────────────────────────────────── */

/** A field shown on a confirmation card. */
export interface ConfirmField {
  label: string;
  value: string;
  /** For edits — which payload key this maps to. */
  key?: string;
}

/** A frozen, server-signed write the UI must confirm before it executes. The
 * `payload` is the exact concrete arguments (ids resolved); the model never
 * gets to reconstruct it after approval. */
export interface ActionProposal {
  toolName: string;
  risk: Exclude<RiskClass, "read">;
  title: string;
  summary: string;
  fields: ConfirmField[];
  /** Number of records a bulk action affects. */
  affectedCount?: number;
  warning?: string;
  undoable: boolean;
  /** Opaque concrete payload executed verbatim on confirm. */
  payload: unknown;
  /** HMAC over { toolName, payload, userId, idempotencyKey }. */
  signature: string;
  idempotencyKey: string;
  /** The validated model args, so the UI can offer an edit-before-confirm form
   * that re-prepares (and re-signs) through the server. */
  editable: Record<string, unknown>;
}

export type ExecStatus =
  | "completed"
  | "already_completed"
  | "rejected"
  | "cancelled"
  | "validation_failed"
  | "permission_denied"
  | "temporary_failure";

/* ── Tool definitions (the canonical registry shape) ────────────────────── */

export interface ReadToolResult {
  /** Compact data handed to the model (numbers it must not re-derive). */
  forModel: unknown;
  /** Optional UI block rendered authoritatively from the same result. */
  block?: ResponseBlock;
  /** Additional authoritative blocks, for example a currency warning. */
  blocks?: ResponseBlock[];
}

// `any` (not `unknown`) is deliberate: tool executors are defined with concrete
// arg types, and the registry holds them in a `Tool[]`; an invariant `unknown`
// would reject every concrete tool. The `define` helpers preserve real types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ReadTool<A = any> {
  kind: "read";
  name: string;
  title: string;
  description: string;
  risk: "read";
  requiredScope: Scope;
  input: ZodType;
  execute: (ctx: ToolContext, args: A) => Promise<ReadToolResult>;
}

export interface PreparedWrite {
  /** Concrete payload frozen for execution. */
  payload: unknown;
  title: string;
  summary: string;
  fields: ConfirmField[];
  affectedCount?: number;
  warning?: string;
  undoable: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WriteTool<A = any> {
  kind: "write";
  name: string;
  title: string;
  description: string;
  risk: "write" | "sensitive";
  requiredScope: Scope;
  input: ZodType;
  /** Resolve model args → a concrete, confirmable payload (no mutation yet). */
  prepare: (ctx: ToolContext, args: A) => Promise<PreparedWrite>;
  /** Execute the frozen payload. Must be idempotent on `idempotencyKey`. */
  execute: (
    ctx: ToolContext,
    payload: unknown,
    idempotencyKey: string,
  ) => Promise<{ status: ExecStatus; title: string; detail?: string; block?: ResponseBlock }>;
}

export type Tool = ReadTool | WriteTool;
