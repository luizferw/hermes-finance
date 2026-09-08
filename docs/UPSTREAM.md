# Upstream

## Origem

- **Upstream:** [`kzekiue/kosh`](https://github.com/kzekiue/kosh)
- **Fork:** [`luizferw/hermes-finance`](https://github.com/luizferw/hermes-finance)
- **Base inicial:** `665b893f11ee65cf0de013a44ffdac8d71d53d23` (`feat: redesign landing and auth pages (#10)`)
- **Licença preservada:** AGPL-3.0-only

## Remotes

```text
origin   git@github.com:luizferw/hermes-finance.git
upstream git@github.com:kzekiue/kosh.git
```

## Política

A infraestrutura existente do Kosh — autenticação, Next.js, PostgreSQL, Drizzle, jobs, backup, migrations e MCP opt-in — deve ser preservada. O domínio Hermes Finance entra de forma aditiva em `packages/forecast`, `packages/planning` e futuras tabelas específicas em `packages/db`.

Antes de absorver upstream:

1. `git fetch upstream`
2. revisar migrations, schema, MCP e domínio afetados;
3. aplicar em branch própria;
4. rodar lint, typecheck, testes, build e rehearsal de migration.

## Divergências locais

| Área | Decisão |
| --- | --- |
| IA externa | `KOSH_AI_ENABLED=false` por padrão; cálculos são código determinístico. |
| Forecast | Novo pacote puro, sem Next.js, PostgreSQL ou MCP. |
| Planning | Novo pacote que depende apenas do Forecast. |
| Cartões BR | Modelado em tabelas explícitas (`credit_cards`, `credit_card_billing_cycles`, `credit_card_purchases`, `installment_plans`, `installments`); cartão não é somente uma conta genérica. |
| Domínio aditivo | Migration `0008` acrescenta as tabelas de finance/planning. Nenhuma tabela do Kosh foi alterada, o que mantém o merge de upstream previsível. |
| Imports | `packages/domain/src/imports/ofx.ts` é aditivo e reutiliza o `dedupe.ts` do Kosh. |
| MCP | Tools financeiras entram em `readTools` do registry existente, sob o scope `finance:read` já presente. |
| Compose | O serviço `db` passa a publicar a porta em `127.0.0.1` para permitir migrations e testes a partir do host. |
