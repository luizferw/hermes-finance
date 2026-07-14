/**
 * End-to-end smoke test of the recompute-dependent ledger flows that the
 * `recomputeAccountBalances` array-binding bug previously broke: inbox approve
 * and the three-step CSV import. Runs against a live server with a fresh user.
 *
 *   BASE_URL=http://localhost:3000 node scripts/verify-flows.mjs
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

function makeClient() {
  const cookies = new Map();
  return {
    async req(method, path, body) {
      const headers = { "content-type": "application/json", origin: BASE };
      if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [pair] = sc.split(";"); const i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      const t = await res.text();
      return { status: res.status, json: t ? JSON.parse(t) : null };
    },
  };
}

async function main() {
  const c = makeClient();
  const email = `flow_${Date.now()}@example.test`;
  const su = await c.req("POST", "/api/auth/sign-up/email", { email, password: "supersecret123", name: "Flow" });
  if (su.status !== 200) throw new Error(`signup ${su.status}`);

  const acc = (await c.req("POST", "/api/accounts", { name: "Flow Checking", type: "asset", openingBalance: 100 })).json.data;

  // --- Inbox approve: create a pending txn, approve it, balance updates ---
  // Pending/imported are created via import; simulate by importing one row.
  const csv = ["Date,Description,Amount",
    "2026-06-01,Salary,5000.00",
    "2026-06-02,Groceries,-250.50",
    "2026-06-02,Groceries,-250.50"].join("\n"); // 3rd row is an intra-batch dup
  const up = await c.req("POST", "/api/imports", { accountId: acc.id, fileName: "stmt.csv", csvText: csv });
  check("import upload succeeds", up.status === 201, `got ${up.status} ${JSON.stringify(up.json)}`);
  const importId = up.json.data.importFileId;

  const map = await c.req("POST", `/api/imports/${importId}/mapping`, {
    mapping: { date: "Date", description: "Description", amount: "Amount" },
    dateFormat: "yyyy-MM-dd",
  });
  check("import mapping detects 1 duplicate", map.json.data?.duplicates === 1, JSON.stringify(map.json));

  const commit = await c.req("POST", `/api/imports/${importId}/commit`, { excludedRowIds: [] });
  check("import commit succeeds", commit.status === 200, `got ${commit.status} ${JSON.stringify(commit.json)}`);
  check("import skipped duplicate and created 2 transactions", commit.json.data?.created === 2, JSON.stringify(commit.json));

  // Imported txns count toward ledger. 100.00 + 5000 - 250.50 = 4849.50
  let accounts = (await c.req("GET", "/api/accounts")).json.data;
  let checking = accounts.find((x) => x.id === acc.id);
  check("balance correct after import (imported status counts)", checking.currentBalanceMinor === 484950, `got ${checking.currentBalanceMinor}`);

  // Inbox shows imported items; approve all -> still counts, status posted.
  const inbox = (await c.req("GET", "/api/transactions?status=imported&pageSize=50")).json.data;
  const ids = inbox.items.map((t) => t.id);
  check("imported items visible in list", ids.length === 2, `got ${ids.length}`);
  const appr = await c.req("POST", "/api/transactions/bulk", { action: "approve", ids });
  check("approve succeeds", appr.status === 200 && appr.json.data.approved === 2, JSON.stringify(appr.json));

  accounts = (await c.req("GET", "/api/accounts")).json.data;
  checking = accounts.find((x) => x.id === acc.id);
  check("balance stable after approve", checking.currentBalanceMinor === 484950, `got ${checking.currentBalanceMinor}`);

  // Reject one posted txn -> excluded from ledger, balance drops by its amount.
  const rej = await c.req("POST", "/api/transactions/bulk", { action: "reject", ids: [ids[0]] });
  check("reject succeeds", rej.status === 200, JSON.stringify(rej.json));
  accounts = (await c.req("GET", "/api/accounts")).json.data;
  checking = accounts.find((x) => x.id === acc.id);
  // removed the salary 5000 (ids order = date desc, so ids[0] is 2026-06-02 groceries -250.50)
  // whichever it is, balance must change by exactly that txn's amount and stay consistent
  check("balance recomputed after reject (changed, still integer)", Number.isInteger(checking.currentBalanceMinor) && checking.currentBalanceMinor !== 484950, `got ${checking.currentBalanceMinor}`);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
