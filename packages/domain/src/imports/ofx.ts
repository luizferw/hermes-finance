/**
 * Dependency-free OFX parser. Supports both OFX 1.x (SGML — tags are often
 * left unclosed for leaf values) and OFX 2.x (well-formed XML). No new
 * dependency is pulled in: SGML is normalized into XML-ish text with a
 * regex pass, then walked with a small hand-written tag-stack scanner.
 *
 * Money is always returned as integer minor units — never a float — via
 * the shared `parseAmountToMinor`. Dates are ISO `yyyy-MM-dd`, matching the
 * rest of the domain.
 */

import { parseAmountToMinor } from "../shared/money";
import { fromIsoDate, toIsoDate } from "../shared/dates";
import { findIntraBatchDuplicates, type IncomingRowLike } from "./dedupe";

export interface OfxAccount {
  bankId: string | null;
  accountId: string;
  /** e.g. CHECKING, SAVINGS, CREDITLINE. Absent on credit-card accounts. */
  accountType: string | null;
}

export interface OfxTransaction {
  /** TRNTYPE, e.g. DEBIT, CREDIT, CHECK, PAYMENT, ATM. */
  type: string | null;
  /** ISO `yyyy-MM-dd`, taken from DTPOSTED (time/timezone are dropped). */
  postedAt: string;
  amountMinor: number;
  fitId: string | null;
  name: string | null;
  memo: string | null;
  checkNumber: string | null;
}

export interface OfxBalance {
  balanceMinor: number;
  /** ISO `yyyy-MM-dd` from DTASOF, or null when the balance omits it. */
  observedAt: string | null;
}

export interface OfxStatement {
  account: OfxAccount;
  currencyCode: string;
  transactions: OfxTransaction[];
  /** From LEDGERBAL — feeds a BalanceSnapshot. Null when the statement omits it. */
  ledgerBalance: OfxBalance | null;
}

export interface OfxDocument {
  statements: OfxStatement[];
}

/** Minimal parsed-tag tree. Tag names are uppercased for lookup convenience. */
interface OfxNode {
  tag: string;
  value: string | null;
  children: OfxNode[];
}

/**
 * Turn SGML's unclosed leaf tags (`<NAME>Coffee Shop`) into well-formed
 * XML (`<NAME>Coffee Shop</NAME>`). Tags that are already properly closed
 * (OFX 2.x, or an SGML file with empty elements) are left untouched, so
 * this same pass is safe to run on both dialects.
 */
function sgmlToXml(input: string): string {
  return input.replace(
    /<([A-Za-z0-9_.]+)>([^\r\n<]*)(<\/\1>)?/g,
    (_match, tag: string, text: string, closing?: string) => {
      if (closing) return `<${tag}>${text}</${tag}>`; // already well-formed
      const trimmed = text.trim();
      return trimmed.length === 0 ? `<${tag}>` : `<${tag}>${trimmed}</${tag}>`;
    },
  );
}

/** Stack-based scanner turning normalized XML-ish text into a node tree. */
function parseTags(xml: string): OfxNode {
  const root: OfxNode = { tag: "#ROOT", value: null, children: [] };
  const stack: OfxNode[] = [root];
  const tagRe = /<(\/?)([A-Za-z0-9_.]+)>([^<]*)/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(xml))) {
    const [, closing, rawTag, trailing] = match;
    const tag = rawTag!.toUpperCase();

    if (closing) {
      let openIndex = -1;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === tag) {
          openIndex = i;
          break;
        }
      }
      if (openIndex === -1) {
        throw new Error(`Malformed OFX: unexpected closing tag </${rawTag}>`);
      }
      stack.length = openIndex;
      continue;
    }

    const node: OfxNode = { tag, value: null, children: [] };
    stack[stack.length - 1]!.children.push(node);
    const text = trailing!.trim();
    if (text.length > 0) node.value = text;
    stack.push(node);
  }

  if (stack.length > 1) {
    throw new Error(`Malformed OFX: tag <${stack[stack.length - 1]!.tag}> was never closed`);
  }
  return root;
}

