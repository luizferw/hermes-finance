# Hermes Finance — Product Requirements Document

**Status:** Draft v1  
**Estratégia:** Fork e extensão do Kosh  
**Deployment inicial:** self-hosted, single-user, local-first  
**Interface principal:** Web + MCP  
**Agente principal:** Hermes via MCP/Telegram

---

# 1. Resumo executivo

Hermes Finance é um sistema pessoal de **posição financeira, projeção de fluxo de caixa e planejamento de decisões futuras**.

O produto deve consolidar:

- contas bancárias;
- cartões de crédito;
- cartões de loja;
- compras parceladas;
- despesas recorrentes;
- PIX e boletos;
- receitas recorrentes;
- categorias;
- metas;
- reservas;
- faturas atuais e futuras;
- compras planejadas;
- simulações.

O sistema deve responder com precisão a perguntas como:

- Quanto dinheiro eu realmente tenho hoje?
- Quanto desse dinheiro já está comprometido?
- Quanto posso gastar até o próximo salário?
- Quanto posso gastar nos próximos 30, 60 ou 90 dias?
- Qual será meu menor saldo nos próximos meses?
- Quanto das próximas faturas já está comprometido?
- Quanto estou gastando por categoria?
- Quais compromissos ainda não foram pagos?
- Se eu comprar R$ 2.500 hoje, o que acontece com meu caixa?
- É melhor pagar R$ 2.250 à vista, 5x de R$ 500 ou 10x de R$ 270?
- Tenho uma lista de compras para o bebê até determinada data: quando devo comprar cada item e como devo pagar?
- Alguma compra planejada coloca minha reserva financeira em risco?

O sistema não deve depender de uma LLM para fazer matemática financeira.

A LLM/Hermes será utilizada como:

- interface conversacional;
- orquestrador;
- explicador dos resultados;
- auxiliar de categorização;
- auxiliar de importação quando necessário.

Todo cálculo financeiro relevante deverá ser realizado por código determinístico.

---

# 2. Problema

## 2.1 Situação atual

O usuário possui informações financeiras fragmentadas.

Exemplos:

### Contas bancárias

- Santander
- Inter

### Cartões vinculados aos bancos

- Santander
- Inter

### Outros cartões

- Renner
- Havan
- outros cartões de loja

### Formas de pagamento

- PIX
- boleto
- cartão de crédito
- parcelamento no cartão
- pagamentos recorrentes

### Tipos de despesas

- despesas fixas com valor conhecido;
- despesas recorrentes variáveis;
- despesas ocasionais;
- compras parceladas;
- compras futuras ainda não realizadas.

A simples visualização do saldo das contas não responde à pergunta realmente importante:

> **Quanto desse dinheiro está efetivamente disponível para gastar?**

---

# 3. Problemas específicos

## P1 — Fragmentação

Os dados estão distribuídos entre bancos e cartões diferentes.

Não existe uma posição consolidada confiável.

---

## P2 — Saldo bancário não representa disponibilidade

Exemplo:

Saldo:

**R$ 10.000**

Mas existem:

- R$ 2.000 de aluguel;
- R$ 1.800 de fatura Inter;
- R$ 1.200 de fatura Santander;
- R$ 500 de contas;
- outras despesas antes da próxima receita.

O usuário não possui R$ 10.000 livres.

---

## P3 — Cartão distorce a percepção do fluxo de caixa

Uma compra de R$ 1.000 no cartão possui duas dimensões diferentes:

### Despesa econômica

A compra ocorreu hoje.

### Impacto no caixa

O dinheiro só sairá quando a fatura for paga.

Misturar esses dois eventos gera:

- double counting;
- projeções erradas;
- categorias erradas;
- falsa percepção de disponibilidade.

---

## P4 — Parcelamentos comprometem meses futuros

Uma compra:

**R$ 3.000 em 10x de R$ 300**

não representa apenas R$ 300 do mês atual.

Ela cria dez compromissos futuros.

O sistema deve considerar todo o tail de parcelas.

---

## P5 — Projeções normalmente usam estimativas demais

O objetivo do usuário é:

> usar valores reais sempre que possível e somente estimar quando não existe informação melhor.

Um sistema que mantém uma estimativa de R$ 250 para energia depois que a conta real de R$ 263,82 chegou está errado.

---

## P6 — Não existe suporte adequado a decisões futuras

Controle financeiro tradicional responde:

> Onde meu dinheiro foi?

O produto precisa também responder:

> **O que acontece se eu gastar esse dinheiro?**

---

## P7 — Planejamento de compras é desconectado da situação financeira

Exemplo real de necessidade:

Existe uma lista de produtos necessários para um bebê até uma determinada data.

Cada item possui:

- preço;
- prioridade;
- prazo;
- possível desconto à vista;
- opções de parcelamento.

O usuário precisa decidir:

- comprar agora ou depois;
- pagar à vista;
- parcelar;
- quantidade de parcelas;
- cartão;
- melhor mês de compra;
- quais itens podem esperar.

Hoje essa análise precisa ser feita manualmente.

---

## P8 — Interfaces fechadas limitam automação

Uma solução sem API/MCP não atende ao requisito principal.

O usuário já possui o Hermes funcionando continuamente e integrado ao Telegram.

O agente precisa conseguir consultar o sistema financeiro programaticamente.

---

# 4. Visão da solução

Criar uma plataforma local-first composta por:

