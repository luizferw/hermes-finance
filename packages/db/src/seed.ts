/**
 * Demo seed for development and screenshots.
 *
 * Creates a demo user (demo@kosh.local / demo1234) with ~4 months of
 * realistic india-flavored finances: accounts, transactions, splits, tags,
 * budgets, bills, recurring templates, savings goals, automation rules,
 * an import file with rows in the review inbox, audit logs, and daily
 * balance snapshots. Idempotent: re-running wipes and recreates demo data.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashPassword } from "better-auth/crypto";
import {
  balanceDelta,
  computeImportHash,
  toIsoDate,
  addMonthsClamped,
  type LedgerEntry,
} from "@kosh/domain";
import * as schema from "./schema";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env"), quiet: true });

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://kosh:kosh@localhost:5432/kosh";

const DEMO_EMAIL = "demo@kosh.local";
const DEMO_PASSWORD = "demo1234";
const CURRENCY = "INR";

/** Deterministic PRNG so the demo data is stable between runs. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260611);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
const between = (min: number, max: number) =>
  Math.round(min + rand() * (max - min));
/** Random rupee amount, returned in paise. */
const rupees = (min: number, max: number) => between(min, max) * 100;

function iso(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return toIsoDate(d);
}

const TODAY = iso(0);
const HISTORY_DAYS = 135;

interface TxSeed {
  id: string;
  accountId: string;
  transferAccountId?: string | null;
  type: "income" | "expense" | "transfer" | "adjustment" | "opening_balance";
  status: "pending" | "imported" | "reviewed" | "posted" | "rejected";
  date: string;
  valueDate?: string | null;
  amountMinor: number;
  description: string;
  merchant?: string | null;
  rawDescription?: string | null;
  narration?: string | null;
  categoryId?: string | null;
  billId?: string | null;
  externalId?: string | null;
  upiReference?: string | null;
  counterpartyUpiId?: string | null;
  utrNumber?: string | null;
  importHash?: string | null;
  importFileId?: string | null;
  recurringTransactionId?: string | null;
  suspectedDuplicateOfId?: string | null;
  notes?: string | null;
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const db = drizzle(pool, { schema });

  console.log("Seeding Kosh demo data...");

  // --- user (wipe + recreate; everything else cascades) -------------------
  await db.delete(schema.users).where(eq(schema.users.email, DEMO_EMAIL));

