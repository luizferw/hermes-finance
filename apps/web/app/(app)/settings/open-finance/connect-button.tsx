"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { adoptConnection } from "@/modules/open-finance/mutations";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * Pinned rather than floating: the widget is third-party code running on our
 * origin, and a moving version is a moving trust boundary. The CSP on this route
 * allows exactly this host and the iframe it opens.
 */
const WIDGET_SRC = "https://cdn.pluggy.ai/pluggy-connect/v2.11.0/pluggy-connect.js";

interface PluggyConnectInstance {
  init: () => void;
}

interface PluggyConnectOptions {
  connectToken: string;
  updateItem?: string;
  includeSandbox?: boolean;
  onSuccess: (data: { item?: { id?: string; connector?: { name?: string } } }) => void;
  onError: (error: unknown) => void;
  onClose?: () => void;
}

declare global {
  interface Window {
    PluggyConnect?: new (options: PluggyConnectOptions) => PluggyConnectInstance;
  }
}

let widgetPromise: Promise<void> | null = null;

/** Load the widget script once per page, not once per click. */
function loadWidget(): Promise<void> {
  if (window.PluggyConnect) return Promise.resolve();
  if (widgetPromise) return widgetPromise;

  widgetPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = WIDGET_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      widgetPromise = null;
      reject(new Error("could not load the Pluggy widget"));
    };
    document.head.appendChild(script);
  });
  return widgetPromise;
}

export function ConnectButton({
  enabled,
  connectionId,
  label = "Connect a bank",
  variant = "default",
  size = "default",
}: {
  enabled: boolean;
  /** Present for a reconnection: the widget opens in update mode for this Item. */
  connectionId?: string;
  label?: string;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm";
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function open() {
    setBusy(true);
    try {
      const [, response] = await Promise.all([
        loadWidget(),
        fetch("/api/open-finance/connect-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(connectionId ? { connectionId } : {}),
        }),
      ]);

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Could not start the connection.");
      }

      const PluggyConnect = window.PluggyConnect;
      if (!PluggyConnect) throw new Error("the Pluggy widget did not load");

      const widget = new PluggyConnect({
        connectToken: body.data.accessToken,
        // Update mode repairs the connection in place instead of creating a
        // second one, which is what keeps the account links and the history
        // attached to the same Item.
        ...(body.data.itemId ? { updateItem: body.data.itemId } : {}),
        onSuccess: (data) => {
          const itemId = data?.item?.id;
          if (!itemId) {
            toast.error("Pluggy did not return a connection id.");
            return;
          }
          void finish(itemId, data?.item?.connector?.name);
        },
        onError: () => {
          toast.error("The connection was not completed.");
          setBusy(false);
        },
        onClose: () => setBusy(false),
      });
      widget.init();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the connection.");
      setBusy(false);
    }
  }

  async function finish(itemId: string, connectorName?: string) {
    // Pluggy is still collecting at this point, so the first sync often lands on
    // an item that is still UPDATING. That reports itself honestly rather than
    // pretending to have failed, and the scheduled run picks it up.
    toast.info("Connected. Collecting your data…");
    try {
      const { summary } = await adoptConnection({ itemId, label: connectorName });
      if (summary.status === "ok" || summary.status === "partial") {
        toast.success(
          `${summary.counts.created} transactions imported, ${summary.counts.needsReview} to review.`,
        );
      } else {
        toast.info(summary.message ?? "Connected. The first sync will run shortly.");
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not import this connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={open} disabled={!enabled || busy} variant={variant} size={size}>
      {busy ? <Spinner className="size-4" /> : null}
      {label}
    </Button>
  );
}
