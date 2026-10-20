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

Budget é intenção, não previsão (PRD §8): ele nunca entra na projeção como ele mesmo. O que entra é o que ainda resta dele no mês, calculado por `projectBudgetConsumption` e emitido como fonte própria (`sourceType = budget_estimate`), com confiança LOW — é uma estimativa manual (R1).

Por budget e por mês:

$$restante = max(0, planejado - gasto - comprometido)$$

- **gasto**: despesas já lançadas nas categorias, em qualquer conta, medidas como o progresso de budget do Kosh mede;
- **comprometido**: o que a projeção já carrega nessas categorias e ainda vai acontecer no mês — bills, recorrências, eventos persistidos com categoria e as parcelas projetadas de compras já feitas. Descontar isso impede que uma conta ou parcela numa categoria orçada conte como ela mesma e de novo como budget (R3). `committedBySource` decompõe o valor por origem (bill, recorrência, evento persistido, compra no cartão), com nome, ocorrências e valor; as linhas somam exatamente o comprometido.

**O teto é o budget.** O histórico de gasto não aumenta a reserva, mesmo quando é maior que o planejado (decisão de 19/10/2026). Ele só decide a divisão entre cartão e à vista, isto é, quando o dinheiro sai.

Parcelas contam no mês da fatura em que são lançadas, não no mês da compra. É assim que o ledger as registra quando a Pluggy entrega uma transação por parcela (OPEN-FINANCE.md). Uma compra lançada à mão é uma transação de valor cheio, já está em **gasto**, e suas parcelas não viram comprometido.

`none` é a projeção só com compromissos; `forecastForScenario` mostra o custo da reserva sem reler o banco.

O dinheiro sai conforme a divisão de pagamento das categorias nos últimos 3 meses: a parte à vista é espalhada pelos dias restantes do mês; a parte de cada cartão sai no vencimento da fatura aberta no dia do gasto, como **evento separado**. Juntá-la ao total da fatura rotularia um palpite com a confiança da fatura (R7).

Todo centavo do restante vira evento, e `allocations` mostra a parte de cada rota (soma exata do restante) e as datas em que sai. A parte do cartão gasta no fim do mês pode cair numa fatura que vence depois do horizonte — com fechamento no dia 30, o gasto do dia 31 vence no dia 7 de dois meses à frente. Esse evento existe, mas a projeção daquele horizonte não o carrega; ele é reportado como `beyondHorizonMinor` (por rota e por budget) em vez de sumir. Dentro do horizonte, os eventos somam `restante − beyondHorizonMinor`.

Fora da v1: itens de purchase plan não têm categoria e não consomem budget (planejar o mesmo gasto nos dois conta duas vezes); gasto em categoria sem budget continua fora da projeção; uma categoria em dois budgets bloqueia os dois (`CATEGORY_IN_MULTIPLE_BUDGETS`) em vez de contar duas vezes.

## Cartão de crédito

Uma compra no cartão tem duas dimensões separadas:

- **despesa econômica** — datada em `purchase_date`, é o que aparece na análise por categoria;
- **impacto de caixa** — um único evento por ciclo, no `dueAt` da fatura.

`projectStatements` emite **um evento por ciclo**, nunca um por parcela. Somar as duas coisas contaria o mesmo dinheiro duas vezes (R3/R4). As parcelas alimentam o total do ciclo e a utilização do limite; elas não são eventos de caixa.

`nominalCycleFor` decide em qual fatura uma compra cai: comprar no dia 24 e no dia 26, com fechamento no 25, difere em um mês inteiro de float — e errar isso desloca todas as parcelas seguintes. Ciclos reais (`CreditCardBillingCycle`) sobrescrevem a configuração nominal sempre que existirem: um ciclo gravado é dono do seu mês qualquer que seja o vencimento, e o ledger nunca deriva uma segunda fatura para esse mês (nem quando o ciclo gravado já venceu ou o dia de vencimento do cartão mudou).

**Dias de fechamento e vencimento.** Num cartão ligado ao Open Finance, as faturas publicadas pela instituição vencem a configuração. A cada sync, o dia configurado é comparado com as três faturas mais recentes: se estiver a até 3 dias de alguma delas (deriva de fim de semana ou feriado), fica; senão, passa a ser o dia observado mais frequente (o mais recente no empate), os ciclos do provedor são rechaveados e as parcelas projetadas vão para o novo dia de vencimento. Sem faturas, vale a configuração. Todo o resto (fatura de uma compra, vencimento das parcelas, data de liquidação no safe-to-spend) usa os dias resultantes.

