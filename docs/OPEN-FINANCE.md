# Open Finance (Pluggy)

Ingestão **somente leitura** de contas, cartões, transações e faturas, a partir das
conexões que você já criou no [meu.pluggy.ai](https://meu.pluggy.ai).

Isto implementa o que a PRD reservou em §50 (`OpenFinanceProvider`), §51 (*adicionar Open
Finance não pode exigir alterações no Forecast Engine*) e §9.19 (`ImportSource = OPEN_FINANCE`).

## O que o Hermes faz e o que não faz

**Não faz:** criar, atualizar ou apagar conexão bancária; pedir consentimento; guardar
credencial de banco; iniciar pagamento; expor webhook. Nenhum método do cliente HTTP
escreve na Pluggy — a leitura é a única operação que existe no código.

**Faz:** ler os Items que você registrou, criar ou vincular contas, gravar transações no
ledger, registrar saldos com a data de observação do provedor, e transformar faturas
fechadas em ciclos confirmados.

Todo remédio de conexão (senha trocada, MFA, consentimento expirado) acontece no
meu.pluggy.ai. A tela de configurações diz isso quando o Item está travado.

## Configuração

1. Conecte seus bancos em [meu.pluggy.ai](https://meu.pluggy.ai).
2. No [dashboard.pluggy.ai](https://dashboard.pluggy.ai), pegue o `Client ID` e o
   `Client Secret` da sua aplicação.
3. No `.env` da raiz:

```bash
PLUGGY_ENABLED=true
PLUGGY_CLIENT_ID=...
PLUGGY_CLIENT_SECRET=...
```

4. Recrie o container web, que é quem lê essas variáveis:

```bash
docker compose up -d --build web
```

5. Em **Settings → Open Finance**, cole o **Item ID** de cada conexão. No dashboard da
   Pluggy ele sai no menu de três pontos, em *Copiar Item ID*.

O `GET /v2/items` da Pluggy é opt-in e vem desabilitado por padrão, por isso os Item IDs
são colados à mão em vez de descobertos. As credenciais são do *deployment*, não de um
usuário: não há token por usuário e nenhuma coluna criptografada de segredo.

## Como o sync funciona

Roda pelo job `open-finance-sync` (cron em `PLUGGY_SYNC_SCHEDULE`, padrão 08:00 BRT) e
pelo botão **Sync now**. Não há webhook: os webhooks da Pluggy não trazem assinatura, e
este deploy não é alcançável pela internet.

Por conexão:

1. **Trava.** `last_sync_status = 'running'` impede que o job e o botão andem juntos.
   Uma trava com mais de 30 minutos é considerada órfã e pode ser retomada.
2. **`GET /items/:id`.** Item em `LOGIN_ERROR`, esperando o usuário, ou com consentimento
   expirado encerra o run **sem escrever nada**. Nesses estados os endpoints de dados
   voltam vazios, e vazio nunca pode ser lido como "apagaram tudo".
3. **Contas.** Cada conta do provedor é vinculada a uma conta do Hermes — ver abaixo.
4. **Transações.** Janela de `synced_through - 8 dias` até hoje (ou 12 meses no primeiro
   run). A releitura é de graça porque `(account_id, external_id)` é único, e é ela que
   pega lançamento postado com atraso e autorização que virou fato.
5. **Saldo.** Vai para `balance_snapshots` com `source = 'pluggy'` e a data de observação
   **do provedor** — é isso que faz o frescor exibido ser verdade (R8).
6. **Cartões.** Faturas viram ciclos com `confirmed_total_minor`; parcelas viram planos.
7. **Regras.** `runRulesOnTransactions(..., "import")` nos registros novos.

Uma conta que falha não derruba as outras: o run termina `partial` e o erro fica em
`open_finance_sync_runs.stats.failedAccounts`.

## Decisões que valem explicar

### Idempotência é do banco

O `transactionId` da Pluggy vai em `transactions.external_id`, onde o índice único parcial
`(account_id, external_id)` já existia. Reprocessar um lote atualiza em vez de duplicar
(§26). O upsert **recusa** sobrescrever linha `reviewed` ou `posted`: senão cada sync
desfaria a categorização que você tinha feito.

### Float para minor units

A Pluggy manda `10000.76`. Multiplicar por 100 é como `1.005` vira 100 em vez de 101, então
a conversão trabalha sobre a representação decimal do próprio número, não sobre aritmética.

### Data não é instante

A Pluggy documenta as datas como UTC e manda uma data pura como meia-noite UTC. Deslocar
para GMT-3 jogaria toda transação um dia para trás — e perto do fechamento do cartão, um
mês inteiro de parcelas. Meia-noite exata é lida como data; horário real é deslocado.

### Sinal inverte no cartão

Em conta bancária, positivo é entrada. Em cartão, positivo é **compra** e negativo é o
**pagamento da fatura**.

### O pagamento da fatura

A perna do cartão nunca é lançada: um pagamento de fatura não é despesa do cartão (R4).
Ela é **lembrada** em `open_finance_card_payments`, e é essa lembrança que permite
reconhecer a saída correspondente na conta pagadora.

A saída do banco, que já existe como despesa, é então convertida em **`transfer`** apontando
para a conta do cartão. Uma linha só, porque é assim que o resto do sistema já lê pagamento
de fatura — o comentário em `deriveLedgerCycles` diz: *"a transfer is one row on the source
account, its destination leg is derived, never stored"*. O `recomputeAccountBalances` credita
o cartão sozinho.

Sem isso o saldo do cartão **divergiria para sempre**: entrariam só as compras, nunca os
pagamentos que as quitam, e a dívida afundaria um pouco mais a cada mês.

A conversão só acontece quando **exatamente um** cartão tem um pagamento pulado de mesmo
valor absoluto em ±2 dias. Zero ou mais de um candidato: a linha fica como despesa e entra em
`needs_review` — §14 proíbe escolher arbitrariamente. Cada perna é consumida uma única vez,
então uma saída não pode quitar duas faturas.

A categoria é zerada na conversão: transferência entre contas próprias não é receita nem
despesa (R5), então qualquer categoria que uma regra tenha adivinhado está errada por
definição.

### Saldo de abertura é resolvido de trás para frente, e a cada sync

Doze meses de histórico não somam um saldo construído em anos. Numa conta **criada** pelo
sync, a diferença vai para `opening_balance_minor` — que é o que essa coluna significa — em
vez de virar transação de ajuste inventada.

É recalculado em **todo** sync, não uma vez só. A primeira versão resolvia uma vez e isso
estava errado: qualquer coisa que depois mude o conteúdo da janela — um lançamento que
chega atrasado, uma releitura, um pagamento de fatura que vira transferência — deixa a
diferença antiga congelada e a conta passa a contar aquele dinheiro duas vezes. Foi
exatamente o que aconteceu quando o pareamento entrou: o saldo do cartão ficou **positivo**
e a tela de cartões mostrou limite todo disponível num cartão que devia R$ 10 mil.

O provedor informa o saldo verdadeiro a cada run, então a correção está sempre disponível;
não aplicá-la é a única forma de divergir. Cada correção fica registrada em
`stats.openingBalanceCorrections` do run.

**Nunca** roda em conta que já era sua: reescrever o saldo inicial de alguém reescreve o
histórico dela. Nessas, a diferença é reportada como drift e nada é tocado.

### Contas duplicadas

Antes de criar, o sync procura uma conta sua que bata por final do número e instituição.
`accounts.account_number_mask` é `encryptedText`, então a comparação é em memória — um
`WHERE` sobre ciphertext casa nada, em silêncio. Com duas candidatas igualmente plausíveis
nenhuma é escolhida (§14): cria-se uma nova e a ambiguidade fica registrada na decisão, que
aparece por escrito na tela e pode ser sobrescrita.

### Mês da fatura

O `statement_month` sai de `nominalCycleFor`, a mesma função que `registerCardPurchase` e
`deriveLedgerCycles` usam. Derivar do vencimento — a leitura óbvia de uma fatura Pluggy —
criaria um segundo ciclo paralelo para o mesmo mês e contaria o dinheiro duas vezes (R3).

### Parcelas

A Pluggy emite **uma transação por parcela**, não uma pela compra. A primeira parcela vista
é dona da compra e do plano (com `first_installment_number = N`, porque a janela de 12 meses
pode começar no meio); as seguintes só marcam a própria parcela como `billed`. Nenhum evento
de caixa por parcela — `projectStatements` emite um por ciclo (DOMAIN.md).

### `PENDING` é assimétrico

No banco, `PENDING` é autorização que pode nunca liquidar: fica fora do saldo. No cartão,
`PENDING` é compra em fatura aberta, que já aconteceu (R4) — e marcá-la como `pending`
partiria o cartão ao meio, já que `deriveLedgerCycles` conta linhas de cartão sem filtrar
status enquanto o teto de dívida vem do saldo, que filtra.

### Categorias

O sync aplica a categoria que a própria Pluggy atribuiu, traduzida para os mesmos nomes
que o Meu Pluggy mostra (`packages/open-finance/src/categories.ts`). Um vocabulário só nas
duas telas, e a cauda longa de estabelecimentos que aparecem uma ou duas vezes fica
categorizada — nenhuma regra por descrição alcança isso sem virar uma regra por
estabelecimento.

É um ponto de partida, não autoridade: as regras rodam **depois** do sync e sobrescrevem.
É assim que `AMAZON BR` acaba em *Compras online* em vez de *Livraria*, que é onde a
Pluggy coloca.

Três recusas deliberadas:

- **Transferência recebe a categoria «Transferências»**, e só ela. PIX entre contas
  próprias, pagamento de fatura e movimentação de investimento não são gasto (R5), mas
  deixá-las em branco fazia delas o maior bloco anônimo do relatório — escondia, não
  excluía. O conserto aritmético de verdade é virarem `type='transfer'`, que é o que o
  pareamento de fatura faz; o rótulo é sobre legibilidade. Quem precisa excluí-las de um
  total distingue por `kind`, sem precisar saber o nome.
- **Categoria do provedor sem tradução** não é chutada: fica sem categoria e o nome cru vai
  para `stats.unmappedCategories` do run, para você decidir e preencher a tabela.
- **Nome traduzido sem categoria correspondente** no seu cadastro também não é criado
  sozinho; vai para `stats.missingCategories`.

Numa releitura de janela, `category_id` **não** é atualizado — senão cada sync desfaria a
categoria que uma regra ou você definiram depois.

## Operação

```bash
# conferir o que o último sync fez
psql "$DATABASE_URL" -c "select started_at, status, records_seen, records_created,
  duplicates, needs_review, skipped, error from open_finance_sync_runs
  order by started_at desc limit 10;"
```

Remover uma conexão **não** apaga contas nem transações. O que foi importado é histórico do
ledger, e histórico não deixa de ser verdade porque o cano que o trouxe saiu.

## Tabelas

| Tabela | O que guarda |
| --- | --- |
| `open_finance_connections` | Um Item da Pluggy: status, consentimento, frescor, último run. |
| `open_finance_account_links` | Conta do provedor ↔ conta do Hermes, a decisão de vínculo e a marca d'água do sync. |
| `open_finance_sync_runs` | Um run, no formato do `ImportBatch` da §9.20. |

Nenhuma tabela do Kosh foi alterada (`docs/UPSTREAM.md`).