  const userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    name: "Demo User",
    email: DEMO_EMAIL,
    emailVerified: true,
  });
  await db.insert(schema.authAccounts).values({
    id: randomUUID(),
    userId,
    accountId: userId,
    providerId: "credential",
    password: await hashPassword(DEMO_PASSWORD),
  });
  await db.insert(schema.userSettings).values({
    userId,
    currencyCode: CURRENCY,
    locale: "en-IN",
  });

  // --- accounts ------------------------------------------------------------
  const mkAccount = async (
    values: Omit<typeof schema.accounts.$inferInsert, "userId" | "id">,
  ) => {
    const id = randomUUID();
    await db.insert(schema.accounts).values({ ...values, id, userId });
    return id;
  };

  const openingDate = iso(HISTORY_DAYS);
  const hdfc = await mkAccount({
    name: "HDFC Salary Account",
    type: "asset",
    currencyCode: CURRENCY,
    institution: "HDFC Bank",
    accountNumberMask: "••6741",
    upiId: "demo@okhdfcbank",
    openingBalanceMinor: 18_500_000, // ₹1,85,000
    openingBalanceDate: openingDate,
  });
  const icici = await mkAccount({
    name: "ICICI Savings",
    type: "asset",
    currencyCode: CURRENCY,
    institution: "ICICI Bank",
    accountNumberMask: "••2210",
    openingBalanceMinor: 52_000_000, // ₹5,20,000
    openingBalanceDate: openingDate,
  });
  const sbi = await mkAccount({
    name: "SBI Emergency Fund",
    type: "asset",
    currencyCode: CURRENCY,
    institution: "State Bank of India",
    accountNumberMask: "••0094",
    openingBalanceMinor: 30_000_000, // ₹3,00,000
    openingBalanceDate: openingDate,
  });
  const card = await mkAccount({
    name: "HDFC Millennia Card",
    type: "credit_card",
    currencyCode: CURRENCY,
    institution: "HDFC Bank",
    accountNumberMask: "••4417",
    openingBalanceMinor: 0,
    openingBalanceDate: openingDate,
    limitMinor: 20_000_000, // ₹2,00,000 limit
  });
  const cash = await mkAccount({
    name: "Cash Wallet",
    type: "cash",
    currencyCode: CURRENCY,
    openingBalanceMinor: 600_000, // ₹6,000
    openingBalanceDate: openingDate,
  });
  const carLoan = await mkAccount({
    name: "Car Loan",
    type: "liability",
    currencyCode: CURRENCY,
    institution: "HDFC Bank",
    openingBalanceMinor: -42_000_000, // ₹4,20,000 outstanding
    openingBalanceDate: openingDate,
    limitMinor: 65_000_000, // original principal ₹6,50,000
    notes: "60-month auto loan, EMI ₹18,500 on the 7th",
  });

  // --- categories ----------------------------------------------------------
  const categoryDefs: Array<[string, string, string]> = [
    ["Salary", "briefcase", "var(--chart-1)"],
    ["Rent", "home", "var(--chart-2)"],
    ["Groceries", "cart", "var(--chart-3)"],
    ["Eating Out", "utensils", "var(--chart-4)"],
    ["Transport", "car", "var(--chart-5)"],
    ["Utilities", "bolt", "var(--chart-1)"],
    ["Subscriptions", "tv", "var(--chart-2)"],
    ["Shopping", "bag", "var(--chart-3)"],
    ["Health", "heart", "var(--chart-4)"],
    ["Entertainment", "film", "var(--chart-5)"],
    ["Travel", "plane", "var(--chart-1)"],
    ["Investments", "trending-up", "var(--chart-2)"],
    ["EMI", "credit-card", "var(--chart-3)"],
    ["Household", "package", "var(--chart-4)"],
  ];
  const cat: Record<string, string> = {};
  for (const [name, icon, color] of categoryDefs) {
    const id = randomUUID();
    await db.insert(schema.categories).values({ id, userId, name, icon, color });
    cat[name] = id;
  }

  // --- tags ------------------------------------------------------------------
  const tagDefs = ["online", "reimbursable", "family", "trip-goa", "large"];
  const tag: Record<string, string> = {};
  for (const name of tagDefs) {
    const id = randomUUID();
    await db.insert(schema.tags).values({ id, userId, name });
    tag[name] = id;
  }

  // --- transaction generation ------------------------------------------------
  const txs: TxSeed[] = [];
  const tagLinks: Array<{ transactionId: string; tagId: string }> = [];

  const upiRaw = (merchant: string, handle: string) =>
    `UPI-${merchant.toUpperCase()}-${handle}-${between(400000000, 999999999)}`;

  const addTx = (t: Omit<TxSeed, "id">): TxSeed => {
    const full: TxSeed = { id: randomUUID(), ...t };
    if (
      full.rawDescription &&
      !full.importHash &&
      (full.status === "posted" || full.status === "imported" || full.status === "reviewed")
    ) {
      full.importHash = computeImportHash({
        accountId: full.accountId,
        date: full.date,
        amountMinor: full.amountMinor,
        description: full.rawDescription,
      });
    }
    txs.push(full);
    return full;
  };

  // Walk month by month from history start to today.
  let cardSpendThisCycle = 0;
  for (let daysAgo = HISTORY_DAYS; daysAgo >= 0; daysAgo--) {
    const date = iso(daysAgo);
    const day = Number(date.slice(8, 10));
    const isFuture = false;
    if (isFuture) continue;

    // Salary on the 1st.
    if (day === 1) {
      addTx({
        accountId: hdfc,
        type: "income",
        status: "posted",
        date,
        amountMinor: 15_500_000, // ₹1,55,000
        description: "Salary — Acme Technologies",
        merchant: "Acme Technologies",
        rawDescription: `NEFT-ACME TECHNOLOGIES PVT LTD-SALARY ${date.slice(0, 7)}`,
        utrNumber: `N${between(100000000000, 999999999999)}`,
        categoryId: cat.Salary,
      });
    }
    // Rent on the 2nd.
    if (day === 2) {
      addTx({
        accountId: hdfc,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -3_500_000,
        description: "Rent — Skyline Residency",
        merchant: "Skyline Residency",
        rawDescription: upiRaw("RENTPAY", "landlord@oksbi"),
        upiReference: String(between(100000000000, 999999999999)),
        counterpartyUpiId: "landlord@oksbi",
        categoryId: cat.Rent,
      });
    }
    // SIP transfer to ICICI on the 5th.
    if (day === 5) {
      addTx({
        accountId: hdfc,
        transferAccountId: icici,
        type: "transfer",
        status: "posted",
        date,
        amountMinor: -2_000_000,
        description: "SIP transfer to savings",
        rawDescription: "ACH-INDEX FUND SIP-AUTOPAY",
        categoryId: cat.Investments,
      });
    }
    // Car loan EMI on the 7th (transfer into the liability account).
    if (day === 7) {
      addTx({
        accountId: hdfc,
        transferAccountId: carLoan,
        type: "transfer",
        status: "posted",
        date,
        amountMinor: -1_850_000,
        description: "Car loan EMI",
        rawDescription: "ACH-HDFC AUTO LOAN EMI",
        categoryId: cat.EMI,
      });
    }
    // Subscriptions on the card.
    if (day === 3) {
      const t = addTx({
        accountId: card,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -64_900,
        description: "Netflix",
        merchant: "Netflix",
        rawDescription: "NETFLIX.COM MUMBAI IN",
        categoryId: cat.Subscriptions,
      });
      cardSpendThisCycle += 64_900;
      tagLinks.push({ transactionId: t.id, tagId: tag.online! });
    }
    if (day === 4) {
      addTx({
        accountId: card,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -11_900,
        description: "Spotify",
        merchant: "Spotify",
        rawDescription: "SPOTIFY SI MUMBAI IN",
        categoryId: cat.Subscriptions,
      });
      cardSpendThisCycle += 11_900;
    }
    if (day === 6) {
      addTx({
        accountId: hdfc,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -119_900,
        description: "Jio Fiber",
        merchant: "Jio",
        rawDescription: upiRaw("JIOFIBER", "jio@jio"),
        categoryId: cat.Utilities,
      });
    }
    // Electricity on the 10th — except the current month (left unpaid so the
    // bill shows as overdue in the demo).
    if (day === 10 && daysAgo > 5) {
      addTx({
        accountId: hdfc,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -rupees(1900, 2800),
        description: "BESCOM electricity",
        merchant: "BESCOM",
        rawDescription: upiRaw("BESCOM", "bescom@axis"),
        categoryId: cat.Utilities,
      });
    }
    // Credit card bill payment on the 18th.
    if (day === 18 && cardSpendThisCycle > 0) {
      addTx({
        accountId: hdfc,
        transferAccountId: card,
        type: "transfer",
        status: "posted",
        date,
        amountMinor: -cardSpendThisCycle,
        description: "Credit card bill payment",
        rawDescription: "IB BILLPAY HDFC CARD ••4417",
        categoryId: null,
      });
      cardSpendThisCycle = 0;
    }

    // Day-level random spending.
    if (rand() < 0.28) {
      const grocer = pick(["BigBasket", "Zepto", "Blinkit", "DMart"]);
      const onCard = rand() < 0.3;
      const amount = -rupees(350, 2400);
      if (onCard) cardSpendThisCycle += -amount;
      addTx({
        accountId: onCard ? card : hdfc,
        type: "expense",
        status: "posted",
        date,
        amountMinor: amount,
        description: grocer,
        merchant: grocer,
        rawDescription: onCard
          ? `${grocer.toUpperCase()} BANGALORE IN`
          : upiRaw(grocer, `${grocer.toLowerCase()}@ybl`),
        upiReference: onCard ? null : String(between(100000000000, 999999999999)),
        categoryId: cat.Groceries,
      });
    }
    if (rand() < 0.3) {
      const resto = pick(["Swiggy", "Zomato", "Swiggy", "Third Wave Coffee", "McDonald's"]);
      addTx({
        accountId: hdfc,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -rupees(180, 850),
        description: resto,
        merchant: resto,
        rawDescription: upiRaw(resto.replace(/[^A-Za-z]/g, ""), `${resto.split(" ")[0]!.toLowerCase()}@icici`),
        upiReference: String(between(100000000000, 999999999999)),
        categoryId: cat["Eating Out"],
      });
    }
    if (rand() < 0.32) {
      const ride = pick(["Uber", "Ola", "Rapido", "Namma Metro"]);
      addTx({
        accountId: hdfc,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -rupees(60, 420),
        description: ride,
        merchant: ride,
        rawDescription: upiRaw(ride.replace(" ", ""), `${ride.split(" ")[0]!.toLowerCase()}@paytm`),
        categoryId: cat.Transport,
      });
    }
    if (rand() < 0.09) {
      const shop = pick(["Amazon", "Flipkart", "Myntra", "Decathlon"]);
      const amount = -rupees(500, 7500);
      cardSpendThisCycle += -amount;
      const t = addTx({
        accountId: card,
        type: "expense",
        status: "posted",
        date,
        amountMinor: amount,
        description: shop,
        merchant: shop,
        rawDescription: `${shop.toUpperCase()} IN`,
        categoryId: cat.Shopping,
      });
      tagLinks.push({ transactionId: t.id, tagId: tag.online! });
      if (amount < -500_000) tagLinks.push({ transactionId: t.id, tagId: tag.large! });
    }
    if (rand() < 0.05) {
      addTx({
        accountId: hdfc,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -rupees(250, 1400),
        description: pick(["Apollo Pharmacy", "Practo", "1mg"]),
        merchant: "Apollo Pharmacy",
        rawDescription: upiRaw("APOLLO", "apollo@hdfc"),
        categoryId: cat.Health,
      });
    }
    if (rand() < 0.06) {
      const fun = pick(["BookMyShow", "PVR Cinemas", "Steam"]);
      addTx({
        accountId: hdfc,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -rupees(300, 1600),
        description: fun,
        merchant: fun,
        rawDescription: upiRaw(fun.replace(/[^A-Za-z]/g, ""), "bms@hdfc"),
        categoryId: cat.Entertainment,
      });
    }
    if (rand() < 0.1) {
      addTx({
        accountId: cash,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -rupees(30, 250),
        description: pick(["Chai stall", "Auto fare", "Street food", "Fruit vendor"]),
        categoryId: pick([cat.Transport!, cat["Eating Out"]!, cat.Groceries!]),
      });
    }
    // Petrol twice a month.
    if (day === 9 || day === 24) {
      addTx({
        accountId: hdfc,
        type: "expense",
        status: "posted",
        date,
        amountMinor: -rupees(1700, 2300),
        description: "Indian Oil petrol pump",
        merchant: "Indian Oil",
        rawDescription: upiRaw("IOCL", "iocl@sbi"),
        categoryId: cat.Transport,
      });
    }
    // Cash withdrawal monthly.
    if (day === 12) {
      addTx({
        accountId: hdfc,
        transferAccountId: cash,
        type: "transfer",
        status: "posted",
        date,
        amountMinor: -500_000,
        description: "ATM cash withdrawal",
        rawDescription: "ATM-CASH WDL HDFC BANK",
      });
    }
  }

  // --- one multi-split transaction ----------------------------------------
  const splitTx = addTx({
    accountId: card,
    type: "expense",
    status: "posted",
    date: iso(16),
    amountMinor: -468_500,
    description: "DMart monthly haul",
    merchant: "DMart",
    rawDescription: "DMART AVENUE SUPERMARTS BANGALORE IN",
    categoryId: cat.Groceries,
    notes: "Split between groceries and household items",
  });
  cardSpendThisCycle += 468_500;

  // --- imported batch waiting in the inbox ----------------------------------
  const importFileId = randomUUID();
  const inboxSeeds: Array<{
    daysAgo: number;
    amount: number;
    description: string;
    raw: string;
    category?: string | null;
    upi?: boolean;
  }> = [
    { daysAgo: 6, amount: -42_000, description: "Swiggy", raw: "UPI-SWIGGY-swiggy@icici-882210", category: null, upi: true },
    { daysAgo: 6, amount: -156_000, description: "Zepto", raw: "UPI-ZEPTO MARKETPLACE-zepto@ybl-771203", category: null, upi: true },
    { daysAgo: 5, amount: -23_800, description: "Uber", raw: "UPI-UBER INDIA-uber@paytm-902231", category: null, upi: true },
    { daysAgo: 5, amount: -889_900, description: "Amazon", raw: "AMAZON PAY INDIA 4417XX", category: null },
    { daysAgo: 4, amount: -64_000, description: "Blue Tokai Coffee", raw: "UPI-BLUE TOKAI-bluetokai@hdfc-118822", category: null, upi: true },
    { daysAgo: 4, amount: -210_000, description: "BigBasket", raw: "UPI-BIGBASKET-bigbasket@ybl-651124", category: null, upi: true },
    { daysAgo: 3, amount: -35_500, description: "Zomato", raw: "UPI-ZOMATO LTD-zomato@icici-220918", category: null, upi: true },
    { daysAgo: 3, amount: 12_500_0, description: "Freelance payout", raw: "IMPS-UPWORK ESCROW-payout", category: null },
    { daysAgo: 2, amount: -18_400, description: "Rapido", raw: "UPI-RAPIDO BIKE-rapido@paytm-509912", category: null, upi: true },
    { daysAgo: 2, amount: -132_000, description: "Apollo Pharmacy", raw: "UPI-APOLLO PHARMACY-apollo@hdfc-378265", category: null, upi: true },
    { daysAgo: 1, amount: -56_700, description: "Swiggy Instamart", raw: "UPI-SWIGGY INSTAMART-swiggy@icici-128837", category: null, upi: true },
    { daysAgo: 1, amount: -249_000, description: "Croma", raw: "CROMA RETAIL BANGALORE IN", category: null },
  ];

  const inboxTxs: TxSeed[] = [];
  for (const seed of inboxSeeds) {
    const t = addTx({
      accountId: hdfc,
      type: seed.amount > 0 ? "income" : "expense",
      status: "imported",
      date: iso(seed.daysAgo),
      amountMinor: seed.amount,
      description: seed.description,
      merchant: null,
      rawDescription: seed.raw,
      narration: seed.raw,
      upiReference: seed.upi ? String(between(100000000000, 999999999999)) : null,
      categoryId: seed.category ?? null,
      importFileId,
    });
    inboxTxs.push(t);
  }

  // Two duplicate suspects: same amount/date as existing posted transactions.
  const dupSource1 = txs.find(
    (t) => t.status === "posted" && t.description === "Netflix",
  )!;
  const dup1 = addTx({
    accountId: card,
    type: "expense",
    status: "imported",
    date: dupSource1.date,
    amountMinor: dupSource1.amountMinor,
    description: "Netflix",
    rawDescription: "NETFLIX.COM MUMBAI IN",
    categoryId: null,
    importFileId,
    suspectedDuplicateOfId: dupSource1.id,
  });
  const dupSource2 = txs.find(
    (t) => t.status === "posted" && t.description === "Jio Fiber",
  )!;
  const dup2 = addTx({
    accountId: hdfc,
    type: "expense",
    status: "imported",
    date: dupSource2.date,
    amountMinor: dupSource2.amountMinor,
    description: "Jio Fiber",
    rawDescription: "UPI-JIOFIBER-jio@jio-AUTOPAY",
    categoryId: null,
    importFileId,
    suspectedDuplicateOfId: dupSource2.id,
  });
  inboxTxs.push(dup1, dup2);

  // --- recurring templates ---------------------------------------------------
  const nextMonthFirst = (() => {
    const d = new Date();
    return toIsoDate(new Date(d.getFullYear(), d.getMonth() + 1, 1));
  })();
  const recurringDefs: Array<typeof schema.recurringTransactions.$inferInsert> = [
    {
      id: randomUUID(),
      userId,
      name: "Monthly salary",
      type: "income",
      accountId: hdfc,
      categoryId: cat.Salary,
      amountMinor: 15_500_000,
      currencyCode: CURRENCY,
      description: "Salary — Acme Technologies",
      interval: "monthly",
      nextRunDate: nextMonthFirst,
      lastRunDate: iso(new Date().getDate() - 1),
      isActive: true,
    },
    {
      id: randomUUID(),
      userId,
      name: "Rent",
      type: "expense",
      accountId: hdfc,
      categoryId: cat.Rent,
      amountMinor: -3_500_000,
      currencyCode: CURRENCY,
      description: "Rent — Skyline Residency",
      interval: "monthly",
      nextRunDate: addMonthsClamped(`${TODAY.slice(0, 7)}-02`, 1),
      lastRunDate: `${TODAY.slice(0, 7)}-02`,
      isActive: true,
    },
    {
      id: randomUUID(),
      userId,
      name: "Index fund SIP",
      type: "transfer",
      accountId: hdfc,
      transferAccountId: icici,
      categoryId: cat.Investments,
      amountMinor: -2_000_000,
      currencyCode: CURRENCY,
      description: "SIP transfer to savings",
      interval: "monthly",
      nextRunDate: addMonthsClamped(`${TODAY.slice(0, 7)}-05`, 1),
      lastRunDate: `${TODAY.slice(0, 7)}-05`,
      isActive: true,
    },
    {
      id: randomUUID(),
      userId,
      name: "Gym membership (paused)",
      type: "expense",
      accountId: hdfc,
      categoryId: cat.Health,
      amountMinor: -150_000,
      currencyCode: CURRENCY,
      description: "Cult.fit membership",
      interval: "monthly",
      nextRunDate: nextMonthFirst,
      isActive: false,
    },
  ];
  await db.insert(schema.recurringTransactions).values(recurringDefs);

  // A pending draft generated by the recurring engine, waiting in the inbox.
  addTx({
    accountId: hdfc,
    type: "expense",
    status: "pending",
    date: TODAY,
    amountMinor: -119_900,
    description: "Jio Fiber (recurring draft)",
    merchant: "Jio",
    categoryId: cat.Utilities,
    recurringTransactionId: null,
    notes: "Draft generated from recurring template — approve to post",
  });

  // --- import file (before transactions: FK target) ---------------------------
  await db.insert(schema.importFiles).values({
    id: importFileId,
    userId,
    accountId: hdfc,
    fileName: "hdfc-statement-june.csv",
    status: "committed",
    rowCount: inboxTxs.length,
    columns: ["Date", "Narration", "Chq./Ref.No.", "Withdrawal Amt.", "Deposit Amt."],
    mapping: {
      date: "Date",
      description: "Narration",
      externalId: "Chq./Ref.No.",
      debit: "Withdrawal Amt.",
      credit: "Deposit Amt.",
    },
    dateFormat: "dd/MM/yyyy",
    committedAt: new Date(),
  });

  // --- insert transactions ----------------------------------------------------
  for (let i = 0; i < txs.length; i += 100) {
    await db.insert(schema.transactions).values(
      txs.slice(i, i + 100).map((t) => ({
        ...t,
        currencyCode: CURRENCY,
        userId,
      })),
    );
  }

  // Splits: one per transaction; the DMart haul gets a real multi-split.
  const splitRows: Array<typeof schema.transactionSplits.$inferInsert> = [];
  for (const t of txs) {
    if (t.id === splitTx.id) continue;
    splitRows.push({
      transactionId: t.id,
      categoryId: t.categoryId ?? null,
      amountMinor: t.amountMinor,
      sortOrder: 0,
    });
  }
  splitRows.push(
    {
      transactionId: splitTx.id,
      categoryId: cat.Groceries,
      amountMinor: -298_500,
      description: "Groceries",
      sortOrder: 0,
    },
    {
      transactionId: splitTx.id,
      categoryId: cat.Household,
      amountMinor: -170_000,
      description: "Cleaning supplies & kitchenware",
      sortOrder: 1,
    },
  );
  for (let i = 0; i < splitRows.length; i += 200) {
    await db.insert(schema.transactionSplits).values(splitRows.slice(i, i + 200));
  }

  if (tagLinks.length > 0) {
    await db.insert(schema.transactionTags).values(tagLinks);
  }

  // Metadata example rows (import provenance extras).
  await db.insert(schema.transactionMetadata).values([
    { transactionId: splitTx.id, key: "receipt_no", value: "DM-118822" },
    { transactionId: inboxTxs[0]!.id, key: "import_batch", value: "hdfc-2026-06" },
  ]);

  // --- import rows --------------------------------------------------------------
  const toIndian = (isoDate: string) =>
    `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
  await db.insert(schema.importRows).values(
    inboxTxs.map((t, idx) => ({
      importFileId,
      rowIndex: idx,
      raw: {
        Date: toIndian(t.date),
        Narration: t.rawDescription ?? t.description,
        "Chq./Ref.No.": t.upiReference ?? "",
        "Withdrawal Amt.": t.amountMinor < 0 ? (Math.abs(t.amountMinor) / 100).toFixed(2) : "",
        "Deposit Amt.": t.amountMinor > 0 ? (t.amountMinor / 100).toFixed(2) : "",
      },
      status: t.suspectedDuplicateOfId ? ("duplicate" as const) : ("approved" as const),
      parsedDate: t.date,
      parsedAmountMinor: t.amountMinor,
      parsedDescription: t.rawDescription ?? t.description,
      duplicateOfTransactionId: t.suspectedDuplicateOfId ?? null,
      transactionId: t.id,
    })),
  );

  await db.insert(schema.importMappings).values({
    userId,
    name: "HDFC bank statement",
    mapping: {
      date: "Date",
      description: "Narration",
      externalId: "Chq./Ref.No.",
      debit: "Withdrawal Amt.",
      credit: "Deposit Amt.",
    },
    dateFormat: "dd/MM/yyyy",
  });

  // --- budgets ------------------------------------------------------------------
  const budgetDefs: Array<{ name: string; categories: string[]; planned: number }> = [
    { name: "Groceries", categories: [cat.Groceries!, cat.Household!], planned: 1_400_000 },
    { name: "Eating Out", categories: [cat["Eating Out"]!], planned: 700_000 },
    { name: "Transport", categories: [cat.Transport!], planned: 600_000 },
    { name: "Shopping", categories: [cat.Shopping!], planned: 1_000_000 },
    { name: "Entertainment", categories: [cat.Entertainment!, cat.Subscriptions!], planned: 400_000 },
  ];
  for (const def of budgetDefs) {
    const budgetId = randomUUID();
    await db.insert(schema.budgets).values({ id: budgetId, userId, name: def.name });
    await db.insert(schema.budgetCategories).values(
      def.categories.map((categoryId) => ({ budgetId, categoryId })),
    );
    const periods: Array<typeof schema.budgetPeriods.$inferInsert> = [];
    for (let m = 4; m >= 0; m--) {
      const start = addMonthsClamped(`${TODAY.slice(0, 7)}-01`, -m);
      const endDate = new Date(
        Number(start.slice(0, 4)),
        Number(start.slice(5, 7)),
        0,
      );
      periods.push({
        budgetId,
        periodStart: start,
        periodEnd: toIsoDate(endDate),
        plannedAmountMinor: def.planned,
        currencyCode: CURRENCY,
      });
    }
    await db.insert(schema.budgetPeriods).values(periods);
  }

  // --- bills -----------------------------------------------------------------
  const monthStr = TODAY.slice(0, 7);
  const billDefs: Array<typeof schema.bills.$inferInsert> = [
    {
      id: randomUUID(),
      userId,
      name: "Rent — Skyline Residency",
      expectedAmountMinor: 3_500_000,
      currencyCode: CURRENCY,
      recurrence: "monthly",
      dueDay: 2,
      nextDueDate: addMonthsClamped(`${monthStr}-02`, 1),
      accountId: hdfc,
      categoryId: cat.Rent,
      lastPaidDate: `${monthStr}-02`,
    },
    {
      id: randomUUID(),
      userId,
      name: "BESCOM electricity",
      expectedAmountMinor: 230_000,
      currencyCode: CURRENCY,
      recurrence: "monthly",
      dueDay: 10,
      nextDueDate: `${monthStr}-10`, // yesterday → overdue in the demo
      accountId: hdfc,
      categoryId: cat.Utilities,
      lastPaidDate: addMonthsClamped(`${monthStr}-10`, -1),
    },
    {
      id: randomUUID(),
      userId,
      name: "Jio Fiber",
      expectedAmountMinor: 119_900,
      currencyCode: CURRENCY,
      recurrence: "monthly",
      dueDay: 6,
      nextDueDate: addMonthsClamped(`${monthStr}-06`, 1),
      accountId: hdfc,
      categoryId: cat.Utilities,
      lastPaidDate: `${monthStr}-06`,
    },
    {
      id: randomUUID(),
      userId,
      name: "Netflix",
      expectedAmountMinor: 64_900,
      currencyCode: CURRENCY,
      recurrence: "monthly",
      dueDay: 3,
      nextDueDate: addMonthsClamped(`${monthStr}-03`, 1),
      accountId: card,
      categoryId: cat.Subscriptions,
      lastPaidDate: `${monthStr}-03`,
    },
    {
      id: randomUUID(),
      userId,
      name: "Car insurance",
      expectedAmountMinor: 1_800_000,
      currencyCode: CURRENCY,
      recurrence: "yearly",
      nextDueDate: addMonthsClamped(TODAY, 2),
      categoryId: cat.EMI,
    },
    {
      id: randomUUID(),
      userId,
      name: "Credit card bill",
      expectedAmountMinor: 2_500_000,
      currencyCode: CURRENCY,
      recurrence: "monthly",
      dueDay: 18,
      nextDueDate: `${monthStr}-18`,
      accountId: hdfc,
    },
  ];
  await db.insert(schema.bills).values(billDefs);

  // --- savings goals -------------------------------------------------------------
  await db.insert(schema.savingsGoals).values([
    {
      userId,
      name: "Emergency fund",
      targetAmountMinor: 50_000_000,
      currentAmountMinor: 30_000_000,
      currencyCode: CURRENCY,
      accountId: sbi,
      color: "var(--chart-1)",
    },
    {
      userId,
      name: "Goa trip",
      targetAmountMinor: 6_000_000,
      currentAmountMinor: 2_250_000,
      currencyCode: CURRENCY,
      targetDate: addMonthsClamped(TODAY, 5),
      color: "var(--chart-4)",
    },
    {
      userId,
      name: "New MacBook",
      targetAmountMinor: 18_000_000,
      currentAmountMinor: 4_500_000,
      currencyCode: CURRENCY,
      targetDate: addMonthsClamped(TODAY, 10),
      color: "var(--chart-2)",
    },
  ]);

  // --- automation rules ------------------------------------------------------------
  const mkRule = async (
    name: string,
    description: string,
    matchAll: boolean,
    conditions: Array<{ field: typeof schema.automationRuleConditions.$inferInsert["field"]; value: string }>,
    actions: Array<{ type: typeof schema.automationRuleActions.$inferInsert["type"]; value: string | null }>,
    priority: number,
  ) => {
    const ruleId = randomUUID();
    await db.insert(schema.automationRules).values({
      id: ruleId,
      userId,
      name,
      description,
      matchAll,
      priority,
    });
    await db.insert(schema.automationRuleConditions).values(
      conditions.map((c) => ({ ruleId, field: c.field, value: c.value })),
    );
    await db.insert(schema.automationRuleActions).values(
      actions.map((a) => ({ ruleId, type: a.type, value: a.value })),
    );
    return ruleId;
  };

  const ruleSwiggy = await mkRule(
    "Food delivery → Eating Out",
    "Swiggy and Zomato orders are food.",
    false,
    [
      { field: "description_contains", value: "swiggy" },
      { field: "description_contains", value: "zomato" },
    ],
    [{ type: "set_category", value: cat["Eating Out"]! }],
    10,
  );
  await mkRule(
    "Rides → Transport",
    "Uber, Ola and Rapido rides.",
    false,
    [
      { field: "description_contains", value: "uber" },
      { field: "description_contains", value: "ola" },
      { field: "description_contains", value: "rapido" },
    ],
    [{ type: "set_category", value: cat.Transport! }],
    20,
  );
  await mkRule(
    "Amazon → Shopping + online tag",
    "Amazon spends are shopping; tag them online.",
    true,
    [{ field: "description_contains", value: "amazon" }],
    [
      { type: "set_category", value: cat.Shopping! },
      { type: "add_tag", value: tag.online! },
    ],
    30,
  );
  await mkRule(
    "Salary autopilot",
    "Salary credits are categorized and marked reviewed automatically.",
    true,
    [
      { field: "raw_text_contains", value: "acme technologies" },
      { field: "transaction_type_is", value: "income" },
    ],
    [
      { type: "set_category", value: cat.Salary! },
      { type: "mark_reviewed", value: null },
    ],
    5,
  );
  await mkRule(
    "Flag large spends",
    "Anything above ₹10,000 gets the large tag for review.",
    true,
    [{ field: "amount_greater_than", value: "1000000" }],
    [{ type: "add_tag", value: tag.large! }],
    90,
  );

  await db.insert(schema.automationRuns).values([
    {
      ruleId: ruleSwiggy,
      userId,
      trigger: "import",
      matchedCount: 9,
      appliedCount: 9,
      startedAt: new Date(Date.now() - 86_400_000 * 6),
      finishedAt: new Date(Date.now() - 86_400_000 * 6 + 1200),
    },
    {
      ruleId: ruleSwiggy,
      userId,
      trigger: "manual",
      matchedCount: 41,
      appliedCount: 38,
      startedAt: new Date(Date.now() - 86_400_000 * 20),
      finishedAt: new Date(Date.now() - 86_400_000 * 20 + 2300),
    },
  ]);

  // --- daily balance snapshots -----------------------------------------------------
  const accountList = [
    { id: hdfc, opening: 18_500_000 },
    { id: icici, opening: 52_000_000 },
    { id: sbi, opening: 30_000_000 },
    { id: card, opening: 0 },
    { id: cash, opening: 600_000 },
    { id: carLoan, opening: -42_000_000 },
  ];
  const snapshotRows: Array<typeof schema.accountBalances.$inferInsert> = [];
  for (const account of accountList) {
    // Pre-aggregate per-day deltas for this account.
    const deltaByDate = new Map<string, number>();
    for (const t of txs) {
      const delta = balanceDelta(t as LedgerEntry, account.id);
      if (delta !== 0) {
        deltaByDate.set(t.date, (deltaByDate.get(t.date) ?? 0) + delta);
      }
    }
    let balance = account.opening;
    for (let daysAgo = HISTORY_DAYS; daysAgo >= 0; daysAgo--) {
      const date = iso(daysAgo);
      balance += deltaByDate.get(date) ?? 0;
      // Weekly snapshots + the last 30 days daily keeps charts smooth and rows low.
      if (daysAgo % 7 === 0 || daysAgo <= 30) {
        snapshotRows.push({
          accountId: account.id,
          date,
          balanceMinor: balance,
          currencyCode: CURRENCY,
        });
      }
    }
    // Keep accounts.currentBalanceMinor in sync with the ledger.
    await db
      .update(schema.accounts)
      .set({ currentBalanceMinor: balance })
      .where(eq(schema.accounts.id, account.id));
  }
  for (let i = 0; i < snapshotRows.length; i += 300) {
    await db.insert(schema.accountBalances).values(snapshotRows.slice(i, i + 300));
  }

  // --- audit log + system jobs ------------------------------------------------------
  await db.insert(schema.auditLogs).values([
    {
      userId,
      action: "import.committed",
      entityType: "import_file",
      entityId: importFileId,
      data: { fileName: "hdfc-statement-june.csv", rows: inboxTxs.length },
    },
    {
      userId,
      action: "rule.executed",
      entityType: "automation_rule",
      entityId: ruleSwiggy,
      data: { matched: 9, applied: 9, trigger: "import" },
    },
    {
      userId,
      action: "account.created",
      entityType: "account",
      entityId: hdfc,
      data: { name: "HDFC Salary Account" },
    },
    {
      userId,
      action: "budget.created",
      entityType: "budget",
      data: { name: "Groceries" },
    },
  ]);

  // system_jobs is operational (not user-scoped), so it isn't covered by the
  // demo-user cascade reset above and may already hold rows from a prior seed
  // or from the in-process jobs runner. Upsert on the unique name to keep the
  // seed re-runnable.
  await db
    .insert(schema.systemJobs)
    .values([
      {
        name: "recurring-transactions",
        description: "Generates draft transactions from recurring templates",
        schedule: "0 6 * * *",
        lastRunAt: new Date(Date.now() - 3_600_000 * 5),
        lastStatus: "ok",
        lastDurationMs: 420,
      },
      {
        name: "bill-status-check",
        description: "Matches transactions to bills and flags overdue bills",
        schedule: "0 7 * * *",
        lastRunAt: new Date(Date.now() - 3_600_000 * 4),
        lastStatus: "ok",
        lastDurationMs: 180,
      },
      {
        name: "health-check",
        description: "Records app/database health for the self-hosting screen",
        schedule: "*/30 * * * *",
        lastRunAt: new Date(Date.now() - 60_000 * 12),
        lastStatus: "ok",
        lastDurationMs: 35,
      },
    ])
    .onConflictDoUpdate({
      target: [schema.systemJobs.name],
      set: {
        description: sql`excluded.description`,
        schedule: sql`excluded.schedule`,
        lastRunAt: sql`excluded.last_run_at`,
        lastStatus: sql`excluded.last_status`,
        lastDurationMs: sql`excluded.last_duration_ms`,
        updatedAt: new Date(),
      },
    });

  const counts = {
    transactions: txs.length,
    inbox: txs.filter((t) => t.status === "imported" || t.status === "pending").length,
  };
  console.log(
    `Seeded: ${counts.transactions} transactions (${counts.inbox} in inbox), 6 accounts, ` +
      `${categoryDefs.length} categories, ${budgetDefs.length} budgets, ${billDefs.length} bills, ` +
      `4 recurring templates, 3 goals, 5 rules.`,
  );
  console.log(`Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);

  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
