/**
 * Where a transaction came from, for the detail sheet and the agent. Pure, so
 * the client sheet and the server tool label it the same way.
 *
 * Open Finance rows have no import file and no recurring template; before the
 * sync's metadata was consulted they all read "Manual entry".
 */
export type TransactionSourceKind = "import" | "open_finance" | "recurring" | "manual";

export function transactionSource(tx: {
  importFile: { fileName: string } | null;
  recurringTransaction: { name: string } | null;
  metadata: Array<{ key: string; value: string }>;
}): { kind: TransactionSourceKind; label: string } {
  if (tx.importFile) return { kind: "import", label: `Imported from ${tx.importFile.fileName}` };
  const provider = tx.metadata.find((m) => m.key === "open_finance.provider")?.value;
  if (provider) return { kind: "open_finance", label: `Open Finance sync (${provider})` };
  if (tx.recurringTransaction) {
    return { kind: "recurring", label: `Recurring: ${tx.recurringTransaction.name}` };
  }
  return { kind: "manual", label: "Manual entry" };
}