function findChild(node: OfxNode, tag: string): OfxNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

function findChildren(node: OfxNode, tag: string): OfxNode[] {
  return node.children.filter((c) => c.tag === tag);
}

function findAllDescendants(node: OfxNode, tag: string): OfxNode[] {
  const results: OfxNode[] = [];
  const walk = (n: OfxNode) => {
    for (const child of n.children) {
      if (child.tag === tag) results.push(child);
      walk(child);
    }
  };
  walk(node);
  return results;
}

/**
 * DTPOSTED/DTASOF come as `YYYYMMDD` or `YYYYMMDDHHMMSS[.XXX][TZ]` — only
 * the date part is kept. Validity is checked by round-tripping through the
 * shared date helpers rather than reimplementing calendar math.
 */
function parseOfxDateToIso(raw: string, context: string): string {
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) {
    throw new Error(`Malformed OFX: unrecognized date "${raw}" in ${context}`);
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  if (toIsoDate(fromIsoDate(iso)) !== iso) {
    throw new Error(`Malformed OFX: invalid date "${raw}" in ${context}`);
  }
  return iso;
}

function buildTransaction(node: OfxNode, currencyCode: string, accountId: string): OfxTransaction {
  const fitId = findChild(node, "FITID")?.value ?? null;
  const context = `transaction${fitId ? ` FITID ${fitId}` : ""} on account ${accountId}`;

  const dtPosted = findChild(node, "DTPOSTED")?.value;
  if (!dtPosted) {
    throw new Error(`Malformed OFX: missing <DTPOSTED> for ${context}`);
  }
  const postedAt = parseOfxDateToIso(dtPosted, context);

  const trnAmt = findChild(node, "TRNAMT")?.value;
  if (!trnAmt) {
    throw new Error(`Malformed OFX: missing <TRNAMT> for ${context}`);
  }
  const amountMinor = parseAmountToMinor(trnAmt, currencyCode);
  if (amountMinor === null) {
    throw new Error(`Malformed OFX: unrecognized <TRNAMT> "${trnAmt}" for ${context}`);
  }

  return {
    type: findChild(node, "TRNTYPE")?.value ?? null,
    postedAt,
    amountMinor,
    fitId,
    name: findChild(node, "NAME")?.value ?? null,
    memo: findChild(node, "MEMO")?.value ?? null,
    checkNumber: findChild(node, "CHECKNUM")?.value ?? null,
  };
}

function buildBalance(node: OfxNode, currencyCode: string): OfxBalance {
  const balAmt = findChild(node, "BALAMT")?.value;
  if (!balAmt) {
    throw new Error("Malformed OFX: <LEDGERBAL> missing <BALAMT>");
  }
  const balanceMinor = parseAmountToMinor(balAmt, currencyCode);
  if (balanceMinor === null) {
    throw new Error(`Malformed OFX: unrecognized <LEDGERBAL> amount "${balAmt}"`);
  }
  const dtAsOf = findChild(node, "DTASOF")?.value;
  return {
    balanceMinor,
    observedAt: dtAsOf ? parseOfxDateToIso(dtAsOf, "<LEDGERBAL> DTASOF") : null,
  };
}

function buildStatement(node: OfxNode): OfxStatement {
  const currencyCode = findChild(node, "CURDEF")?.value;
  if (!currencyCode) {
    throw new Error("Malformed OFX: statement missing <CURDEF>");
  }

  const acctNode = findChild(node, "BANKACCTFROM") ?? findChild(node, "CCACCTFROM");
  if (!acctNode) {
    throw new Error("Malformed OFX: statement missing <BANKACCTFROM>/<CCACCTFROM>");
  }
  const accountId = findChild(acctNode, "ACCTID")?.value;
  if (!accountId) {
    throw new Error("Malformed OFX: account missing <ACCTID>");
  }
  const account: OfxAccount = {
    bankId: findChild(acctNode, "BANKID")?.value ?? null,
    accountId,
    accountType: findChild(acctNode, "ACCTTYPE")?.value ?? null,
  };

  const tranList = findChild(node, "BANKTRANLIST");
  const trnNodes = tranList ? findChildren(tranList, "STMTTRN") : [];
  const transactions = trnNodes.map((trnNode) =>
    buildTransaction(trnNode, currencyCode, account.accountId),
  );

  const ledgerBalNode = findChild(node, "LEDGERBAL");
  const ledgerBalance = ledgerBalNode ? buildBalance(ledgerBalNode, currencyCode) : null;

  return { account, currencyCode, transactions, ledgerBalance };
}