```text
Fontes financeiras
       │
       ▼
Importação + Reconciliação
       │
       ▼
Ledger financeiro
       │
       ├── contas
       ├── transações
       ├── categorias
       ├── cartões
       ├── faturas
       └── parcelas
       │
       ▼
Planning Domain
       │
       ├── recorrências
       ├── metas
       ├── reservas
       └── planos de compra
       │
       ▼
Forecast Engine
       │
       ├── projeção diária
       ├── compromissos
       ├── safe-to-spend
       └── cenários
       │
       ▼
Planning Engine
       │
       ├── simulação
       ├── opções de pagamento
       └── purchase optimizer
       │
       ├──────────────┐
       ▼              ▼
     Web UI           MCP
                       │
                     Hermes
                       │
                    Telegram
```

---

# 5. Base tecnológica

## Decisão

**Forkar o Kosh.**

O Kosh já possui:

- contas;
- transações;
- transferências;
- categorias;
- tags;
- CSV;
- budgets;
- bills;
- recorrências;
- metas;
- relatórios;
- PostgreSQL;
- Next.js;
- Drizzle;
- camada de domínio;
- jobs;
- backup/migrations;
- valores monetários em unidades inteiras;
- criptografia de campos sensíveis;
- MCP externo read-only com tokens individuais.

Isso elimina uma grande quantidade de infraestrutura não diferenciadora.

---

# 6. Repositórios de referência

## 6.1 Kosh — base do produto

**Repo:** `kzekiue/kosh`

Usar diretamente através do fork para:

- autenticação;
- UI;
- PostgreSQL;
- transactions;
- accounts;
- categories;
- goals;
- bills;
- recurring;
- jobs;
- backup;
- migrations;
- segurança;
- MCP;
- estrutura de monorepo.

Arquitetura atual:

```text
apps/web
packages/domain
packages/db
PostgreSQL
```

O produto já utiliza armazenamento monetário em unidades inteiras e possui MCP opt-in read-only, duas decisões que deverão ser preservadas.

---

## 6.2 Entropy for Firefly III — referência para forecast de cartões

**Repo:** `4242labs/ff3e`

Principal referência para:

- projeção de recorrências;
- matching entre previsto e realizado;
- parcelas;
- ciclos de cartão;
- prevenção de double counting.

Uma decisão particularmente importante do Entropy é:

> uma parcela que já existe como transação real não deve existir novamente como previsão.

O projeto lê a parcela atual `N/M` e projeta apenas:

```text
N+1
N+2
...
M
```

Esse conceito deverá ser reproduzido no nosso domínio.

---

## 6.3 bank.mcp — referência arquitetural

**Repo:** `owieschon/bank-mcp`

Usar como referência para:

- Forecast Engine determinístico;
- recorrências;
- categorização;
- reconciliação;
- separação entre cálculo e LLM;
- integer cents;
- testes do domínio.

O projeto mantém transações, agregações e forecasts sob código determinístico, enquanto modelos podem somente complementar ou explicar informações.

Esse será um princípio estrutural do Hermes Finance.

---

## 6.4 Firefly III — referência de domínio financeiro

**Repo:** `firefly-iii/firefly-iii`

Usar como referência para:

- ledger;
- regras;
- recurring transactions;
- categorias/tags;
- importação;
- REST API;
- modelagem financeira madura.

Firefly III é self-hosted e possui API JSON cobrindo grande parte do sistema.

Não será utilizado como base devido ao custo de alterar profundamente um projeto muito maior e seu domínio não ser centrado no parcelamento brasileiro.

---

## 6.5 Actual Budget — referência para schedules

**Repo:** `actualbudget/actual`

Usar como referência especialmente para:

- scheduled transactions;
- recorrências;
- valores aproximados;
- regras;
- comportamento de recorrências com data final;
- planejamento de despesas futuras.

O Actual diferencia schedules reais/aproximados e oferece API programática para accounts, transactions, schedules, rules e budgets.

---

# 7. Princípios de produto

## R1 — Known beats estimated

A precedência obrigatória será:

```text
REAL
>
CONFIRMED FUTURE
>
FIXED RULE
>
HISTORICAL ESTIMATE
>
MANUAL ESTIMATE
```

Se surgir informação melhor, a pior deixa de participar do forecast.

---

## R2 — Fato e projeção nunca são a mesma entidade

Uma projeção não é uma transação real.

```text
Transaction != ProjectedEvent
```

---

## R3 — Nunca contar duas vezes

Quando um evento previsto for confirmado por uma transação real:

```text
ProjectedEvent
   ↓ resolved_by
Transaction
```

A previsão sai do conjunto ativo.

---

## R4 — Compra e pagamento do cartão são eventos diferentes

Compra no cartão:

```text
expense occurred
```

Pagamento da fatura:

```text
cash settlement
```

O pagamento da fatura não deve gerar uma segunda despesa por categoria.

---

## R5 — Transferências próprias não são renda nem despesa

Exemplo:

```text
Santander → Inter
```

reduz uma conta e aumenta outra.

No consolidado:

```text
net impact = 0
```

---

## R6 — LLM nunca é autoridade financeira

Hermes pode:

- consultar;
- interpretar;
- explicar;
- sugerir categoria;
- sugerir matching.

Hermes não pode ser responsável por:

- somar saldo;
- gerar forecast;
- determinar parcelas;
- determinar safe-to-spend;
- alterar um valor confirmado silenciosamente.

---

## R7 — Toda previsão precisa ter proveniência

Exemplo:

```text
Energia: R$263,82
source = imported_bill
confidence = confirmed
```

ou:

```text
Energia: R$247,30
source = historical_average
confidence = estimated
```

---

## R8 — Data freshness é parte da verdade

Mostrar:

```text
Inter
R$ 3.820,42
Atualizado há 1 dia
```

Nunca apresentar um saldo de quinze dias atrás como simplesmente "saldo atual".

---

## R9 — Recomendações precisam ser explicáveis

Nunca apenas:

> Recomendamos 5x.

Deve existir uma explicação determinística:

```text
5x mantém reserva mínima
economiza R$200 contra 10x
termina antes do prazo
menor saldo projetado = R$3.420
```

---

# 8. Conceitos financeiros distintos

O produto deve manter separação explícita entre:

## Ledger

O que aconteceu.

## Budget

Quanto pretendemos gastar.

## Forecast

O que esperamos acontecer.

## Purchase Plan

O que estamos considerando fazer.

## Simulation

O que aconteceria se tomássemos determinada decisão.

Misturar esses conceitos deverá ser considerado erro de modelagem.

---

# 9. Modelo de domínio

## 9.1 Account

Representa ativos financeiros líquidos.

Exemplos:

```text
Santander
Inter
Dinheiro
Conta poupança
```

Campos adicionais necessários:

```text
id
name
type
institution
currency
is_liquid
include_in_safe_to_spend
status
```

---

# 9.2 BalanceSnapshot

Representa uma observação real de saldo.

```text
account_id
amount_minor
observed_at
source
import_batch_id?
```

Exemplo:

```text
Inter
382042
BRL
observed_at=2026-09-07
source=manual
```

---

# 9.3 Transaction

Representa um fato financeiro confirmado.

Principais propriedades:

```text
account_id
occurred_at
posted_at
amount_minor
direction
category_id
merchant/payee
source
external_id
import_batch_id
status
```

---

# 9.4 CreditCard

Entidade explícita.

Não tratar cartão apenas como uma conta genérica.

Campos:

```text
id
name
issuer
currency
credit_limit_minor
default_closing_day
default_due_day
payment_account_id
active
```

Exemplos:

```text
Inter
Santander
Renner
Havan
```

---

# 9.5 CreditCardBillingCycle

Ciclos reais devem poder sobrescrever a configuração nominal.

```text
credit_card_id
statement_month
opened_at
closed_at
due_at
confirmed_total_minor?
source
status
```

Isso permite representar corretamente:

```text
fecha 25/set
vence 02/out
```

sem assumir eternamente que todos os ciclos fecham exatamente no mesmo dia.

---

# 9.6 CreditCardPurchase

Representa uma compra realizada no cartão.

```text
credit_card_id
transaction_id
purchase_date
category_id
merchant
total_amount_minor
installment_plan_id?
```

A compra deve aparecer na análise de despesas pela `purchase_date`.

---

# 9.7 InstallmentPlan

```text
credit_card_purchase_id
total_installments
first_installment
installment_amount
first_statement_cycle
status
```

Exemplo:

```text
Notebook
R$3.000
10x R$300
```

---

# 9.8 Installment

Cada parcela possui identidade própria.

```text
installment_plan_id
number
amount_minor
billing_cycle_id
status
transaction_id?
```

Status:

```text
PROJECTED
BILLED
PAID
CANCELLED
```

---

# 9.9 RecurringRule

Representa compromissos recorrentes.

Exemplos:

```text
aluguel
salário
internet
energia
Netflix
```

Campos:

```text
name
direction
payment_method
account/card
category
frequency
expected_day
amount_strategy
fixed_amount?
active_from
active_until?
```

---

# 9.10 AmountStrategy

Tipos:

```text
FIXED

LAST_CONFIRMED

ROLLING_AVERAGE

ROLLING_MEDIAN

SEASONAL_AVERAGE

MANUAL_ESTIMATE
```

Um gasto fixo deve utilizar `FIXED`.

Uma conta variável pode utilizar média histórica somente quando não existir valor confirmado.

---

# 9.11 ProjectedEvent

Entidade central do Forecast Engine.

```text
id
logical_key
event_type
expected_at
amount_minor
account_id
category_id?
source_type
source_id
confidence
status
resolved_by_transaction_id?
```

`logical_key` evita duplicação lógica.

Exemplo:

```text
recurring:energia:2026-10
```

---

# 9.12 Confidence

```text
ACTUAL
CONFIRMED
HIGH
MEDIUM
LOW
```

---

# 9.13 Goal

Exemplos:

```text
Reserva de emergência
Viagem
Entrada carro
```

---

# 9.14 FinancialReserve

Uma meta não é necessariamente uma reserva protegida.

Criar:

```text
HARD
SOFT
```

### HARD

Afeta `safe_to_spend`.

### SOFT

Pode ser violada em simulação, mas gera alerta.

---

# 9.15 PurchasePlan

Exemplo:

```text
Enxoval do bebê
deadline: data configurável
```

Campos:

```text
name
description
target_date
budget_minor?
status
```

---

# 9.16 PurchaseItem

```text
purchase_plan_id
name
priority
estimated_price_minor
actual_price_minor?
earliest_purchase_date?
deadline
status
notes
```

Priority:

```text
MUST_HAVE
HIGH
MEDIUM
LOW
OPTIONAL
```

Status:

```text
IDEA
PLANNED
READY
PURCHASED
CANCELLED
```

---

# 9.17 PaymentOption

Exemplos:

```text
PIX R$2.250
5x R$500
10x R$270
```

Campos:

```text
purchase_item_id
payment_method
card_id?
cash_price_minor?
installments?
installment_amount_minor?
total_cost_minor
first_payment_date?
```

O modelo deverá também suportar parcelas não uniformes futuramente.

---

# 9.18 PurchaseSimulation

Persistir snapshots das simulações.

