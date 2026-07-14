"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("App route error", error.digest ?? error.name);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Something went wrong</EmptyTitle>
          <EmptyDescription>
            An unexpected error occurred.
            {error.digest && (
              <span className="mt-1 block font-amount text-xs">
                ref: {error.digest}
              </span>
            )}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={reset}>Try again</Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
