import { toCsv } from "@kosh/domain";
import { getApiUser } from "@/lib/session";
import { getTransactionsForExport } from "@/modules/export/queries";

const HEADERS = [
  "Date",
  "Type",
  "Status",
  "Account",
  "Transfer account",
  "Category",
  "Amount",
  "Currency",
  "Description",
  "Merchant",
  "Notes",
];

export async function GET() {
  const user = await getApiUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const rows = await getTransactionsForExport(user.id);
  const csv = toCsv(
    HEADERS,
    rows.map((r) => [
      r.date,
      r.type,
      r.status,
      r.account,
      r.transferAccount,
      r.category,
      r.amount,
      r.currency,
      r.description,
      r.merchant,
      r.notes,
    ]),
  );
  const filename = `kosh-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