**Composição da fatura projetada.** O valor que o forecast liquida num ciclo é o total confirmado, quando existe (CONFIRMED), ou a soma das partes (HIGH): (a) no ciclo derivado, a dívida do ledger alocada a ele por `allocateCardDebt`; (b) as parcelas projetadas que vencem nele, e, num ciclo gravado, as parcelas atribuídas a ele; (c) cada ocorrência de bill cobrada no cartão. Uma parcela `billed` já é transação do ledger e está em (a); uma parcela atribuída a um ciclo gravado conta só nesse ciclo — somá-la de novo pelo vencimento duplicava toda compra lançada à mão. A `logicalKey` é sempre `statement:<cardId>:<YYYY-MM>`, também para ciclos gravados, cujo mês é guardado como data.

**Dívida não alocada.** O que o cartão deve hoje e não coube em nenhuma fatura derivada à frente — inclusive o que excede todas as cobranças do ledger — é `cardDebtUnplaced`, nunca descartado em silêncio. Ele se decompõe em `futureInstallmentsMinor` (parcelas projetadas do cartão a partir de hoje, que o forecast fatura uma a uma) e `unexplainedMinor` = max(0, não alocado − parcelas futuras): dívida que nada no forecast explica (atraso, juros, compra não vista).

**Fatura sem valor.** Um ciclo do provedor fechado com total ≤ 0 é `paid`, nunca `overdue`.

### Parcelas

Uma compra é **um** plano de parcelamento. A Pluggy entrega uma transação por parcela e nenhum id de compra; a parcela é reconhecida pelo cartão, pelo prazo, pelo valor da parcela (até R$ 1 de arredondamento) e pelo mês em que a parcela 1 vence (tolerância de um mês). Ela liquida a parcela projetada com o seu número ou, se for anterior a tudo que o plano já viu, estende o plano para trás — as duas ordens de chegada terminam num plano só. Uma transação que já liquidou uma parcela nunca abre outro plano ao ser relida pela janela do sync.

Planos duplicados deixados por syncs antigos são fundidos a cada sync (`repairInstallmentPlans`): mesmo cartão, prazo e valor, nenhum número de parcela com duas cobranças diferentes, e uma cobrança em comum ou o mesmo mês da parcela 1. Fica o plano visto primeiro; as cobranças dos outros passam a ele como parcelas `billed`; os outros planos, com as caudas projetadas duplicadas, são apagados. Transações do ledger nunca são tocadas. Uma transação marcada como parcela n/N que não liquidou parcela nenhuma é ligada pela mesma regra.

Status de uma parcela:

| Status | Significado |
| --- | --- |
| `projected` | Ainda sem cobrança. Entra na fatura que vence no seu `expectedAt`. |
| `billed` | A cobrança existe como transação do ledger. |
| `paid` | Reservado à conciliação explícita de uma fatura paga; o sync não o grava. |
| `cancelled` | Fora de qualquer total. |

O status diz se a cobrança existe, não se ainda é devida. Uma parcela **resta** enquanto o vencimento da sua fatura for hoje ou depois; passado esse dia, a fatura já a cobrou. Uma parcela `projected` cujo vencimento passou sem cobrança nenhuma é **caducada**: não resta, não se sabe se foi paga, e é contada à parte (`lapsedCount`). Ela não volta ao forecast — não há fatura futura onde cair.

### Uso do limite no tempo

Em toda checagem de limite (simular uma compra, comparar opções, recomendar e simular um plano), o que vale é o **pico de uso** no horizonte (`peakCardUsage`), não a soma de tudo o que se cobra. No fim de cada dia, o uso é:

- o que o cartão deve hoje, menos as faturas pagas até ali (`debtPaymentsFromForecast`), nunca abaixo de zero, porque um pagamento não libera mais do que a dívida que quita;
- mais toda cobrança feita e ainda não paga.

Uma compra parcelada bloqueia o valor inteiro no dia da compra e libera cada parcela no vencimento da fatura que a cobra, como o emissor faz. A parte dos budgets que vai para o cartão entra como cobrança diária e é liberada no vencimento da fatura correspondente. O resultado (`cardUsage`, ou `cards` no plano) mostra o uso de hoje, o pico sem e com a compra, a data de cada um e quanto passa do limite. O recomendador escolhe item a item, contando o que os itens já escolhidos ocupam do limite.

`expandInstallmentTail` reproduz a regra do Entropy: uma parcela que já existe como fato (`N`) nunca é reprojetada — apenas `N+1 … M`. A última parcela absorve o resto da divisão, de modo que a cauda soma exatamente o valor em aberto.

## Comparator e recomendação

Restrições rígidas, aplicadas nesta ordem (PRD §22):

1. piso de saldo (`NEGATIVE_BALANCE`);
2. reserva HARD (`HARD_RESERVE_VIOLATED`), só quando existe reserva HARD maior que zero — reserva zero é o próprio piso e não é reportada duas vezes;
3. limite do cartão (`CREDIT_LIMIT_EXCEEDED`);
4. prazo da última parcela (`DEADLINE_EXCEEDED`).

