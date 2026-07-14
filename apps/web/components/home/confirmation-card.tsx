"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { ActionProposal, ExecStatus } from "@/modules/agent/types";

/**
 * The native confirmation surface for an agent write. Nothing has been applied
 * yet — the user confirms the exact frozen payload, edits it (which re-prepares
 * and re-signs server-side), or cancels. The signed payload is sent back
 * verbatim; the model never reconstructs it.
 */
export function ConfirmationCard({
  proposal: initial,
  onDone,
}: {
  proposal: ActionProposal;
  onDone: () => void;
  onFollowUp: (q: string) => void;
}) {
  const router = useRouter();
  const [proposal, setProposal] = React.useState(initial);
  const [phase, setPhase] = React.useState<"idle" | "busy" | "done" | "cancelled">("idle");
  const [result, setResult] = React.useState<{ status: ExecStatus; title: string; detail?: string } | null>(null);
  const [editing, setEditing] = React.useState(false);

  async function confirm() {
    setPhase("busy");
    try {
      const res = await fetch("/api/agent/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolName: proposal.toolName,
          payload: proposal.payload,
          idempotencyKey: proposal.idempotencyKey,
          signature: proposal.signature,
        }),
      });
      const json = (await res.json()) as { data?: { status: ExecStatus; title: string; detail?: string } };
      setResult(json.data ?? { status: "temporary_failure", title: "No response." });
      setPhase("done");
      router.refresh();
      onDone();
    } catch {
      setResult({ status: "temporary_failure", title: "Network error — nothing was changed." });
      setPhase("done");
    }
  }

  if (phase === "done" && result) {
    const ok = result.status === "completed" || result.status === "already_completed";
    return (
      <p className={cn(
        "flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm ring-1 ring-inset",
        ok ? "bg-success/[0.08] text-foreground ring-success/20" : "bg-destructive/[0.08] text-foreground ring-destructive/20",
      )}>
        <HugeiconsIcon icon={ok ? CheckmarkCircle02Icon : Alert02Icon} className={cn("size-4 shrink-0", ok ? "text-success" : "text-destructive")} strokeWidth={1.8} />
        <span className="font-medium">{result.title}</span>
        {result.detail && <span className="text-muted-foreground">· {result.detail}</span>}
      </p>
    );
  }

  if (phase === "cancelled") {
    return <p className="rounded-xl bg-foreground/[0.04] px-3.5 py-2.5 text-sm text-muted-foreground">Cancelled — nothing was changed.</p>;
  }

  return (
    <div className={cn(
      "glass-panel rounded-2xl p-4 ring-1 ring-inset",
      proposal.risk === "sensitive" ? "ring-warning/30" : "ring-primary/20",
    )}>
      <div className="flex items-center gap-2">
        <span className="micro-label">{proposal.risk === "sensitive" ? "Confirm — sensitive" : "Confirm"}</span>
        {proposal.affectedCount !== undefined && (
          <span className="font-amount text-xs text-muted-foreground tabular-nums">{proposal.affectedCount} affected</span>
        )}
      </div>
      <p className="mt-1 text-sm font-medium text-foreground">{proposal.title}</p>
      <p className="text-sm text-muted-foreground">{proposal.summary}</p>

      {!editing ? (
        <dl className="mt-3 space-y-1.5 border-t border-border/50 pt-3 text-sm">
          {proposal.fields.map((f, i) => (
            <div key={i} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="text-right font-medium text-foreground">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <EditForm
          proposal={proposal}
          onCancel={() => setEditing(false)}
          onUpdated={(p) => {
            setProposal(p);
            setEditing(false);
          }}
        />
      )}

      {proposal.warning && (
        <p className="mt-3 flex items-start gap-2 text-xs text-warning">
          <HugeiconsIcon icon={Alert02Icon} className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.8} />
          {proposal.warning}
        </p>
      )}
      {!proposal.undoable && (
        <p className="mt-2 text-xs text-muted-foreground">This can&apos;t be automatically undone.</p>
      )}

      {!editing && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={confirm}
            disabled={phase === "busy"}
            className="inline-flex items-center rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground outline-none transition-transform hover:scale-[1.02] active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60"
          >
            {phase === "busy" ? "Applying…" : "Confirm"}
          </button>
          {Object.keys(proposal.editable).length > 0 && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center rounded-full bg-card/70 px-4 py-1.5 text-sm text-foreground outline-none ring-1 ring-inset ring-border/70 transition-colors hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={() => setPhase("cancelled")}
            className="inline-flex items-center rounded-full px-3 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** Edit the model's args, then re-prepare + re-sign through the server. */
function EditForm({
  proposal,
  onCancel,
  onUpdated,
}: {
  proposal: ActionProposal;
  onCancel: () => void;
  onUpdated: (p: ActionProposal) => void;
}) {
  const [values, setValues] = React.useState<Record<string, unknown>>(proposal.editable);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function update() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName: proposal.toolName, args: values }),
      });
      const json = (await res.json()) as { data?: { proposal: ActionProposal }; error?: { message: string } };
      if (json.data?.proposal) onUpdated(json.data.proposal);
      else setError(json.error?.message ?? "Could not update.");
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2.5 border-t border-border/50 pt-3">
      {Object.entries(proposal.editable).map(([key, val]) => {
        if (val !== null && typeof val === "object") return null;
        const isNum = typeof val === "number";
        return (
          <label key={key} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground capitalize">{key}</span>
            <input
              type={isNum ? "number" : "text"}
              defaultValue={val === null ? "" : String(val)}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  [key]: isNum ? Number(e.target.value) : e.target.value,
                }))
              }
              className="w-40 rounded-md border border-border bg-background px-2 py-1 text-right text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            />
          </label>
        );
      })}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={update} disabled={busy} className="rounded-full bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? "Updating…" : "Update"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
          Back
        </button>
      </div>
    </div>
  );
}
