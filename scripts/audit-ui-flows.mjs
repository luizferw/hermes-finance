/**
 * Deeper headless audit: actually performs writes/interactions through the UI
 * (not just "does the dialog open") to catch dead controls and broken wiring.
 *   BASE_URL=http://localhost:3000 node scripts/audit-ui-flows.mjs
 */
import pw from "/tmp/pgtmp/node_modules/playwright/index.js";
const { chromium } = pw;
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const results = [];
const errs = [];
const ok = (n, c, d) => { results.push(c); console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', "demo@kosh.local");
  await page.fill('input[type="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 }).catch(() => {});
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1280, height: 900 } }).then((c) => c.newPage());
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));

  await login(page);

  // 1) Create an account through the dialog, confirm it lands in the list.
  const unique = "Audit Acct " + Date.now();
  await page.goto(`${BASE}/accounts?new=1`, { waitUntil: "networkidle" });
  await page.getByRole("dialog").waitFor({ timeout: 8000 });
  await page.fill("#acc-name", unique);
  await page.fill("#acc-opening", "1234.56");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForTimeout(1500);
  await page.goto(`${BASE}/accounts`, { waitUntil: "networkidle" });
  ok("New-account form actually creates the account",
    (await page.getByText(unique, { exact: false }).count()) > 0, unique);

  // 2) Transactions search filter narrows results.
  await page.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
  const searchBox = page.getByPlaceholder(/search/i).first();
  ok("transactions page has a search box", await searchBox.count() > 0);
  if (await searchBox.count()) {
    const rowSel = "ul.divide-y > li";
    await page.locator(rowSel).first().waitFor({ timeout: 8000 }).catch(() => {});
    const rowsBefore = await page.locator(rowSel).count();
    await searchBox.fill("swiggy");
    await page.waitForTimeout(1500);
    const rowsAfter = await page.locator(rowSel).count();
    ok("transactions search filters the list", rowsBefore > 0 && rowsAfter > 0 && rowsAfter < rowsBefore, `before=${rowsBefore} after=${rowsAfter}`);
  }

  // 3) Command menu "New transaction" opens the create dialog (cross-route action).
  await page.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  await page.keyboard.type("new transaction");
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  ok("command menu 'New transaction' opens the transaction dialog",
    page.url().includes("/transactions") && (await page.getByRole("dialog").isVisible().catch(() => false)));

  // 3b) Command menu live transaction search → jump to the matched transaction.
  await page.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  await page.keyboard.type("swiggy");
  // wait for the debounced live results (rows carry an amount; the static
  // "See all" row does not) — avoids racing the instantly-rendered see-all item
  await page.waitForFunction(() => {
    const items = [...document.querySelectorAll('[data-slot="command-item"]')];
    return items.some((el) => /swiggy/i.test(el.textContent || "") && /₹/.test(el.textContent || ""));
  }, { timeout: 8000 }).catch(() => {});
  const txItems = await page.locator('[data-slot="command-item"]', { hasText: /₹/ }).count();
  ok("Ctrl+K live-searches transactions", txItems > 0, `result rows: ${txItems}`);
  // Enter jumps straight to the top match and opens its detail sheet.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const jumped = page.url().includes("/transactions?focus=") &&
    (await page.getByRole("dialog").isVisible().catch(() => false));
  ok("Enter jumps straight to the matched transaction", jumped, page.url());

  // 4) Reports page renders chart content (svg), not an empty shell.
  await page.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  ok("reports page renders charts", (await page.locator("svg.recharts-surface, .recharts-wrapper").count()) > 0);

  // 5) User menu → sign out returns to login.
  await page.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
  const trigger = page.getByRole("button", { name: /demo|account|menu/i }).first();
  if (await trigger.count()) {
    await trigger.click();
    await page.waitForTimeout(300);
    const signOut = page.getByRole("menuitem", { name: /sign out|log ?out/i }).first();
    if (await signOut.count()) {
      await signOut.click();
      await page.waitForTimeout(1500);
      ok("sign out returns to login", page.url().includes("/login"), page.url());
    } else ok("sign out menu item present", false, "not found");
  } else ok("user menu present", false, "trigger not found");

  await browser.close();
  console.log(`\n${results.filter(Boolean).length}/${results.length} flow checks passed`);
  if (errs.length) { console.log(`\n--- ${errs.length} console errors ---`); [...new Set(errs)].slice(0, 20).forEach((e) => console.log("  " + e.slice(0, 250))); }
  if (results.some((r) => !r)) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
