"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ConnectionView } from "@/modules/open-finance/queries";
import {
  registerConnection,
  removeConnection,
  syncConnectionNow,
  updateAccountLink,
} from "@/modules/open-finance/mutations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ConnectButton } from "./connect-button";

interface LinkTarget {
  id: string;
  name: string;
  type: string;
  currencyCode: string;
}

const IGNORE_VALUE = "__ignore__";

/** Freshness in the words PRD R8 asks for: never a bare "current balance". */
function freshnessLabel(ageDays: number | null): string {
  if (ageDays === null) return "never synced";
  if (ageDays <= 0) return "updated today";
  if (ageDays === 1) return "updated yesterday";
  return `updated ${ageDays} days ago`;
}

function statusTone(connection: ConnectionView): "default" | "secondary" | "destructive" {
  if (connection.consentExpired) return "destructive";
  if (connection.lastSyncStatus === "error") return "destructive";
  if (connection.lastSyncStatus === "partial") return "secondary";
  return "default";
}

export function ConnectionsPanel({
  connections,
  linkTargets,
  enabled,
}: {
  connections: ConnectionView[];
  linkTargets: LinkTarget[];
  enabled: boolean;
}) {
  const router = useRouter();
  const [itemId, setItemId] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function onRegister(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await registerConnection({ itemId: itemId.trim(), label: label.trim() || undefined });
      setItemId("");
      setLabel("");
      toast.success("Connection registered. Run a sync to pull it in.");
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register this Item.");
    }
  }

  async function onSync(connectionId: string) {
    setBusyId(connectionId);
    try {
      const summary = await syncConnectionNow(connectionId);
      if (summary.status === "error") {
        toast.error(summary.message ?? "The sync failed.");
      } else if (summary.status === "skipped") {
        toast.info(summary.message ?? "Nothing to do.");
      } else {
        toast.success(
          `${summary.counts.created} new, ${summary.counts.updated} updated, ` +
            `${summary.counts.needsReview} to review.`,
        );
      }
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The sync failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function onRemove(connectionId: string) {
    setBusyId(connectionId);
    try {
      await removeConnection(connectionId);
      toast.success("Connection removed. Your accounts and history were kept.");
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove this connection.");
    } finally {
      setBusyId(null);
    }
  }

  async function onRelink(linkId: string, value: string) {
    try {
      await updateAccountLink({
        linkId,
        accountId: value === IGNORE_VALUE ? null : value,
      });
      toast.success("Link updated. The next sync will re-read this account's history.");
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update this link.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <ConnectButton enabled={enabled} />
        <p className="text-muted-foreground text-sm">
          Opens Pluggy&apos;s secure widget. Your bank credentials go to the institution,
          never to Hermes.
        </p>

        {/* Kept as a secondary path: banks connected at meu.pluggy.ai before this
            screen existed cannot be discovered automatically, because Pluggy's
            item listing endpoint is disabled by default. */}
        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer">
            Already connected a bank at meu.pluggy.ai? Add it by Item ID
          </summary>
          <form onSubmit={onRegister} className="mt-3 flex flex-wrap items-end gap-3">
            <Field className="min-w-64 flex-1">
              <FieldLabel htmlFor="itemId">Item ID</FieldLabel>
              <Input
                id="itemId"
                value={itemId}
                onChange={(event) => setItemId(event.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                autoComplete="off"
                disabled={!enabled}
              />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <Field className="min-w-48">
              <FieldLabel htmlFor="label">Name (optional)</FieldLabel>
              <Input
                id="label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Nubank"
                disabled={!enabled}
              />
            </Field>
            <Button type="submit" variant="outline" disabled={!enabled || !itemId.trim() || pending}>
              Add
            </Button>
          </form>
        </details>
      </div>

      {connections.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No connections yet. Connect a bank above to start.
        </p>
      ) : null}

      {connections.map((connection) => (
        <div key={connection.id} className="rounded-lg border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {connection.label ?? connection.connectorName ?? "Connection"}
                </span>
                <Badge variant={statusTone(connection)}>
                  {connection.consentExpired ? "consent expired" : connection.status}
                </Badge>
              </div>
              <p className="text-muted-foreground mt-1 text-sm">
                {freshnessLabel(connection.dataAgeDays)}
                {connection.lastRun
                  ? ` · last run: ${connection.lastRun.recordsCreated} new, ` +
                    `${connection.lastRun.duplicates} possible duplicates, ` +
                    `${connection.lastRun.needsReview} to review`
                  : " · never run"}
              </p>
              {connection.lastSyncError ? (
                <p className="text-destructive mt-1 text-sm">{connection.lastSyncError}</p>
              ) : null}
            </div>
            <div className="flex gap-2">
              {/* Reconnecting is the only way out of LOGIN_ERROR, a changed
                  password or an expired consent: the widget re-authenticates the
                  same Item instead of creating a second one, so the account
                  links and the imported history stay attached. */}
              {connection.consentExpired ||
              connection.lastSyncStatus === "error" ||
              connection.status === "LOGIN_ERROR" ||
              connection.status === "WAITING_USER_INPUT" ? (
                <ConnectButton
                  enabled={enabled}
                  connectionId={connection.id}
                  label="Reconnect"
                  variant="default"
                  size="sm"
                />
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSync(connection.id)}
                disabled={!enabled || busyId === connection.id}
              >
                {busyId === connection.id ? <Spinner className="size-4" /> : null}
                Sync now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRemove(connection.id)}
                disabled={busyId === connection.id}
              >
                Remove
              </Button>
            </div>
          </div>

          {connection.links.length > 0 ? (
            <div className="mt-4 space-y-2">
              {connection.links.map((link) => (
                <div
                  key={link.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {link.providerName ?? link.providerAccountId}
                      <span className="text-muted-foreground ml-2 font-normal">
                        {link.providerSubtype ?? link.providerType}
                      </span>
                    </p>
                    {/* The decision is shown in words so it can be checked and
                        overridden, rather than happening invisibly. */}
                    <p className="text-muted-foreground text-xs">{link.linkDecisionNote}</p>
                  </div>
                  <Select
                    value={link.accountId ?? IGNORE_VALUE}
                    onValueChange={(value) => onRelink(link.id, value)}
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue placeholder="Not linked" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={IGNORE_VALUE}>Ignore this account</SelectItem>
                      {linkTargets.map((target) => (
                        <SelectItem key={target.id} value={target.id}>
                          {target.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
