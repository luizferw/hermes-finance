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

## Safe-to-spend

Para uma previsão com menor saldo $M$ e reserva HARD $R$:

$$safeToSpend = max(0, M - R)$$

O cálculo não usa apenas o saldo final: o vale da curva é a restrição.

## Comparator V1

Cada opção gera seus próprios eventos de settlement de caixa e recebe um novo Forecast sobre o mesmo snapshot. Ordem atual:

1. rejeitar opções que violam reserva HARD;
2. menor custo total;
3. maior menor-saldo;
4. ID estável como desempate determinístico.

Se nenhuma opção for viável, `recommendedOptionId` é ausente. O adapter deve expor isso como `INSUFFICIENT_DATA`/nenhuma opção viável, não inventar uma recomendação.
