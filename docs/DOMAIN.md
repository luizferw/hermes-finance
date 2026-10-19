# Domínio financeiro

## Precedência de verdade

`ACTUAL > CONFIRMED > HIGH > MEDIUM > LOW`

O Forecast seleciona somente o evento de maior confiança para uma mesma `logicalKey`. Um evento com `resolvedByTransactionId` fica fora da projeção ativa. Isso impede `estimativa + conta confirmada` e `parcela real + parcela projetada` no mesmo fluxo.

## Convenções do core

| Conceito | Representação |
| --- | --- |
| Dinheiro | `number` inteiro em unidades menores (`amountMinor`); nunca float. |
| Evento de caixa | Sinalizado: entrada positiva, saída negativa. |
| Compromisso lógico | `logicalKey` estável, por exemplo `energy:2026-09`. |
| Confiança | `ACTUAL`, `CONFIRMED`, `HIGH`, `MEDIUM`, `LOW`. |
| Reserva protegida | `hardReserveMinor`, aplicada a cada dia do horizonte. |

### Chaves lógicas em uso

| Origem | `logicalKey` |
| --- | --- |
| Recorrência / bill | `recurring:<ruleId>:<data>` |
| Fatura de cartão | `statement:<cardId>:<statementMonth>` |
| Simulação de compra | `simulation:<optionId>:<n>` |
| Gasto variável estimado (à vista) | `budget:<budgetId>:<mês>:cash:<data>` |
| Gasto variável estimado (cartão) | `budget:<budgetId>:<mês>:card:<cardId>:<statementMonth>` |

## Saldo mínimo

O vale da curva é medido sobre os **fechamentos diários**, não sobre o saldo de abertura.

O saldo de abertura é a posição *antes* de qualquer movimento do dia, e não é um nível que a projeção precise proteger — é justamente dele que sai o dinheiro gasto hoje. Incluí-lo subestimaria o safe-to-spend sempre que o saldo subisse no primeiro dia, e discordaria do gráfico, que plota fechamentos.

## Safe-to-spend

Para uma previsão com menor saldo $M$ e reserva HARD $R$:

$$safeToSpend = max(0, M - R)$$

Duas propriedades são verificadas por testes de invariante sobre 200 cenários gerados:

1. **Seguro** — gastar exatamente `safeToSpend` hoje nunca leva a projeção abaixo de $R$.
2. **Máximo** — gastar `safeToSpend + 1` sempre viola $R$.

Vale também: nunca é negativo, nunca excede o vale, e nunca cresce quando a reserva cresce.

## Budgets na projeção

Budget é intenção, não previsão (PRD §8): ele nunca entra na projeção como ele mesmo. O que entra é uma estimativa do gasto variável que as categorias do budget ainda vão ter, calculada por `projectBudgetConsumption` e emitida como fonte própria (`sourceType = budget_estimate`), com confiança MEDIUM ou LOW.

Por budget e por mês, sempre na data econômica (R4):

$$restante = max(0, planejado - gasto - comprometido)$$

- **gasto**: despesas já lançadas nas categorias, em qualquer conta, cartão incluído na data da compra;
- **comprometido**: o que a projeção já carrega nessas categorias e ainda vai acontecer no mês (bills, recorrências, eventos persistidos com categoria). Descontar isso impede que uma conta numa categoria orçada conte como conta e de novo como budget (R3). Parcelas de compras antigas não entram: a despesa delas pertence ao mês da compra.

Dois cenários:

| Cenário | Base do "quanto ainda sai" | Confiança |
| --- | --- | --- |
| `base` (padrão) | Mediana dos 3 últimos meses completos das categorias no lugar do planejado (R1: histórico vence estimativa manual). Sem 3 meses cobertos pelo ledger, usa o budget. | MEDIUM com histórico; LOW sem |
| `conservative` | `max(base, restante do budget)` — nunca mais otimista que o histórico | LOW, salvo quando o histórico vence |

`none` é a projeção só com compromissos; `forecastForScenario` troca de cenário sem reler o banco.

O dinheiro sai conforme o histórico de pagamento das categorias: a parte à vista é espalhada pelos dias restantes do mês; a parte de cada cartão sai no vencimento da fatura aberta no dia do gasto, como **evento separado**. Juntá-la ao total da fatura rotularia um palpite com a confiança da fatura (R7).

Fora da v1: itens de purchase plan não têm categoria e não consomem budget (planejar o mesmo gasto nos dois conta duas vezes); gasto em categoria sem budget continua fora da projeção; uma categoria em dois budgets bloqueia os dois (`CATEGORY_IN_MULTIPLE_BUDGETS`) em vez de contar duas vezes.

## Cartão de crédito

Uma compra no cartão tem duas dimensões separadas:

- **despesa econômica** — datada em `purchase_date`, é o que aparece na análise por categoria;
- **impacto de caixa** — um único evento por ciclo, no `dueAt` da fatura.

`projectStatements` emite **um evento por ciclo**, nunca um por parcela. Somar as duas coisas contaria o mesmo dinheiro duas vezes (R3/R4). As parcelas alimentam o total do ciclo e a utilização do limite; elas não são eventos de caixa.

`nominalCycleFor` decide em qual fatura uma compra cai: comprar no dia 24 e no dia 26, com fechamento no 25, difere em um mês inteiro de float — e errar isso desloca todas as parcelas seguintes. Ciclos reais (`CreditCardBillingCycle`) sobrescrevem a configuração nominal sempre que existirem.

`expandInstallmentTail` reproduz a regra do Entropy: uma parcela que já existe como fato (`N`) nunca é reprojetada — apenas `N+1 … M`. A última parcela absorve o resto da divisão, de modo que a cauda soma exatamente o valor em aberto.

## Comparator e recomendação

Restrições rígidas, aplicadas nesta ordem (PRD §22):

1. piso de saldo (`NEGATIVE_BALANCE`);
2. reserva HARD (`HARD_RESERVE_VIOLATED`);
3. limite do cartão (`CREDIT_LIMIT_EXCEEDED`);
4. prazo da última parcela (`DEADLINE_EXCEEDED`).

Só então as opções viáveis são ordenadas por: menor custo total → maior saldo mínimo → menor concentração mensal de parcelas → menor duração da dívida → menor impacto em metas SOFT → id (desempate determinístico).

Reservas SOFT **avisam**, nunca rejeitam: geram `softReserveImpacts` com o shortfall.

Cada opção carrega `reasons[]` com os números por trás do veredito, para que a recomendação seja explicável sem recalcular nada (R9).

O status da comparação é explícito:

| Status | Significado |
| --- | --- |
| `OK` | Existe recomendação, em `recommendedOptionId`. |
| `NO_FEASIBLE_OPTION` | Toda opção quebra uma restrição rígida; `blockers` diz quais. |
| `INSUFFICIENT_DATA` | Não havia o que comparar. |

Nos dois últimos casos `recommendedOptionId` é ausente. O adapter deve mostrar isso honestamente — inventar uma recomendação é pior do que dizer que não há uma (§82).

## Fronteira da LLM

O modelo pode consultar, interpretar, explicar e sugerir. Ele nunca soma saldo, gera forecast, determina parcelas nem calcula safe-to-spend. As tools MCP repassam entrada e devolvem a saída determinística do engine, incluindo `reasons`, `rejections` e `blockers`.
