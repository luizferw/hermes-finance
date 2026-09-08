"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Copy01Icon,
  FileImportIcon,
} from "@hugeicons/core-free-icons";
import { IMPORT_FIELDS, type ImportField } from "@kosh/domain";
import {
  applyImportMapping,
  commitImport,
  uploadImport,
} from "@/modules/imports/mutations";
import { formatDateShort, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const FIELD_LABELS: Record<ImportField, string> = {
  date: "Date *",
  valueDate: "Value date",
  description: "Description *",
  amount: "Amount (signed)",
  debit: "Debit / withdrawal",
  credit: "Credit / deposit",
  externalId: "Reference no.",
  upiReference: "UPI reference",
  utrNumber: "UTR number",
  narration: "Narration",
};

const DATE_FORMATS = [
  "dd/MM/yyyy",
  "MM/dd/yyyy",
  "yyyy-MM-dd",
  "dd-MM-yyyy",
  "dd/MM/yy",
  "dd MMM yyyy",
];

interface Template {
  id: string;
  name: string;
  mapping: Record<string, string>;
  dateFormat: string | null;
}

interface UploadResult {
  importFileId: string;
  headers: string[];
  rowCount: number;
  suggestedMapping: Partial<Record<ImportField, string>>;
  sampleRows: Array<Record<string, string>>;
}

interface PreviewRow {
  id: string;
  rowIndex: number;
  status: string;
  parsedDate: string | null;
  parsedAmountMinor: number | null;
  parsedDescription: string | null;
  parseError: string | null;
  duplicateOfTransaction: { description: string; date: string } | null;
}

type Step = "upload" | "map" | "preview" | "done";

export function ImportWizard({
  accounts,
  templates,
}: {
  accounts: Array<{ id: string; name: string; currencyCode: string }>;
  templates: Template[];
}) {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>("upload");
  const [busy, setBusy] = React.useState(false);
  const [accountId, setAccountId] = React.useState(accounts[0]?.id ?? "");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [upload, setUpload] = React.useState<UploadResult | null>(null);
  const [mapping, setMapping] = React.useState<Partial<Record<ImportField, string>>>({});
  const [dateFormat, setDateFormat] = React.useState("dd/MM/yyyy");
  const [saveTemplate, setSaveTemplate] = React.useState("");
  const [previewRows, setPreviewRows] = React.useState<PreviewRow[]>([]);
  const [excluded, setExcluded] = React.useState<Set<string>>(new Set());
  const [result, setResult] = React.useState<{ created: number; rulesApplied: number } | null>(null);
  const currency =
    accounts.find((a) => a.id === accountId)?.currencyCode ?? "INR";

  async function handleFile(file: File) {
    if (!accountId) {
      toast.error("Pick the account this statement belongs to first.");
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      const res = await uploadImport({
        accountId,
        fileName: file.name,
        csvText: text,
      });
      setFileName(file.name);
      setUpload(res);
      setMapping(res.suggestedMapping);
      setStep("map");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  function applyTemplate(template: Template) {
    setMapping(template.mapping as Partial<Record<ImportField, string>>);
    if (template.dateFormat) setDateFormat(template.dateFormat);
    toast.success(`Applied “${template.name}”`);
  }

  async function handleMap() {
    if (!upload) return;
    if (!mapping.date || !mapping.description || (!mapping.amount && !mapping.debit && !mapping.credit)) {
      toast.error("Map at least a date, a description, and an amount (or debit/credit).");
      return;
    }
    setBusy(true);
    try {
      await applyImportMapping({
        importFileId: upload.importFileId,
        mapping: mapping as Record<ImportField, string>,
        dateFormat,
        saveAsTemplate: saveTemplate.trim() || undefined,
      });
      const res = await fetch(`/api/imports/${upload.importFileId}`);
      const json = (await res.json()) as { data: { rows: PreviewRow[] } };
      setPreviewRows(json.data.rows);
      setExcluded(
        new Set(json.data.rows.filter((r) => r.status === "duplicate").map((r) => r.id)),
      );
      setStep("preview");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Mapping failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!upload) return;
    setBusy(true);
    try {
      const res = await commitImport({
        importFileId: upload.importFileId,
        excludedRowIds: [...excluded],
      });
      setResult(res);
      setStep("done");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setBusy(false);
    }
  }

  const importable = previewRows.filter(
    (r) => (r.status === "pending" || r.status === "duplicate") && !excluded.has(r.id),
  ).length;
  const errorCount = previewRows.filter((r) => r.status === "error").length;
  const duplicateCount = previewRows.filter((r) => r.status === "duplicate").length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Import a statement</CardTitle>
            <CardDescription>
              {step === "upload" && "Step 1 · Upload a CSV from your bank"}
              {step === "map" && `Step 2 · Map columns — ${fileName}`}
              {step === "preview" && `Step 3 · Review before committing — ${fileName}`}
              {step === "done" && "Imported"}
            </CardDescription>
          </div>
          <StepDots step={step} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {step === "upload" && (
          <>
            <Field>
              <FieldLabel>Account</FieldLabel>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue placeholder="Which account is this statement for?" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Duplicates are detected against this account’s existing
                transactions.
              </FieldDescription>
            </Field>

            <label
              className={cn(
                "flex min-h-44 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors hover:border-primary/50 hover:bg-accent/40",
                busy && "pointer-events-none opacity-60",
              )}
            >
              {busy ? (
                <Spinner className="size-6" />
              ) : (
                <HugeiconsIcon
                  icon={FileImportIcon}
                  className="size-8 text-muted-foreground"
                  strokeWidth={1.5}
                />
              )}
              <span className="text-sm font-medium">
                Drop a CSV here or tap to choose
              </span>
              <span className="text-xs text-muted-foreground">
                HDFC, ICICI, SBI, Axis exports work out of the box · max 5,000 rows
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                  e.target.value = "";
                }}
              />
            </label>
          </>
        )}

        {step === "map" && upload && (
          <>
            {templates.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Saved templates:</span>
                {templates.map((template) => (
                  <Button
                    key={template.id}
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => applyTemplate(template)}
                  >
                    {template.name}
                  </Button>
                ))}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {IMPORT_FIELDS.map((field) => (
                <Field key={field} orientation="horizontal">
                  <FieldLabel className="w-36 shrink-0 text-xs">
                    {FIELD_LABELS[field]}
                  </FieldLabel>
                  <Select
                    value={mapping[field] ?? "none"}
                    onValueChange={(v) =>
                      setMapping((prev) => ({
                        ...prev,
                        [field]: v === "none" ? undefined : v,
                      }))
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue placeholder="Not mapped" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not mapped</SelectItem>
                      {upload.headers.map((header) => (
                        <SelectItem key={header} value={header}>
                          {header}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Date format</FieldLabel>
                <Select value={dateFormat} onValueChange={setDateFormat}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATE_FORMATS.map((format) => (
                      <SelectItem key={format} value={format}>
                        {format}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Save as template</FieldLabel>
                <Input
                  value={saveTemplate}
                  onChange={(e) => setSaveTemplate(e.target.value)}
                  placeholder="e.g. HDFC savings (optional)"
                />
              </Field>
            </div>

            {/* Sample rows */}
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {upload.headers.map((header) => (
                      <TableHead key={header} className="text-xs whitespace-nowrap">
                        {header}
                        {Object.entries(mapping).find(([, col]) => col === header) && (
                          <Badge variant="secondary" className="ml-1.5 px-1 py-0 text-[9px]">
                            {Object.entries(mapping).find(([, col]) => col === header)?.[0]}
                          </Badge>
                        )}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upload.sampleRows.map((row, i) => (
                    <TableRow key={i}>
                      {upload.headers.map((header) => (
                        <TableCell
                          key={header}
                          className="max-w-48 truncate font-amount text-xs"
                        >
                          {row[header]}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep("upload")}>
                Back
              </Button>
              <Button onClick={handleMap} disabled={busy}>
                {busy && <Spinner />}
                Preview {upload.rowCount} rows
              </Button>
            </div>
          </>
        )}

        {step === "preview" && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">{importable} will import</Badge>
              {duplicateCount > 0 && (
                <Badge className="border-transparent bg-warning/15 text-warning-foreground dark:text-warning">
                  {duplicateCount} duplicates (excluded by default)
                </Badge>
              )}
              {errorCount > 0 && (
                <Badge variant="destructive">{errorCount} unparseable (skipped)</Badge>
              )}
            </div>

            <div className="max-h-96 overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs">Description</TableHead>
                    <TableHead className="text-right text-xs">Amount</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((row) => {
                    const isError = row.status === "error";
                    const included =
                      !isError && !excluded.has(row.id);
                    return (
                      <TableRow
                        key={row.id}
                        className={cn(isError && "opacity-50")}
                      >
                        <TableCell>
                          <Checkbox
                            checked={included}
                            disabled={isError}
                            onCheckedChange={() =>
                              setExcluded((prev) => {
                                const next = new Set(prev);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              })
                            }
                            aria-label={`Include row ${row.rowIndex + 1}`}
                          />
                        </TableCell>
                        <TableCell className="font-amount text-xs whitespace-nowrap">
                          {row.parsedDate ? formatDateShort(row.parsedDate) : "—"}
                        </TableCell>
                        <TableCell className="max-w-64">
                          <p className="truncate text-xs">{row.parsedDescription ?? "—"}</p>
                          {row.parseError && (
                            <p className="text-[10px] text-destructive">{row.parseError}</p>
                          )}
                          {row.duplicateOfTransaction && (
                            <p className="flex items-center gap-1 text-[10px] text-warning-foreground dark:text-warning">
                              <HugeiconsIcon icon={Copy01Icon} className="size-3" />
                              matches “{row.duplicateOfTransaction.description}” on{" "}
                              {formatDateShort(row.duplicateOfTransaction.date)}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-amount text-xs whitespace-nowrap">
                          {row.parsedAmountMinor !== null
                            ? formatMoney(row.parsedAmountMinor, currency, {
                                signDisplay: "exceptZero",
                              })
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.status === "duplicate"
                                ? "outline"
                                : isError
                                  ? "destructive"
                                  : "secondary"
                            }
                            className="text-[10px] capitalize"
                          >
                            {row.status === "pending" ? "ready" : row.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep("map")}>
                Back to mapping
              </Button>
              <Button onClick={handleCommit} disabled={busy || importable === 0}>
                {busy && <Spinner />}
                Import {importable} transactions
              </Button>
            </div>
          </>
        )}

        {step === "done" && result && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              className="size-10 text-success"
              strokeWidth={1.5}
            />
            <p className="text-lg font-medium">
              {result.created} transactions imported
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              They’re waiting in your inbox for review
              {result.rulesApplied > 0 &&
                ` — automation rules already enriched ${result.rulesApplied} of them`}
              .
            </p>
            <div className="mt-2 flex gap-2">
              <Button asChild>
                <Link href="/inbox">Review in inbox</Link>
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setStep("upload");
                  setUpload(null);
                  setResult(null);
                  setPreviewRows([]);
                  setExcluded(new Set());
                  setSaveTemplate("");
                }}
              >
                Import another file
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StepDots({ step }: { step: Step }) {
  const steps: Step[] = ["upload", "map", "preview", "done"];
  const current = steps.indexOf(step);
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {steps.slice(0, 3).map((s, i) => (
        <span
          key={s}
          className={cn(
            "h-1.5 rounded-full transition-all",
            i <= current ? "w-6 bg-primary" : "w-3 bg-muted",
          )}
        />
      ))}
    </div>
  );
}