```text
purchase_item
payment_option
created_at

current_balance
forecast_version
minimum_balance
safe_to_spend_before
safe_to_spend_after
reserve_violations
goal_violations
total_cost
last_installment_date
recommendation_score
```

Isso torna recomendações auditáveis.

---

# 9.19 ImportSource

Tipos:

```text
OFX
CSV
PDF
MANUAL
OPEN_FINANCE
API
```

---

# 9.20 ImportBatch

```text
source
institution
file_hash
started_at
completed_at
status
records_seen
records_created
duplicates
needs_review
```

---

# 10. Cartões de crédito

Este é um domínio P0.

## Compra sem parcelamento

```text
07/set
Mercado
R$300
Inter Crédito
```

Análise de gastos:

```text
07/set alimentação -R$300
```

Fluxo de caixa:

```text
02/out fatura Inter -R$300
```

---

## Compra parcelada

```text
07/set
R$3.000
10x R$300
```

O sistema deve produzir:

```text
out +300
nov +300
dez +300
...
jul +300
```

---

## Regra anti-double-count

Se a parcela 3/10 já foi importada:

```text
3/10 = REAL
```

projetar somente:

```text
4/10
...
10/10
```

Nunca:

```text
3/10 real
+
3/10 projected
```

Esse comportamento segue a estratégia utilizada pelo Entropy.

---

# 11. Fatura

O sistema deve responder:

```text
Fatura Inter outubro

Confirmado:     R$ 1.824
Projetado:      R$   430
────────────────────────
Total esperado: R$ 2.254
```

Visualmente diferenciar:

- já faturado;
- compra real ainda não fechada;
- parcela futura;
- recorrência projetada.

---

# 12. Forecast Engine

## Entrada

O Forecast Engine considera:

1. último saldo conhecido;
2. transações confirmadas após o snapshot;
3. receitas futuras confirmadas;
4. contas futuras confirmadas;
5. faturas;
6. parcelas;
7. recurring rules;
8. estimativas apenas quando necessárias;
9. metas/reservas.

---

## Saída

Gerar trajetória diária:

```text
date
opening_balance
inflows
outflows
closing_balance
events[]
confidence_breakdown
```

---

## Exemplo

```text
07/set   6.550
10/set  -1.800 aluguel
12/set    -263 energia
15/set    -120 internet
20/set     -56 assinatura
25/set  +7.500 salário
02/out  -2.430 Inter
```

Resultado:

```text
07/set R$6.550
10/set R$4.750
12/set R$4.487
15/set R$4.367
20/set R$4.311
25/set R$11.811
02/out R$9.381
```

---

# 13. Substituição de estimativa

Antes da conta chegar:

```text
Energia
R$247,30
HISTORICAL_ESTIMATE
```

Depois:

```text
Energia
R$263,82
CONFIRMED
```

Resultado:

```text
247,30 deixa de participar
263,82 passa a participar
```

Nunca:

```text
247,30
+
263,82
```

---

# 14. Matching previsto × realizado

Um `ProjectedEvent` poderá ser reconciliado automaticamente quando houver correspondência suficientemente segura.

Critérios possíveis:

```text
account
merchant/payee aliases
category
date window
amount tolerance
recurring rule
```

Se houver mais de um candidato plausível:

```text
NEEDS_REVIEW
```

O sistema nunca deverá escolher arbitrariamente.

---

# 15. Safe-to-Spend

Feature P0.

O indicador responde:

> Quanto posso gastar sem quebrar as restrições financeiras configuradas?

## Regra matemática

Para um horizonte `H`, encontrar o maior gasto `X` para o qual:

```text
projected_balance(t, X)
>=
hard_reserve(t)
```

para todo instante:

```text
t ∈ [hoje, H]
```

Portanto, não basta verificar o saldo no final do horizonte.

O sistema deve avaliar o **mínimo da curva de saldo**.

---

## Exemplo

```text
Saldo hoje:             R$ 6.550
Hard reserve:           R$ 1.500

Safe-to-spend 30 dias:  R$ 1.842
```

---

# 16. Safe-to-Spend por horizonte

Permitir:

```text
até próxima receita
30 dias
60 dias
90 dias
6 meses
12 meses
data personalizada
```

---

# 17. Safe-to-Spend por conta

Suportar:

```text
consolidado
Santander
Inter
```

No consolidado, transferências entre contas próprias não alteram patrimônio líquido.

O sistema pode indicar:

> É necessário transferir R$500 do Santander para o Inter antes de 02/out.

---

# 18. Metas e reservas

Exemplo:

```text
Reserva de emergência
R$ 15.000
HARD

Viagem
R$ 5.000
SOFT
```

Simulação deve retornar:

```text
hard reserve violated: false
soft goal impacted: viagem -R$700
```

---

# 19. Purchase Planner

Feature central.

## Caso de uso

Plano:

```text
Enxoval do bebê
Comprar itens até a data alvo
```

Itens:

```text
Carrinho
Berço
Cômoda
Cadeirinha
Roupas
Fraldas
Banheira
...
```

---

# 20. Comparação de formas de pagamento

Entrada:

```text
Carrinho

PIX        R$2.250
5x         R$500
10x        R$270
```

Executar três forecasts completos.

Resultado:

```text
PIX

Total: R$2.250
Menor saldo: R$1.240
Hard reserve: VIOLADA
```

```text
5x

Total: R$2.500
Menor saldo: R$2.830
Hard reserve: OK
Última parcela: fevereiro
```

```text
10x

Total: R$2.700
Menor saldo: R$3.120
Hard reserve: OK
Última parcela: julho
```

