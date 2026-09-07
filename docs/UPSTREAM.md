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
| Cartões BR | Será modelado em tabelas explícitas; cartão não será somente uma conta genérica. |
