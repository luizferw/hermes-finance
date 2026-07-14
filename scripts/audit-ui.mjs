/**
 * Headless browser audit of interactive features. Logs in as the demo user and
 * exercises the command menu, navigation, and every "new …" dialog, collecting
 * console errors and page exceptions per route.
 *
 *   BASE_URL=http://localhost:3000 node scripts/audit-ui.mjs
 */
import pw from "/tmp/pgtmp/node_modules/playwright/index.js";
const { chromium } = pw;

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const results = [];
function log(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

const consoleErrors = [];
function attach(page) {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`[${page.url()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`[${page.url()}] PAGEERROR ${e.message}`));
}

const ROUTES = [
  "/overview", "/transactions", "/inbox", "/accounts", "/plan",
  "/plan/budgets", "/plan/bills", "/plan/goals", "/plan/recurring",
  "/automations", "/reports", "/settings", "/settings/health", "/transactions/import",
];

// Dialogs reachable via ?new=1 or a visible trigger button.
const NEW_DIALOGS = [
  { route: "/accounts?new=1", label: "New account" },
  { route: "/transactions?new=1", label: "New transaction" },
  { route: "/plan/budgets?new=1", label: "New budget" },
  { route: "/plan/bills?new=1", label: "New bill" },
  { route: "/plan/goals?new=1", label: "New goal" },
  { route: "/plan/recurring?new=1", label: "New recurring" },
  { route: "/automations?new=1", label: "New rule" },
];

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  attach(page);

  // --- login ---
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', "demo@kosh.local");
  await page.fill('input[type="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 }).catch(() => {});
  log("login redirects away from /login", !page.url().includes("/login"), page.url());

  // --- Ctrl+K command menu ---
  await page.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  const opened = await dialog.isVisible().catch(() => false);
  log("Ctrl+K opens command menu", opened);

  if (opened) {
    // typing should filter the list (cmdk context working)
    await page.keyboard.type("budget");
    await page.waitForTimeout(300);
    const items = await page.locator('[data-slot="command-item"]:visible').allInnerTexts();
    const filtered = items.length > 0 && items.every((t) => /budget/i.test(t));
    log("command menu filters as you type", filtered, `visible: ${JSON.stringify(items)}`);

    // selecting navigates
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    log("command menu item navigates", /\/plan\/budgets|\/plan/.test(page.url()), page.url());
  }

  // --- per-route error sweep ---
  for (const r of ROUTES) {
    const before = consoleErrors.length;
    const resp = await page.goto(`${BASE}${r}`, { waitUntil: "networkidle" }).catch(() => null);
    await page.waitForTimeout(250);
    const status = resp?.status() ?? 0;
    const newErrors = consoleErrors.slice(before);
    log(`route ${r} renders without errors`, status === 200 && newErrors.length === 0,
      `status=${status}${newErrors.length ? ` errors=${newErrors.length}` : ""}`);
  }

  // --- new dialogs open and show a form ---
  for (const d of NEW_DIALOGS) {
    const before = consoleErrors.length;
    await page.goto(`${BASE}${d.route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    let visible = await page.getByRole("dialog").isVisible().catch(() => false);
    // fall back to clicking a button with the label if ?new=1 didn't auto-open
    if (!visible) {
      const btn = page.getByRole("button", { name: new RegExp(d.label, "i") }).first();
      if (await btn.count()) { await btn.click(); await page.waitForTimeout(400); visible = await page.getByRole("dialog").isVisible().catch(() => false); }
    }
    const hasForm = visible && (await page.locator('[role="dialog"] input, [role="dialog"] button[type="submit"]').count()) > 0;
    const newErrors = consoleErrors.slice(before);
    log(`dialog "${d.label}" opens with a form`, !!hasForm && newErrors.length === 0,
      `visible=${visible}${newErrors.length ? ` errors=${newErrors.length}` : ""}`);
    await page.keyboard.press("Escape").catch(() => {});
  }

  await browser.close();

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  if (consoleErrors.length) {
    console.log(`\n--- ${consoleErrors.length} console/page errors (deduped) ---`);
    [...new Set(consoleErrors)].slice(0, 30).forEach((e) => console.log("  " + e.slice(0, 300)));
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