---

# 21. Recomendação

O sistema poderá concluir:

```text
Recomendação: 5x

Motivos:

✓ mantém reserva
✓ termina antes do prazo desejado
✓ custa R$200 menos que 10x
✗ pagamento à vista viola reserva mínima
```

A LLM pode transformar isso em linguagem natural.

A decisão numérica vem do Planning Engine.

---

# 22. Critérios do recomendador

Ordem de prioridade:

## Hard constraints

1. não deixar saldo proibidamente negativo;
2. preservar HARD reserves;
3. respeitar limite do cartão;
4. atender itens MUST_HAVE antes do deadline.

Depois otimizar:

5. menor custo;
6. melhor liquidez;
7. menor concentração de parcelas;
8. menor duração da dívida;
9. menor impacto sobre metas SOFT.

---

# 23. Planejamento global

Não analisar apenas um item isoladamente.

Exemplo:

```text
Carrinho       5x R$500
Berço          3x R$600
Cômoda         3x R$500
Cadeirinha     3x R$400
```

Individualmente todos podem parecer viáveis.

Juntos:

```text
R$2.000/mês
```

podem criar um problema.

O optimizer deve avaliar o plano completo.

---

# 24. Evolução do Purchase Optimizer

## V1

Comparação determinística de opções de um item.

## V2

Sugestão de melhor data para comprar cada item.

## V3

Otimização global do plano.

A implementação do solver deverá ficar atrás de interface:

```text
PurchasePlanOptimizer
```

para permitir trocar heurística por constraint solver posteriormente.

---

# 25. Importação

## MVP

Suportar:

```text
CSV
OFX
manual
```

---

# 26. Importação idempotente

Importar o mesmo arquivo duas vezes não pode duplicar transações.

Estratégia:

```text
external_id
```

quando disponível.

Caso contrário:

```text
fingerprint
```

baseado em informações normalizadas.

Correspondências incertas devem virar:

```text
POSSIBLE_DUPLICATE
```

e não serem silenciosamente descartadas.

---

# 27. PDF de cartões

Segunda fase.

Pipeline:

```text
PDF
 ↓
text extraction
 ↓
issuer parser
 ↓
normalized statement
 ↓
reconciliation
 ↓
preview
 ↓
user confirmation
 ↓
commit
```

---

# 28. Uso de IA em PDF

IA pode ser utilizada para sugerir estrutura quando um parser determinístico não existir.

Nunca:

```text
PDF → LLM → banco automaticamente
```

Obrigatório:

```text
LLM extraction
       ↓
validation
       ↓
statement reconciliation
       ↓
preview
       ↓
confirmation
```

---

# 29. Reconciliação de fatura

Sempre que possível:

```text
soma das compras
+ juros
+ taxas
- créditos
- pagamentos
=
total esperado
```

Diferença:

```text
R$0,00
```

→ reconciliado.

Diferença não zero:

```text
NEEDS_REVIEW
```

---

# 30. Categorias

Suportar:

```text
category
subcategory
```

Exemplo:

```text
Casa
  Energia
  Internet
  Aluguel

Alimentação
  Mercado
  Restaurante

Bebê
  Fraldas
  Roupas
  Móveis
```

---

# 31. Regras automáticas

Exemplos:

```text
merchant contains "NETFLIX"
→ Assinaturas
```

```text
merchant matches "SUPERMERCADO X"
→ Alimentação > Mercado
```

Regras determinísticas têm precedência sobre classificação por IA.

---

# 32. Dashboard

Tela inicial:

```text
┌───────────────────────────────────┐
│ Posição financeira                │
│                                   │
│ Saldo líquido       R$ 12.340     │
│ Comprometido         R$ 5.720     │
│ Safe-to-spend        R$ 4.620     │
│ Reserva protegida    R$ 2.000     │
└───────────────────────────────────┘
```

---

# 33. Forecast visual

Gráfico:

```text
saldo
│
│          ╭────────
│  ╭───────╯
│  │
│──╯
│
└──────────────── tempo
```

Selecionar:

```text
30d
60d
90d
6m
12m
```

Mostrar:

- menor saldo;
- data do menor saldo;
- eventos relevantes;
- proporção real × estimada.

---

# 34. Upcoming Commitments

Exemplo:

```text
10/set  aluguel            R$1.800 CONFIRMED
12/set  energia              R$263 CONFIRMED
15/set  internet             R$120 FIXED
02/out  Inter              R$2.430 CONFIRMED
```

---

# 35. Tela de cartões

Para cada cartão:

```text
Inter

Limite                   R$10.000
Utilizado                 R$3.200

Fatura atual              R$1.800
Ainda não faturado          R$500
Parcelas futuras          R$2.100

Próximo fechamento        25/set
Próximo vencimento        02/out
```

---

# 36. Tela de recorrências

Mostrar:

```text
nome
valor
estratégia
próxima ocorrência
forma de pagamento
confidence
```

---

# 37. Tela Purchase Planner

```text
ENXOVAL

Estimado total      R$12.300
Comprado             R$3.200
Restante              R$9.100
```

Itens separados em:

```text
Comprar agora
Comprar em breve
Pode esperar
Comprado
```

---

# 38. Simulador

Entrada:

```text
R$ 2.500

Pagamento:
[PIX Santander]
[PIX Inter]
[Inter crédito]
[Santander crédito]
```

Resultado:

```text
Impacto imediato
Impacto por mês
Menor saldo futuro
Nova fatura
Nova utilização de crédito
Safe-to-spend depois da compra
Impacto nas metas
```

---

