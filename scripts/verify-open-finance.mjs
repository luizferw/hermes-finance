/**
 * Check that an Open Finance item is actually readable, and report exactly what
 * a sync would create from it.
 *
 * This talks to Pluggy, not to Hermes, and it only reads. It exists because the
 * failure that costs the most time is invisible from inside the app: an item
 * that belongs to a different Pluggy application answers 404, which reads like a
 * typo rather than a missing authorization.
 *
 *   node scripts/verify-open-finance.mjs <itemId>
 *
 * Credentials come from the root .env (PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET).
 */
import { resolve } from "node:path";

try {
  process.loadEnvFile(resolve(import.meta.dirname, "../.env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const BASE = process.env.PLUGGY_BASE_URL ?? "https://api.pluggy.ai";
const CLIENT_ID = process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;
const itemId = process.argv[2];

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`\n  ${hint}\n`);
  process.exit(1);
}

if (!itemId) fail("usage: node scripts/verify-open-finance.mjs <itemId>");
if (!CLIENT_ID || !CLIENT_SECRET) {
  fail(
    "PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET are not set.",
    "Copy them from the application at dashboard.pluggy.ai into the root .env.",
  );
}

const money = (value, currency = "BRL") =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);

async function api(path, apiKey) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "X-API-KEY": apiKey, accept: "application/json" },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

const auth = await fetch(`${BASE}/auth`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
});
if (!auth.ok) {
  fail(`POST /auth answered ${auth.status}.`, "The client id or secret is wrong.");
}
const { apiKey } = await auth.json();
console.log("✓ credentials accepted");

const item = await api(`/items/${encodeURIComponent(itemId)}`, apiKey);
if (item.status === 404) {
  fail(
    "This item is not visible to these credentials (404 ITEM_NOT_FOUND).",
    "The credentials are valid, so the item belongs to a different Pluggy\n" +
      "  application. A connection made at meu.pluggy.ai is only readable after\n" +
      "  step 3 of meu.pluggy.ai/api-guide: open dashboard.pluggy.ai, enter the\n" +
      "  demo application and link your Meu Pluggy items. No new bank consent is\n" +
      "  needed, and the id does not change: the uuid in the meu.pluggy.ai address\n" +
      "  bar starts answering once the link exists.",
  );
}
if (item.status !== 200) {
  fail(`GET /items answered ${item.status}: ${item.body?.message ?? "unknown error"}`);
}

const connector = item.body.connector?.name ?? "?";
console.log(`✓ item found — ${connector}`);
console.log(`  status ${item.body.status} / execution ${item.body.executionStatus}`);
console.log(`  provider data from ${item.body.lastUpdatedAt ?? "?"}`);
if (item.body.consentExpiresAt) console.log(`  consent expires ${item.body.consentExpiresAt}`);

const accounts = await api(`/accounts?itemId=${encodeURIComponent(itemId)}`, apiKey);
if (accounts.status !== 200) fail(`GET /accounts answered ${accounts.status}`);

const results = accounts.body.results ?? [];
if (results.length === 0) {
  fail(
    "The item exists but returned no accounts.",
    "That is what an expired or revoked consent looks like: the data endpoints\n" +
      "  go empty rather than erroring. Reconnect the bank at meu.pluggy.ai.",
  );
}

console.log(`\nWhat a sync would create from ${results.length} provider account(s):\n`);
for (const account of results) {
  const type = account.type?.toUpperCase();
  const subtype = account.subtype?.toUpperCase() ?? null;
  const currency = account.currencyCode ?? "BRL";

  // Mirrors hermesAccountTypeFor in @hermes-finance/open-finance.
  const supported =
    type === "CREDIT"
      ? subtype === null || subtype === "CREDIT_CARD"
      : type === "BANK" &&
        (subtype === null || subtype === "CHECKING_ACCOUNT" || subtype === "SAVINGS_ACCOUNT");

  if (!supported) {
    console.log(`  · ${account.name} — ${type}/${subtype ?? "?"}`);
    console.log(`    SKIPPED: Hermes has no model for this account type yet.\n`);
    continue;
  }

  const hermesType = type === "CREDIT" ? "credit_card" : "asset";
  // A card's open bill is a debt, so Pluggy's positive balance is negated.
  const ledger = type === "CREDIT" ? -Math.abs(account.balance) : account.balance;

  console.log(`  · ${account.name} (${account.number ?? "?"}) — Hermes "${hermesType}"`);
  console.log(`    balance ${money(ledger, currency)} (provider says ${money(account.balance, currency)})`);

  if (hermesType === "credit_card") {
    const credit = account.creditData ?? {};
    console.log(`    limit ${money(credit.creditLimit, currency)}`);

    const bills = await api(`/bills?accountId=${encodeURIComponent(account.id)}`, apiKey);
    const billList = bills.body?.results ?? [];

    // Mirrors resolveCycleDays in modules/open-finance/cards.ts: creditData
    // describes the bill that is open now, and the newest closed bill is the
    // fallback for a card between cycles.
    let closing = credit.balanceCloseDate?.slice(8, 10) ?? null;
    let due = credit.balanceDueDate?.slice(8, 10) ?? null;
    let from = "the open bill";
    if (!closing || !due) {
      const latest = [...billList].sort((a, b) => (b.dueDate ?? "").localeCompare(a.dueDate ?? ""))[0];
      if (latest?.billClosingDate) {
        closing = latest.billClosingDate.slice(8, 10);
        due = latest.dueDate.slice(8, 10);
        from = "the newest bill";
      }
    }

    if (closing && due) {
      console.log(`    closes day ${closing}, due day ${due} (from ${from})`);
    } else {
      console.log("    WARNING: no closing/due day anywhere — the card profile will not be");
      console.log("             created, because every installment date derives from them.");
    }
    console.log(`    ${billList.length} bill(s) → billing cycles with a confirmed total`);
  }
  console.log();
}

console.log("✓ this item is ready to sync");
