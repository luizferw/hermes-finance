import assert from "node:assert/strict";
import test from "node:test";
import { categorizePierreTransaction } from "./pierre-categorization";

const expense = (description: string) => ({ type: "expense", description });

test("categorizes known Pierre merchants deterministically", () => {
  assert.equal(categorizePierreTransaction(expense("HIPERMAIS JOINVILLE BRA")), "Groceries");
  assert.equal(categorizePierreTransaction(expense("PAGAMENTO DE BOLETO UNIFIQUE TELECOMUNICACOES")), "Bills & Utilities");
  assert.equal(categorizePierreTransaction(expense("OPENAI CHATGPT SUBSCRIPTION")), "Subscriptions");
  assert.equal(categorizePierreTransaction(expense("FARMACIA GUANABARA JOINVILLE")), "Health");
  assert.equal(categorizePierreTransaction(expense("AUTO POSTO FATIMA LTDA")), "Transport");
  assert.equal(categorizePierreTransaction(expense("CANUTO E VIEIRA PIZZARIA")), "Food & Dining");
  assert.equal(categorizePierreTransaction(expense("SHEIN SHEIN.COM")), "Shopping");
  assert.equal(categorizePierreTransaction(expense("MERCADO LIVRE BRASIL")), "Shopping");
  assert.equal(categorizePierreTransaction(expense("MERCADOLIVRE*PAGAMENTO")), "Shopping");
});

test("uses Other for non-expenses and ambiguous descriptions instead of leaving them uncategorized", () => {
  assert.equal(categorizePierreTransaction({ type: "income", description: "PIX RECEBIDO" }), "Other");
  assert.equal(categorizePierreTransaction({ type: "transfer", description: "Pagamento Fatura" }), "Other");
  assert.equal(categorizePierreTransaction(expense("PIX ENVIADO VALDECIO FARIA RODRIGUES")), "Other");
});
