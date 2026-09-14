import type { SyncRunRow } from "@/modules/open-finance/queries";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function tone(status: string): "default" | "secondary" | "destructive" {
  if (status === "error") return "destructive";
  if (status === "partial" || status === "running") return "secondary";
  return "default";
}

export function SyncRunsTable({ runs }: { runs: SyncRunRow[] }) {
  if (runs.length === 0) {
    return <p className="text-muted-foreground text-sm">No syncs yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Institution</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Seen</TableHead>
            <TableHead className="text-right">New</TableHead>
            <TableHead className="text-right">Updated</TableHead>
            {/* Skipped is shown because it is where the card bill payments go:
                a number that quietly grows is a number worth seeing. */}
            <TableHead className="text-right">Skipped</TableHead>
            <TableHead className="text-right">To review</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell className="whitespace-nowrap">
                {run.startedAt.toLocaleString()}
              </TableCell>
              <TableCell>{run.institution ?? "—"}</TableCell>
              <TableCell>
                <Badge variant={tone(run.status)}>{run.status}</Badge>
                {run.error ? (
                  <span className="text-muted-foreground ml-2 text-xs">{run.error}</span>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">{run.recordsSeen}</TableCell>
              <TableCell className="text-right tabular-nums">{run.recordsCreated}</TableCell>
              <TableCell className="text-right tabular-nums">{run.recordsUpdated}</TableCell>
              <TableCell className="text-right tabular-nums">{run.skipped}</TableCell>
              <TableCell className="text-right tabular-nums">{run.needsReview}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
