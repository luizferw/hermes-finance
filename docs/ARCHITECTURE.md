# Arquitetura — Hermes Finance

```text
Next.js / MCP
     │
application adapters
     │
┌────┴───────────────────────────┐
│ packages/planning              │  safe-to-spend, simulações, comparação
│ packages/forecast              │  projeção diária determinística
│ packages/domain (Kosh)         │  ledger, imports, regras, categorias
│ packages/db (Kosh + extensões) │  PostgreSQL / Drizzle / audit
└────────────────────────────────┘
```

## Regras de fronteira

- `forecast` recebe snapshots e eventos normalizados, em *integer minor units*, e devolve somente dados determinísticos.
- `planning` usa o Forecast; não recalcula saldo fora dele.
- Web, MCP e Telegram são adaptadores: não acessam tabelas para fazer cálculo.
- Uma `Transaction` é fato. Um evento previsto é separado e resolvido quando o fato correspondente existir.
- Compra no cartão é despesa econômica; settlement de fatura é impacto de caixa e não cria uma segunda despesa categorizada.
- Uma transferência própria tem duas pernas e efeito líquido zero no consolidado.

## Core entregue neste commit

| Pacote | API pública | Garantia |
| --- | --- | --- |
| `@hermes-finance/forecast` | `buildForecast()` | Trajetória diária, precedência por confidence, projeção resolvida excluída, saldo mínimo. |
| `@hermes-finance/planning` | `calculateSafeToSpend()` | Safe-to-spend pelo menor ponto da curva, respeitando reserva HARD. |
| `@hermes-finance/planning` | `comparePaymentOptions()` | Recalcula cada alternativa no mesmo snapshot; inviáveis por reserva não são recomendadas. |

## Próximas fatias obrigatórias

1. persistir `BalanceSnapshot`, import batches e proveniência;
2. domínio explícito de cartões, ciclos, faturas e parcelas;
3. adapters CSV/OFX idempotentes e reconciliação;
4. endpoints/UI/MCP read-only sobre as APIs puras;
5. credit limit, deadlines, reservas SOFT e opções não uniformes no comparador.
