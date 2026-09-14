# Open Finance (Pluggy)

Ingestão **somente leitura** de contas, cartões, transações e faturas. A conexão com o
banco é feita dentro do próprio Hermes, pelo widget da Pluggy.

Isto implementa o que a PRD reservou em §50 (`OpenFinanceProvider`), §51 (*adicionar Open
Finance não pode exigir alterações no Forecast Engine*) e §9.19 (`ImportSource = OPEN_FINANCE`).

## O que o Hermes faz e o que não faz

**Não faz:** ver, guardar ou transmitir sua senha de banco; iniciar pagamento; expor
webhook. A autenticação acontece dentro do iframe da Pluggy, em `connect.pluggy.ai` — o
Hermes só recebe o `itemId` no fim.

**Faz:** abrir o widget, adotar o Item criado, criar ou vincular contas, gravar transações
no ledger, registrar saldos com a data de observação do provedor, e transformar faturas
fechadas em ciclos confirmados.

Senha trocada, MFA ou consentimento expirado se resolvem no botão **Reconnect**, que
reabre o widget em modo de atualização **sobre o mesmo Item** — os vínculos de conta e o
histórico importado continuam presos a ele. Criar uma conexão nova no lugar duplicaria
tudo.

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

5. Em **Settings → Open Finance**, clique em **Connect a bank**.

As credenciais são do *deployment*, não de um usuário: não há token por usuário e nenhuma
coluna criptografada de segredo.

### Bancos conectados antes desta tela existir

Há um campo secundário para colar um **Item ID** à mão. Ele existe porque o
`GET /v2/items` da Pluggy é opt-in e vem desabilitado, então Items criados fora daqui
(no meu.pluggy.ai, por exemplo) não podem ser descobertos — só adotados pelo id.

## Como a conexão é criada

1. O navegador pede um **connect token** a `POST /api/open-finance/connect-token`. O token
   é criado no servidor porque precisa da API key do deployment, que nunca vai ao browser.
   Dura 30 minutos.
2. Sem `itemId`, o token só serve para **criar** conexão. Com `itemId` — o caso do
   *Reconnect* — ele autoriza o widget a mexer naquele Item, e por isso a posse da conexão
   é conferida **antes** de emitir o token: entregar um token para o Item de outro usuário
   seria um buraco que nenhuma checagem posterior fecharia.
3. O widget abre, o usuário autentica no banco, e devolve o `itemId` no `onSuccess`.
4. `adoptConnection` grava a conexão e dispara o primeiro sync na hora — uma conexão que
   aparece vazia é indistinguível, para quem está olhando, de uma que falhou.

O widget é carregado de `cdn.pluggy.ai` e abre um iframe em `connect.pluggy.ai`. Isso exige
afrouxar a CSP, o que é feito **apenas nessa rota** (`apps/web/next.config.ts`): a tela de
transações não tem por que aceitar script de terceiro, e uma CSP relaxada no app inteiro
para servir uma tela de configuração deixa de ser uma CSP. A versão do widget é fixada, não
flutuante — versão que se move é fronteira de confiança que se move.

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

### O pagamento da fatura (limitação conhecida)

A perna do cartão é pulada e contada, nunca lançada duas vezes (R4). Mas a perna do banco —
o débito da fatura na conta corrente — **entra hoje como despesa avulsa**, que é exatamente
a segunda despesa que a R4 proíbe. É uma lacuna deliberada: essas linhas recebem
`transaction_metadata['open_finance.card_payment_candidate']`, para que uma fase futura
transforme o par em `transfer` sem rebuscar nada do provedor.

### Saldo de abertura é resolvido de trás para frente

Doze meses de histórico não somam um saldo construído em anos. Numa conta **criada** pelo
sync, a diferença vai para `opening_balance_minor` — que é o que essa coluna significa — em
vez de virar transação de ajuste inventada. Roda uma vez, e **nunca** em conta que já era
sua: reescrever o saldo inicial de alguém reescreve o histórico dela.

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