/**
 * Parse an OFX 1.x (SGML) or OFX 2.x (XML) document. Throws a descriptive
 * `Error` on malformed input instead of returning partial data.
 */
export function parseOfx(content: string): OfxDocument {
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Malformed OFX: content is empty");
  }

  const withoutPis = content.replace(/<\?[^>]*\?>/g, ""); // strip OFX 2.x <?xml?>/<?OFX?>
  const firstTag = withoutPis.indexOf("<");
  if (firstTag === -1) {
    throw new Error("Malformed OFX: no tags found");
  }
  const body = withoutPis.slice(firstTag); // drop the SGML header block (OFXHEADER:100, ...)

  const root = parseTags(sgmlToXml(body));

  const ofxNode = findChild(root, "OFX");
  if (!ofxNode) {
    throw new Error("Malformed OFX: missing <OFX> root element");
  }

  const statementNodes = [
    ...findAllDescendants(ofxNode, "STMTRS"),
    ...findAllDescendants(ofxNode, "CCSTMTRS"),
  ];
  if (statementNodes.length === 0) {
    throw new Error("Malformed OFX: no statement response (<STMTRS>/<CCSTMTRS>) found");
  }

  return { statements: statementNodes.map(buildStatement) };
}

export interface OfxImportRow extends IncomingRowLike {
  accountId: string;
  fitId: string | null;
  checkNumber: string | null;
  memo: string | null;
  /** Same-batch collision found via `findIntraBatchDuplicates` — never dropped, only flagged. */
  status: "OK" | "POSSIBLE_DUPLICATE";
}

export interface BuildOfxImportRowsOptions {
  /**
   * Resolve an OFX account (bankId + accountId) to the Kosh account id used
   * to scope dedupe. Defaults to the raw OFX ACCTID.
   */
  accountIdFor?: (account: OfxAccount) => string;
}

/**
 * Normalize a parsed OFX document into the same row shape the CSV importer
 * feeds to dedupe (`IncomingRowLike`), using FITID as the external id when
 * present. Rows colliding within the same file are flagged
 * `POSSIBLE_DUPLICATE` via the existing `findIntraBatchDuplicates` — they
 * are never silently dropped; cross-batch dedupe still runs through
 * `findDuplicate` from `dedupe.ts`.
 */
export function buildOfxImportRows(
  doc: OfxDocument,
  options: BuildOfxImportRowsOptions = {},
): OfxImportRow[] {
  const rows: OfxImportRow[] = [];

  for (const statement of doc.statements) {
    const accountId = options.accountIdFor
      ? options.accountIdFor(statement.account)
      : statement.account.accountId;

    const statementRows: OfxImportRow[] = statement.transactions.map((trn) => ({
      accountId,
      date: trn.postedAt,
      amountMinor: trn.amountMinor,
      description: trn.name || trn.memo || "",
      externalId: trn.fitId,
      fitId: trn.fitId,
      checkNumber: trn.checkNumber,
      memo: trn.memo,
      status: "OK",
    }));

    const duplicateIndexes = findIntraBatchDuplicates(accountId, statementRows);
    duplicateIndexes.forEach((index) => {
      statementRows[index]!.status = "POSSIBLE_DUPLICATE";
    });

    rows.push(...statementRows);
  }

  return rows;
}