**Baseline já abaixo do piso.** Quando a projeção sem a compra já fura o piso (ou uma reserva HARD > 0), rejeitar tudo não responde nada: uma compra cujas parcelas caem todas depois do vale seria recusada por um buraco que já existia. Então a régua vira **não baixar o vale**: passa se o saldo mínimo depois for ≥ ao de antes; se baixar, é rejeitada com o código do nível que fica abaixo. A regra é a mesma em `simulatePurchase`, `comparePaymentOptions`, `simulatePurchasePlan` e `recommendPurchasePlan` (`balanceVerdict`), e todos reportam `baselineBreach` explicitamente.

Só então as opções são ordenadas — as viáveis primeiro; entre as inviáveis, menos restrições quebradas primeiro — por: menor custo total → maior saldo mínimo → menor concentração mensal de parcelas → menor duração da dívida → menor impacto em metas SOFT → **mais limite livre no pico do cartão** (limite − pico de uso; opção fora do cartão conta como a de mais folga) → id (desempate determinístico). A folga vem antes do id porque dois cartões no mesmo número de parcelas empatam em todo o resto, e o id empurrava a compra para o cartão quase cheio enquanto o outro estava vazio. `ranking` traz todas as opções nessa ordem, cada uma com `decidedBy`: o primeiro critério em que perdeu para a de cima.

O recomendador de plano usa, por item: maior vale → menor saída mensal de pico → menor custo total → menos parcelas → mais limite livre no pico (contando os itens já escolhidos no mesmo cartão) → id, e informa o critério que decidiu contra a segunda melhor opção.

Reservas SOFT **avisam**, nunca rejeitam: geram `softReserveImpacts` com o shortfall.

Cada opção carrega `reasons[]` com os números por trás do veredito, para que a recomendação seja explicável sem recalcular nada (R9).

O status da comparação é explícito:

| Status | Significado |
| --- | --- |
| `OK` | Existe recomendação, em `recommendedOptionId`. |
| `NO_FEASIBLE_OPTION` | Toda opção quebra uma restrição rígida; `blockers` diz quais. `leastBadOptionId` aponta a menos ruim do `ranking` — informação, não recomendação. |
| `INSUFFICIENT_DATA` | Não havia o que comparar. |

Nos dois últimos casos `recommendedOptionId` é ausente. O adapter deve mostrar isso honestamente — inventar uma recomendação é pior do que dizer que não há uma (§82).

## Contas a pagar: pagamento registrado

`lastPaidDate` só é escrito por "Marcar como paga" (`markBillPaidCore`, usado pela tela, pela API e pela tool `mark_bill_paid`) e guarda quando a última ocorrência foi paga, pelo melhor dado disponível:

| Forma | `lastPaidDate` | `lastPaidTransactionId` |
| --- | --- | --- |
| Vincular uma transação | a data da própria transação | a transação |
| Informar valor (e data) | a data informada (padrão hoje); uma despesa é criada e vinculada | a despesa criada |
| Clique único (conta fixa) | hoje — o dia em que foi marcada, sem prova de pagamento | `null` |

Nenhum job nem a sincronização Open Finance mexem nesse campo. Por isso uma conta fixa marcada com um clique mostra a data em que alguém clicou, não a do pagamento; `get_bills` expõe isso como `paidEvidence` (`transaction` ou `marked_only`).

Só transações que contam no razão (`imported`, `reviewed`, `posted`) podem ser o pagamento de uma conta: pendentes e rejeitadas não são dinheiro que saiu da conta, então não aparecem como candidatas e são recusadas ao vincular.

## Regras de automação

Uma regra varre o razão inteiro (qualquer data), nas situações `pending`, `imported`, `reviewed` e `posted`; rejeitadas nunca são tocadas. `matched` conta o que as condições selecionam; `applied`, o que de fato mudou. Uma transação que já está no estado-alvo (mesma categoria, mesmo merchant, tag já presente, já revisada ou lançada) conta como `matched` mas não como `applied` — o dry run informa isso como `alreadyInTargetCount`. `mark_reviewed` leva `pending`/`imported` a `reviewed`; aprovar no Inbox leva a `posted`.

## Confiança do Overview

O saldo líquido do índice de confiança é o saldo **líquido** das contas à vista (dinheiro, carteira, banco), não arquivadas, na moeda padrão — o mesmo total de `get_position`. Cheque especial subtrai, então ele pode ser negativo. Somar só os saldos positivos fazia uma conta corrente no vermelho desaparecer, e o fator Obrigações dizia "o que vence está coberto" com o saldo líquido abaixo de zero. Obrigações: contas ativas que vencem nos próximos 14 dias ou já venceram (em qualquer conta, inclusive cartão), pelo valor esperado; 100 se o saldo líquido cobre o total, senão 55, menos 35 por conta vencida.

## Fronteira da LLM

O modelo pode consultar, interpretar, explicar e sugerir. Ele nunca soma saldo, gera forecast, determina parcelas nem calcula safe-to-spend. As tools MCP repassam entrada e devolvem a saída determinística do engine, incluindo `reasons`, `rejections` e `blockers`.
