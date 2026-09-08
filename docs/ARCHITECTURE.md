# Arquitetura — Hermes Finance

```text
Next.js (web)          MCP / Hermes
      │                     │
      └────── adapters ─────┘
                │
        apps/web/modules/finance
        queries.ts · simulation.ts · mutations.ts
                │
┌───────────────┴────────────────┐
│ packages/planning              │  safe-to-spend, simulação, comparador
│ packages/forecast              │  projeção diária, recorrências, faturas, parcelas
│ packages/domain (Kosh)         │  ledger, imports (CSV/OFX), regras, categorias
│ packages/db (Kosh + extensões) │  PostgreSQL / Drizzle / audit
└────────────────────────────────┘
```

## Regras de fronteira

- `forecast` recebe snapshots e eventos normalizados, em *integer minor units*, e devolve somente dados determinísticos. Não conhece React, Next.js, PostgreSQL nem MCP.
- `planning` usa o Forecast; não recalcula saldo fora dele.
- Web, MCP e Telegram são adaptadores: não acessam tabelas para fazer cálculo.
- Uma `Transaction` é fato. Um evento previsto é separado e resolvido quando o fato correspondente existir.
- Compra no cartão é despesa econômica; settlement de fatura é impacto de caixa e não cria uma segunda despesa categorizada.
- Uma transferência própria tem duas pernas e efeito líquido zero no consolidado.

## API pública dos pacotes puros

### `@hermes-finance/forecast`

| Função | Garantia |
| --- | --- |
| `buildForecast()` | Trajetória diária; precedência por confidence; projeção resolvida excluída; saldo mínimo sobre os fechamentos diários; validação de datas e minor units. |
| `projectRecurrences()` | Expande regras com cadência diária a anual, re-ancorando fim de mês (31 → 28 → 31, sem drift). |
| `projectStatements()` | Um evento de caixa por ciclo de fatura, no vencimento. Total reconciliado tem precedência sobre a soma das parcelas. |
| `expandInstallmentTail()` | Só `N+1 … M`; a última parcela absorve o resto da divisão. |
| `nominalCycleFor()` / `nominalCycleDueDates()` | Em qual fatura uma compra cai, a partir dos dias de fechamento e vencimento. |
| `resolveProjectedEvents()` | Liga um fato à sua projeção, tirando-a do conjunto ativo. |

### `@hermes-finance/planning`

| Função | Garantia |
| --- | --- |
| `calculateSafeToSpend()` | Máximo gasto imediato que preserva a reserva HARD em todo o horizonte. Seguro e maximal, provado por invariantes. |
| `comparePaymentOptions()` | Restrições rígidas antes de custo; `status` explícito; `reasons[]` por opção. |
| `simulatePurchase()` | Impacto imediato, mensal, no vale da curva e nas metas, medido no mesmo snapshot. |
| `monthlySettlementEvents()` | Constrói os settlements de uma opção; a soma bate exatamente com o custo total. |

## Camada de adapters (`apps/web/modules/finance`)

- `queries.ts` — leitura. Monta as entradas normalizadas do engine a partir de snapshots de saldo, `projectedEvents`, bills, recorrências e ciclos de cartão; reporta freshness e o breakdown de confiança.
- `simulation.ts` — traduz opções de pagamento (persistidas ou ad hoc) em eventos de caixa, resolvendo as datas pelos ciclos reais do cartão quando existirem.
- `mutations.ts` / `validators.ts` — escrita, com ownership por `userId` e zod espelhando os CHECK constraints do schema.

## Superfície entregue

### Rotas (`apps/web/app/(app)/plan`)

| Rota | Conteúdo |
| --- | --- |
| `/plan` | Posição financeira, freshness, gráfico de forecast com seletor de horizonte, indicadores de confiança. |
| `/plan/commitments` | Compromissos futuros agrupados por mês, com badge de confiança. |
| `/plan/cards` · `/plan/cards/[id]` | Limite, comprometido, disponível, utilização; ciclos com total e reconciliação. |
| `/plan/purchases` · `/plan/purchases/[id]` | Planos e itens; comparação de opções de pagamento com a explicação de cada veredito. |

A UI nunca faz aritmética monetária: ela só formata números que o engine já decidiu. O motor fala em unidades menores canônicas — correto para MCP e para trilha de auditoria, errado para tela — e a página de comparação traduz isso em frases.

### Tools MCP (read-only, scope `finance:read`)

`get_position` · `get_projection` · `get_projected_commitments` · `get_credit_cards` · `get_card_statement` · `get_confidence_breakdown` · `get_purchase_plans` · `get_purchase_plan` · `simulate_purchase` · `compare_payment_options`

`get_projected_commitments` é distinta da `get_upcoming_commitments` que já existia no Kosh, que lista apenas bills cadastradas.

## Qualidade

Pipeline: `lint` · `typecheck` · testes unitários · testes de integração (Postgres) · `build`.

Os pacotes puros carregam testes de propriedade com PRNG semeado: cada falha reporta a seed que a produziu, então o contraexemplo é reproduzível em vez de perseguido. Eles cobrem a identidade diária do saldo, o encadeamento abertura/fechamento, reprodutibilidade, neutralidade de transferência própria, e as duas metades da definição de safe-to-spend (seguro e maximal).

## Fora do escopo

O produto é um *decision-support system*. Ele não movimenta dinheiro: não executa PIX, não paga boleto, não transfere, não acessa banco por automação de browser. Ver PRD §45.
