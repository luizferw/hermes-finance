/**
 * End-to-end security + financial-correctness checks against a running Kosh
 * server. Exercises cross-tenant access (IDOR) and ledger balance math over
 * the real HTTP API with two separate authenticated users.
 *
 * Usage (server must be running and pointed at a disposable database):
 *   BASE_URL=http://localhost:3000 node scripts/verify-security.mjs
 *
 * Exits non-zero on the first failed assertion.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Minimal cookie-jar HTTP client bound to one user session. */
function makeClient() {
  const cookies = new Map();
  return {
    async req(method, path, body) {
      const headers = { "content-type": "application/json", origin: BASE };
      if (cookies.size) {
        headers.cookie = [...cookies.entries()]
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
      }
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [pair] = sc.split(";");
        const idx = pair.indexOf("=");
        cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, json };
    },
  };
}

async function signUp(client, email) {
  const res = await client.req("POST", "/api/auth/sign-up/email", {
    email,
    password: "supersecret123",
    name: email.split("@")[0],
  });
  if (res.status !== 200) {
    throw new Error(`sign-up failed for ${email}: ${res.status} ${JSON.stringify(res.json)}`);
  }
}

async function main() {
  const stamp = Date.now();
  const a = makeClient();
  const b = makeClient();
  await signUp(a, `a_${stamp}@example.test`);
  await signUp(b, `b_${stamp}@example.test`);

  // Each user gets two accounts and a category.
  const aAcc1 = (await a.req("POST", "/api/accounts", { name: "A Checking", type: "asset", openingBalance: 1000 })).json.data;
  const aAcc2 = (await a.req("POST", "/api/accounts", { name: "A Savings", type: "asset", openingBalance: 0 })).json.data;
  const bAcc1 = (await b.req("POST", "/api/accounts", { name: "B Checking", type: "asset", openingBalance: 500 })).json.data;
  const aCat = (await a.req("POST", "/api/categories", { name: "A Food" })).json.data;
  const bCat = (await b.req("POST", "/api/categories", { name: "B Food" })).json.data;

  // --- IDOR: A cannot use B's category on a new transaction ---
  let r = await a.req("POST", "/api/transactions", {
    accountId: aAcc1.id,
    type: "expense",
    date: "2026-06-01",
    amount: 50,
    description: "cross-tenant category",
    categoryId: bCat.id,
  });
  check("create txn with another user's category is rejected", r.status === 404, `got ${r.status}`);

  // --- IDOR: A cannot transfer into B's account ---
  r = await a.req("POST", "/api/transactions", {
    accountId: aAcc1.id,
    transferAccountId: bAcc1.id,
    type: "transfer",
    date: "2026-06-01",
    amount: 100,
    description: "cross-tenant transfer",
  });
  check("transfer into another user's account is rejected", r.status === 404, `got ${r.status}`);

  // B's balance must be untouched by A's attempt.
  let bAccounts = (await b.req("GET", "/api/accounts")).json.data;
  let bChecking = bAccounts.find((x) => x.id === bAcc1.id);
  check("victim balance unchanged after cross-tenant transfer attempt", bChecking.currentBalanceMinor === 50000, `got ${bChecking?.currentBalanceMinor}`);

  // --- IDOR: A cannot bulk-categorize using B's category ---
  const aTxn = (await a.req("POST", "/api/transactions", {
    accountId: aAcc1.id, type: "expense", date: "2026-06-02", amount: 20, description: "lunch",
  })).json.data;
  r = await a.req("POST", "/api/transactions/bulk", { action: "categorize", ids: [aTxn.id], categoryId: bCat.id });
  check("bulk categorize with another user's category is rejected", r.status === 404, `got ${r.status}`);

  // --- IDOR: A cannot read or mutate B's transaction ---
  const bTxn = (await b.req("POST", "/api/transactions", {
    accountId: bAcc1.id, type: "income", date: "2026-06-02", amount: 30, description: "B income",
  })).json.data;
  r = await a.req("GET", `/api/transactions/${bTxn.id}`);
  check("read another user's transaction returns 404", r.status === 404, `got ${r.status}`);
  r = await a.req("DELETE", `/api/transactions/${bTxn.id}`);
  check("delete another user's transaction returns 404", r.status === 404, `got ${r.status}`);

  // --- Financial correctness: legit expense + transfer recompute correctly ---
  // A Checking opened at 1000.00 (100000 minor). Created: 20.00 expense above.
  // Add a 200.00 transfer A Checking -> A Savings.
  r = await a.req("POST", "/api/transactions", {
    accountId: aAcc1.id, transferAccountId: aAcc2.id, type: "transfer",
    date: "2026-06-03", amount: 200, description: "to savings",
  });
  check("legit same-user transfer succeeds", r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);

  const aAccounts = (await a.req("GET", "/api/accounts")).json.data;
  const checking = aAccounts.find((x) => x.id === aAcc1.id);
  const savings = aAccounts.find((x) => x.id === aAcc2.id);
  // 100000 - 2000 (expense) - 20000 (transfer out) = 78000
  check("source balance correct after expense + transfer", checking.currentBalanceMinor === 78000, `got ${checking.currentBalanceMinor}`);
  // 0 + 20000 (incoming transfer) = 20000
  check("destination balance correct after incoming transfer", savings.currentBalanceMinor === 20000, `got ${savings.currentBalanceMinor}`);

  // --- Cross-currency transfer guard ---
  const aEur = (await a.req("POST", "/api/accounts", { name: "A EUR", type: "asset", currencyCode: "EUR", openingBalance: 0 })).json.data;
  r = await a.req("POST", "/api/transactions", {
    accountId: aAcc1.id, transferAccountId: aEur.id, type: "transfer",
    date: "2026-06-04", amount: 10, description: "cross currency",
  });
  check("cross-currency transfer is rejected (422)", r.status === 422, `got ${r.status}`);

  // --- Unauthenticated access is blocked ---
  const anon = makeClient();
  r = await anon.req("GET", "/api/transactions");
  check("unauthenticated API access returns 401", r.status === 401, `got ${r.status}`);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
