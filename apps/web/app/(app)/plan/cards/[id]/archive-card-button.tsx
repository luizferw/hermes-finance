"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Archive01Icon } from "@hugeicons/core-free-icons";
import { archiveCreditCard } from "@/modules/finance/mutations";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * Deactivates the card — `archiveCreditCard` keeps its purchases and
 * installments auditable rather than deleting them. Archiving is immediate,
 * matching how reserves and accounts retire records elsewhere in this app.
 */
export function ArchiveCardButton({ cardId, cardName }: { cardId: string; cardName: string }) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();

  function archive() {
    startTransition(async () => {
      try {
        await archiveCreditCard(cardId);
        toast.success(`${cardName} archived`);
        router.push("/plan/cards");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not archive the card");
      }
    });
  }

  return (
    <Button variant="outline" size="sm" disabled={isPending} onClick={archive}>
      {isPending ? <Spinner /> : <HugeiconsIcon icon={Archive01Icon} />}
      Archive
    </Button>
  );
}