# 39. MCP

Hermes será tratado como um cliente do Finance Engine.

Não deverá acessar diretamente as tabelas.

---

# 40. MCP read-only

P0:

```text
finance.get_position

finance.get_projection

finance.get_safe_to_spend

finance.get_accounts

finance.get_transactions

finance.get_upcoming_commitments

finance.get_credit_cards

finance.get_card_statement

finance.get_goals

finance.get_purchase_plans

finance.get_purchase_plan

finance.simulate_purchase

finance.compare_payment_options
```

---

# 41. Exemplo Hermes

Usuário:

> Quanto posso gastar até receber?

Hermes:

```text
finance.get_safe_to_spend(
    horizon="next_income"
)
```

Resposta estruturada:

```json
{
  "safe_to_spend_minor": 184200,
  "minimum_balance_minor": 150000,
  "minimum_balance_date": "2026-09-20",
  "hard_reserve_violated": false
}
```

Hermes transforma isso em resposta natural.

---

# 42. Simulação via Telegram

Usuário:

> Quero comprar um carrinho de 2500. Tem 2250 no PIX, 5x de 500 ou 10x de 270. Qual é melhor?

Hermes registra opções temporárias e chama:

```text
finance.compare_payment_options
```

O Finance Engine responde.

Hermes apenas explica.

---

# 43. MCP de escrita

Não habilitar inicialmente por padrão.

Feature flag:

```text
MCP_WRITE_ENABLED=false
```

Quando habilitado, suportar:

```text
finance.create_purchase_plan
finance.add_purchase_item
finance.add_payment_option

finance.create_goal

finance.create_recurring_rule

finance.categorize_transaction

finance.record_balance_snapshot
```

---

# 44. Segurança de MCP writes

Cada operação precisa:

- token com scope;
- validação;
- audit log;
- idempotency key;
- ownership check.

Operações destrutivas devem exigir confirmação explícita.

---

# 45. Fora de escopo

Pelo menos inicialmente:

- executar PIX;
- pagar boleto;
- realizar transferências bancárias;
- movimentar investimentos;
- solicitar crédito;
- contestar transações automaticamente;
- acessar banco com login/senha via browser automation;
- aconselhamento de investimentos;
- declaração de imposto;
- contabilidade empresarial.

O produto é um **decision-support system**, não um sistema de movimentação financeira.

---

# 46. Arquitetura proposta

Preservar o monorepo do Kosh.

Adicionar:

```text
apps/
  web/

packages/
  db/
  domain/

  forecast/
  planning/
  importers/
  integrations/
  contracts/
  test-fixtures/
```

---

# 47. packages/forecast

Deve ser domínio puro.

Não depender de:

- React;
- Next.js;
- MCP;
- PostgreSQL;
- Gemini;
- Telegram.

Entradas:

```text
balances
actual events
confirmed future events
recurrences
installments
reserves
```

Saída:

```text
Forecast
```

---

# 48. packages/planning

Responsável por:

```text
safe-to-spend
purchase simulation
payment comparison
purchase plan optimization
goal impact
```

Depende do Forecast Engine.

---

# 49. packages/importers

Adapters:

```text
OFXImporter
CSVImporter
CardStatementImporter
```

Interface comum:

```text
parse()
normalize()
validate()
reconcile()
```

---

# 50. packages/integrations

Reservado para:

```text
OpenFinanceProvider
Pluggy
Belvo
outros
```

O domínio não poderá depender dessas integrações.

---

# 51. Fonte futura de Open Finance

Fluxo:

```text
Open Finance
      ↓
integration adapter
      ↓
normalized transactions
      ↓
mesmo ledger
```

Adicionar Open Finance no futuro não pode exigir alterações no Forecast Engine.

---

# 52. Persistência monetária

Obrigatório:

```text
integer minor units
```

Exemplo:

```text
R$ 12,34
→
1234
```

Não utilizar `float` para dinheiro.

O Kosh já segue essa estratégia e ela deve ser preservada.

---

# 53. Segurança

Preservar e expandir as proteções do Kosh.

## Obrigatório

- aplicação bindada em localhost por default;
- HTTPS ao expor para rede;
- encryption key forte;
- secrets fora do banco;
- tokens MCP com scopes;
- tokens armazenados de forma segura;
- backups;
- logs sem dados financeiros completos;
- sanitização de arquivos importados;
- limite de tamanho de uploads;
- MIME validation;
- nenhuma credencial bancária armazenada.

O Kosh já possui AES-256-GCM para diversos campos sensíveis e valida configurações inseguras de produção; esses guardrails não deverão ser removidos.

---

# 54. Privacidade e IA

Gemini/IA integrada do Kosh deve ficar:

```text
KOSH_AI_ENABLED=false
```

por padrão.

Hermes usa somente as informações retornadas pelas tools solicitadas.

Não enviar o ledger inteiro para uma LLM.

Preferir:

```text
"safe_to_spend": 1842
```

a enviar milhares de transações quando a pergunta não exige isso.

---

# 55. Auditabilidade

Toda ação de escrita realizada através de:

```text
UI
MCP
import
reconciliation
```

deve registrar:

```text
actor
source
timestamp
operation
entity
before?
after?
```

---

# 56. Qualidade do domínio financeiro

O domínio precisa ser tratado como código crítico.

Pipeline mínimo:

```text
lint
typecheck
unit tests
integration tests
migration tests
build
```

---

# 57. Testes obrigatórios

## Money

- arredondamento;
- valores negativos;
- centavos;
- somas extensas.

## Installments

- 1x;
- N/M;
- diferentes valores;
- último installment;
- cancelamento;
- refund.

