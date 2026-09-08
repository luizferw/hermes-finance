import { describe, expect, it } from "vitest";
import { buildOfxImportRows, parseOfx } from "./ofx";
import { findDuplicate } from "./dedupe";

const SGML_OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260108120000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>123456789
<ACCTID>1111222233334444
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260101
<DTEND>20260108
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260105
<TRNAMT>-45.67
<FITID>2026010500001
<NAME>COFFEE SHOP
<MEMO>Card purchase
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260106120000
<TRNAMT>1200
<FITID>2026010600002
<NAME>PAYROLL
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>2500.33
<DTASOF>20260108120000[-5:EST]
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

const XML_OFX = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0</CODE>
<SEVERITY>INFO</SEVERITY>
</STATUS>
<DTSERVER>20260108120000</DTSERVER>
<LANGUAGE>ENG</LANGUAGE>
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1</TRNUID>
<STATUS>
<CODE>0</CODE>
<SEVERITY>INFO</SEVERITY>
</STATUS>
<STMTRS>
<CURDEF>USD</CURDEF>
<BANKACCTFROM>
<BANKID>123456789</BANKID>
<ACCTID>1111222233334444</ACCTID>
<ACCTTYPE>CHECKING</ACCTTYPE>
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260101</DTSTART>
<DTEND>20260108</DTEND>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20260105</DTPOSTED>
<TRNAMT>-45.67</TRNAMT>
<FITID>2026010500001</FITID>
<NAME>COFFEE SHOP</NAME>
<MEMO>Card purchase</MEMO>
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT</TRNTYPE>
<DTPOSTED>20260106120000</DTPOSTED>
<TRNAMT>1200</TRNAMT>
<FITID>2026010600002</FITID>
<NAME>PAYROLL</NAME>
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>2500.33</BALAMT>
<DTASOF>20260108120000[-5:EST]</DTASOF>
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

describe("parseOfx", () => {
  it("parses OFX 1.x SGML and OFX 2.x XML into the same document", () => {
    const sgml = parseOfx(SGML_OFX);
    const xml = parseOfx(XML_OFX);
    expect(sgml).toEqual(xml);
  });

  it("extracts account, transactions and ledger balance", () => {
    const doc = parseOfx(SGML_OFX);
    expect(doc.statements).toHaveLength(1);
    const [statement] = doc.statements;

    expect(statement!.currencyCode).toBe("USD");
    expect(statement!.account).toEqual({
      bankId: "123456789",
      accountId: "1111222233334444",
      accountType: "CHECKING",
    });

    expect(statement!.ledgerBalance).toEqual({
      balanceMinor: 250033,
      observedAt: "2026-01-08",
    });
  });

  it("preserves the sign and parses cents correctly", () => {
    const doc = parseOfx(SGML_OFX);
    const [debit, credit] = doc.statements[0]!.transactions;
    expect(debit!.amountMinor).toBe(-4567);
    expect(debit!.type).toBe("DEBIT");
    expect(debit!.fitId).toBe("2026010500001");
    expect(debit!.name).toBe("COFFEE SHOP");
    expect(debit!.memo).toBe("Card purchase");
    expect(credit!.amountMinor).toBe(120000);
  });

  it("parses DTPOSTED without a timestamp and with a timestamp+timezone", () => {
    const doc = parseOfx(SGML_OFX);
    const [debit, credit] = doc.statements[0]!.transactions;
    expect(debit!.postedAt).toBe("2026-01-05"); // YYYYMMDD only
    expect(credit!.postedAt).toBe("2026-01-06"); // YYYYMMDDHHMMSS
  });

  it("handles multiple accounts in the same file", () => {
    const multi = SGML_OFX.replace(
      "</STMTTRNRS>\n</BANKMSGSRSV1>",
      `</STMTTRNRS>
<STMTTRNRS>
<TRNUID>2
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>987654321
<ACCTID>5555666677778888
<ACCTTYPE>SAVINGS
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260101
<DTEND>20260108
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260103
<TRNAMT>300
<FITID>2026010300001
<NAME>TRANSFER
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>`,
    );
    const doc = parseOfx(multi);
    expect(doc.statements).toHaveLength(2);
    expect(doc.statements.map((s) => s.account.accountId)).toEqual([
      "1111222233334444",
      "5555666677778888",
    ]);
    expect(doc.statements[1]!.ledgerBalance).toBeNull();
  });

  it("throws a descriptive error on malformed input", () => {
    expect(() => parseOfx("")).toThrow("empty");
    expect(() => parseOfx("not an ofx file at all")).toThrow(/no tags found/);
    expect(() => parseOfx("<OFX><BANKMSGSRSV1>")).toThrow(/never closed/);
    expect(() =>
      parseOfx("<OFX><BANKMSGSRSV1></BANKMSGSRSV1></BOGUSCLOSE></OFX>"),
    ).toThrow(/unexpected closing tag/);
    // Missing CURDEF inside the statement.
    const missingCurdef = SGML_OFX.replace("<CURDEF>USD\n", "");
    expect(() => parseOfx(missingCurdef)).toThrow(/CURDEF/);
    // Unrecognizable amount.
    const badAmount = SGML_OFX.replace("<TRNAMT>-45.67", "<TRNAMT>not-a-number");
    expect(() => parseOfx(badAmount)).toThrow(/TRNAMT/);
  });
});

describe("buildOfxImportRows", () => {
  it("uses FITID as externalId and marks intra-batch collisions as POSSIBLE_DUPLICATE", () => {
    const doc = parseOfx(SGML_OFX);
    const rows = buildOfxImportRows(doc);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      accountId: "1111222233334444",
      externalId: "2026010500001",
      fitId: "2026010500001",
      amountMinor: -4567,
      date: "2026-01-05",
      status: "OK",
    });
    expect(rows[1]!.status).toBe("OK"); // distinct FITID, not a duplicate
  });

  it("falls back to the fingerprint hash when FITID is absent", () => {
    const withoutFitId = SGML_OFX.replace("<FITID>2026010500001\n", "");
    const doc = parseOfx(withoutFitId);
    const rows = buildOfxImportRows(doc);
    expect(rows[0]!.fitId).toBeNull();
    expect(rows[0]!.externalId).toBeNull();
  });

  it("flags duplicate rows within the same batch instead of dropping them", () => {
    const duplicated = SGML_OFX.replace(
      "</BANKTRANLIST>",
      `<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260105
<TRNAMT>-45.67
<FITID>2026010500001
<NAME>COFFEE SHOP
<MEMO>Card purchase
</STMTTRN>
</BANKTRANLIST>`,
    );
    const doc = parseOfx(duplicated);
    const rows = buildOfxImportRows(doc);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.status).toBe("OK");
    expect(rows[2]!.status).toBe("POSSIBLE_DUPLICATE");
  });

  it("is idempotent: reimporting the same file matches existing rows by FITID", () => {
    const firstDoc = parseOfx(SGML_OFX);
    const firstRows = buildOfxImportRows(firstDoc);

    const existing = firstRows.map((row, i) => ({
      id: `t${i}`,
      date: row.date,
      amountMinor: row.amountMinor,
      importHash: null,
      externalId: row.externalId,
    }));

    const secondDoc = parseOfx(SGML_OFX);
    const secondRows = buildOfxImportRows(secondDoc);

    for (const row of secondRows) {
      const match = findDuplicate(row.accountId, row, existing);
      expect(match).toMatchObject({ kind: "exact", reason: "external_id" });
    }
  });
});