## Billing cycles

- compra antes do fechamento;
- compra depois do fechamento;
- mudança do dia de fechamento;
- pagamento atrasado.

## Recurring

- fixed;
- variable;
- end date;
- monthly;
- yearly;
- missing payment.

## Forecast

- actual substitui projected;
- confirmed substitui estimated;
- transfer não altera consolidado;
- card payment não duplica expense.

## Safe-to-spend

- reserva nunca violada;
- menor saldo entre receitas;
- conta específica;
- consolidado.

## Purchase Planner

- à vista;
- parcelado;
- juros;
- desconto;
- limite do cartão;
- deadline;
- reserva.

---

# 58. Testes de propriedade

Usar property-based testing para invariantes como:

```text
sum(installments) == purchase_total
```

quando aplicável.

```text
own_transfer_consolidated_effect == 0
```

```text
confirmed_event + replaced_projection
never affects forecast twice
```

```text
same inputs => same forecast
```

---

# 59. Fixtures

Todos os testes deverão utilizar dados sintéticos.

Criar fixtures:

```text
Santander checking
Inter checking

Inter credit
Santander credit
Renner
Havan

salary
rent
utility
subscriptions

installments

baby purchase plan
```

---

# 60. Observabilidade

Logar:

```text
forecast computation time
import result
reconciliation failures
job failures
MCP errors
stale accounts
```

Nunca logar:

- números de conta completos;
- token;
- documentos financeiros completos.

---

# 61. Indicadores de confiança

Dashboard deve indicar:

```text
Dados reais       82%
Confirmados       10%
Estimados          8%
```

Isso mostra ao usuário quanto da projeção depende de suposições.

---

# 62. Staleness

Definir políticas por fonte.

Exemplo:

```text
saldo bancário > 3 dias
→ stale
```

Não bloquear o sistema.

Apenas informar:

> Safe-to-spend calculado utilizando saldo Santander atualizado há 5 dias.

---

# 63. Critérios de sucesso

## Correção

- nenhum cálculo monetário por float;
- nenhuma duplicação actual/projected;
- import idempotente;
- forecast reproduzível;
- transferência própria neutra no consolidado.

## Utilidade

O produto deve responder em menos de poucos passos:

- posição financeira;
- safe-to-spend;
- menor saldo futuro;
- faturas futuras;
- impacto de uma compra;
- comparação de parcelamentos.

## Transparência

Toda previsão deve possuir:

```text
source
confidence
```

---

# 64. MVP

O MVP não precisa ter tudo.

## MVP obrigatório

### Base

- fork Kosh;
- contas;
- transações;
- categorias;
- goals existentes;
- auth;
- backup;
- MCP.

### Novo

- CreditCard;
- BillingCycle;
- CreditCardPurchase;
- InstallmentPlan;
- Installment;
- BalanceSnapshot;
- ProjectedEvent;
- RecurringRule melhorada;
- Forecast Engine;
- safe-to-spend;
- dashboard;
- simulação de compra;
- comparison de payment options;
- PurchasePlan;
- PurchaseItem;
- CSV;
- OFX;
- MCP financeiro.

---

# 65. Pós-MVP

## P1

- PDF de cartão;
- purchase optimization global;
- suggested purchase dates;
- recurring detection;
- category suggestions;
- Telegram writes;
- notifications.

## P2

- Open Finance;
- sync automático;
- app móvel;
- household/multi-user;
- scenarios persistentes;
- otimização avançada.

---

# 66. Roadmap técnico

## Fase 0 — Fork baseline

Objetivo:

ter certeza de que o Kosh continua saudável antes de alterar o domínio.

Tasks:

1. fork;
2. adicionar upstream remote;
3. pin de commit inicial;
4. rodar lint;
5. rodar typecheck;
6. rodar tests;
7. build;
8. subir Docker;
9. testar backup/restore;
10. testar MCP existente;
11. desabilitar IA externa;
12. documentar baseline.

Criar:

```text
docs/UPSTREAM.md
docs/ARCHITECTURE.md
docs/DOMAIN.md
```

---

# 67. Fase 1 — Financial truth layer

Implementar:

```text
BalanceSnapshot
ImportSource
ImportBatch
Reconciliation
```

Adicionar:

```text
OFX
```

Garantir:

```text
idempotency
provenance
freshness
```

Entrega:

posição financeira confiável.

---

# 68. Fase 2 — Brazilian Credit Card Domain

Implementar:

```text
CreditCard
BillingCycle
Statement
CreditCardPurchase
InstallmentPlan
Installment
```

Casos obrigatórios:

- Inter;
- Santander;
- cartões de loja;
- parcelamento;
- fechamento;
- vencimento;
- fatura paga por conta configurada.

Entrega:

visão correta das faturas atuais e futuras.

---

# 69. Fase 3 — Forecast Engine

Criar `packages/forecast`.

Implementar:

```text
buildForecast()
resolveProjectedEvents()
projectRecurrences()
projectInstallments()
projectStatements()
```

Saída diária.

Entrega:

30/60/90/365 dias.

---

# 70. Fase 4 — Safe-to-Spend

Criar:

```text
calculateSafeToSpend()
```

Suportar:

- hard reserve;
- horizon;
- account;
- consolidated;
- next-income.

Entrega:

indicador principal do produto.

---

# 71. Fase 5 — Dashboard

Adicionar:

```text
position
committed
safe-to-spend
reserve
forecast chart
upcoming commitments
cards
freshness
```

---

# 72. Fase 6 — MCP/Hermes

Estender MCP existente.

Tools P0:

```text
get_position
get_projection
get_safe_to_spend
get_upcoming_commitments
get_card_statement
simulate_purchase
compare_payment_options
```

Validar pelo Hermes/Telegram.

---

# 73. Fase 7 — Purchase Planner

Implementar:

```text
PurchasePlan
PurchaseItem
PaymentOption
PurchaseSimulation
```

Fluxo:

```text
item
 ↓
payment options
 ↓
multiple forecasts
 ↓
comparison
 ↓
recommendation
```

---

# 74. Fase 8 — Purchase Plan optimizer

Implementar agendamento de compras.

Entrada:

```text
itens
deadlines
priorities
payment options
forecast
reserves
```

Saída:

```text
o que comprar
quando comprar
como pagar
```

---

# 75. Fase 9 — PDFs

Implementar arquitetura de parsers por instituição.

Exemplo:

```text
InterStatementParser
SantanderStatementParser
RennerStatementParser
HavanStatementParser
```

Generic fallback pode utilizar IA somente com confirmação.

---

# 76. Fase 10 — Automação

Criar adapter:

```text
FinancialDataProvider
```

Implementações futuras:

```text
ManualProvider
FileProvider
OpenFinanceProvider
```

Se Open Finance ficar economicamente viável, apenas adicionamos um provider.

---

# 77. Estratégia de fork

Evitar alterações invasivas no core do Kosh.

Preferir:

```text
existing Kosh
│
├── untouched infrastructure
│
└── additive domain packages
```

Isso facilita absorver atualizações upstream.

---

# 78. Política de upstream

Adicionar remote:

```text
origin → nosso fork
upstream → kzekiue/kosh
```

Revisar upstream periodicamente.

Manter:

```text
docs/UPSTREAM.md
```

com:

- commit base;
- patches locais;
- conflitos conhecidos;
- decisões divergentes.

---

# 79. Licenciamento

Kosh utiliza **AGPL-3.0-only**.

Entropy também utiliza AGPL-3.0.

bank.mcp utiliza Apache-2.0.

Actual Budget utiliza MIT.

Para uso pessoal self-hosted, o fork do Kosh é adequado.

Se futuramente o projeto virar SaaS comercial, a estratégia de licenciamento deverá ser revisada antes dessa mudança.

---

# 80. Definition of Done — Finance Core

Uma feature financeira só está pronta quando:

- domínio não depende de UI;
- cálculo é determinístico;
- money usa minor units;
- inputs validados;
- invariantes testadas;
- unit tests;
- integration tests quando aplicável;
- nenhum double counting;
- audit/provenance disponível;
- migrations testadas;
- typecheck passa;
- lint passa;
- build passa.

---

# 81. Definition of Done — Forecast

Forecast só pode ser considerado pronto quando:

1. mesmo input produz mesmo output;
2. transações reais prevalecem;
3. estimativas são substituíveis;
4. installments não duplicam;
5. transfers próprias são neutras no consolidado;
6. card settlement não vira expense;
7. cada evento possui origem;
8. cada evento possui confidence;
9. menor saldo do período é calculado;
10. stale data é identificado.

---

# 82. Definition of Done — Purchase Recommendation

Uma recomendação só pode ser emitida se:

- todas as opções foram calculadas pelo mesmo snapshot financeiro;
- total cost foi calculado;
- forecast foi recalculado;
- hard reserves verificadas;
- limites dos cartões verificados;
- deadlines verificados;
- menor saldo identificado;
- diferenças entre alternativas forem explicáveis.

Caso contrário:

```text
INSUFFICIENT_DATA
```

é melhor que inventar uma recomendação.

---

# 83. Primeiro cenário end-to-end obrigatório

Criar fixture:

```text
Santander
saldo R$4.500

Inter
saldo R$3.000

Salário
R$7.500 dia 25

Aluguel
R$1.800 dia 10

Energia
variável

Internet
R$120

Inter cartão
fatura + parcelas

Santander cartão
fatura

Renner
parcelamento

Havan
parcelamento

Hard reserve
R$1.500
```

Depois cadastrar:

```text
Purchase Plan:
Enxoval

Carrinho:
PIX R$2.250
5x R$500
10x R$270
```

O sistema deve conseguir responder deterministicamente:

```text
posição atual
faturas
compromissos
forecast
safe-to-spend
impacto das três opções
recomendação
```

E o Hermes deve conseguir obter exatamente os mesmos resultados via MCP.

Esse será o primeiro acceptance scenario do produto.

---

# 84. Visão final

Hermes Finance não deverá ser apenas:

> um aplicativo que registra gastos.

Ele será:

> **um motor pessoal de decisão financeira baseado em fatos, compromissos e projeções auditáveis, capaz de dizer não apenas onde o dinheiro foi, mas quanto está realmente disponível e qual será o impacto de uma decisão antes dela ser tomada.**

A combinação de arquitetura será:

```text
Kosh
  ↓
infraestrutura + ledger + UI + MCP

Entropy
  ↓
referência para parcelas e reconciliação forecast/real

bank.mcp
  ↓
referência para engines determinísticos e isolamento da LLM

Actual Budget
  ↓
referência para schedules e recurring planning

Firefly III
  ↓
referência para domínio financeiro e regras maduras
```

O diferencial próprio será:

```text
Brazilian Credit Card Domain
+
Forecast Engine
+
Safe-to-Spend
+
Purchase Planner
+
Payment Optimizer
+
Hermes MCP
```

Esse conjunto resolve o problema original sem recriar desnecessariamente toda a infraestrutura de um gerenciador financeiro.