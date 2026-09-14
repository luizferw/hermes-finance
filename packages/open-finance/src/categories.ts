/**
 * The provider's own category, in Portuguese.
 *
 * Pluggy classifies every transaction it collects, and Meu Pluggy shows those
 * categories in Portuguese. Adopting the same names means one vocabulary across
 * both screens instead of two that have to be reconciled by hand — and it
 * categorizes the long tail of merchants that appear once or twice, which no
 * description rule can reach without becoming a rule per merchant.
 *
 * This is a starting point, not an authority: a rule the user wrote runs after
 * the sync and overrides it, which is how `AMAZON BR` ends up in "Compras
 * online" rather than "Livraria", where the provider puts it.
 *
 * Transfers get a category of their own rather than none. They are still not
 * spending — money moving between your own accounts is neither income nor
 * expense (PRD R5) — but leaving them blank made the largest single block in the
 * breakdown anonymous, which hides them rather than excluding them. The honest
 * fix for the double count is turning them into `transfer` rows, which the card
 * payment pairing does; labelling them is about legibility, not arithmetic.
 */
const PROVIDER_CATEGORY_NAMES: Record<string, string> = {
  // Alimentação
  Groceries: "Supermercado",
  "Food and drinks": "Alimentação",
  "Eating out": "Restaurantes",
  "Food delivery": "Delivery",

  // Compras
  Shopping: "Compras",
  "Online shopping": "Compras online",
  Clothing: "Roupas",
  Electronics: "Eletrônicos",
  "Pet supplies and vet": "Pet",
  "Sports goods": "Artigos esportivos",
  "Kids and toys": "Infantil e brinquedos",
  Bookstore: "Livraria",
  "Office supplies": "Material de escritório",

  // Moradia
  Houseware: "Utensílios domésticos",
  Rent: "Aluguel",

  // Automotivo
  "Gas stations": "Postos de combustível",
  Parking: "Estacionamento",
  "Tolls and in vehicle payment": "Pedágios",
  Automotive: "Manutenção de veículo",
  "Traffic fines": "Multas de trânsito",

  // Transporte
  "Taxi and ride-hailing": "Táxi e apps",
  Transportation: "Transporte público",
  "Car rental": "Aluguel de carro",

  // Serviços digitais
  "Digital services": "Serviços digitais",
  "Video streaming": "Streaming",
  "Music streaming": "Música",
  Cashback: "Cashback",

  // Saúde
  Pharmacy: "Farmácia",
  Healthcare: "Saúde",
  "Hospital clinics and labs": "Hospital/Labs",
  Dentist: "Dentista",
  Optometry: "Optometria",
  "Health insurance": "Seguro saúde",

  // Lazer
  "Gyms and fitness centers": "Academia",
  Wellness: "Bem-estar",
  Entertainment: "Entretenimento",
  "Stadiums and arenas": "Estádios e arenas",
  Tickets: "Ingressos",
  Sports: "Prática esportiva",
  Tourism: "Turismo",

  // Utilidades
  Water: "Água",
  Electricity: "Energia elétrica",
  Gas: "Gás",

  // Serviços
  Internet: "Internet",
  Telecommunications: "Telecomunicações",
  Mobile: "Celular",
  TV: "TV",
  Services: "Serviços",
  Donations: "Doações",

  // Educação
  Education: "Educação",
  School: "Escola",
  University: "Universidade",
  "Online courses": "Cursos online",
  Kindergarten: "Jardim de infância",

  // Empréstimos e financiamentos
  "Loans and financing": "Empréstimos",
  "Student loans": "Empréstimo estudantil",
  "Vehicle financing": "Financiamento de veículo",
  "Mortgage and rent": "Financiamento imobiliário",
  "Interests charged": "Juros cobrados",
  "Late payment and overdraft costs": "Juros/Multas",

  // Impostos e tarifas
  "Tax on financial operations": "IOF",
  "Income taxes": "Imposto de renda",
  "Investment taxes": "Impostos sobre investimentos",
  "Bank fees": "Tarifas de conta",
  "ATM fees": "Tarifas ATM",
  "Credit card fees": "Tarifas de cartão de crédito",

  // Seguros
  "Vehicle insurance": "Seguro de veículo",
  "Life insurance": "Seguro de vida",
  "Home insurance": "Seguro residencial",

  // Jogos de azar
  Gambling: "Aposta online",
  Lottery: "Loteria",

  // Obrigações legais
  Alimony: "Pensão alimentícia",
  "Blocked balances": "Saldos bloqueados",

  // Viagens
  Accomodation: "Hospedagem",
  Airport: "Aeroporto",
  "Bus tickets": "Passagens de ônibus",
  Mileage: "Milhagem",

  // Receitas
  "Proceeds interests and dividends": "Rendimentos",
  "Fixed income": "Rendimentos",
  Taxes: "Imposto de renda",
  Salary: "Salário",
  Refunds: "Reembolsos",
};

/**
 * The one category every movement between the user's own accounts lands in.
 *
 * Kept separate from the table above so a caller that needs to exclude transfers
 * from a spending figure can still tell them apart by `kind`, without having to
 * know the name.
 */
export const TRANSFER_CATEGORY_NAME = "Transferências";

/** Provider categories that are movements, not spending. */
const TRANSFER_CATEGORIES = new Set([
  "Transfer - PIX",
  "Transfer - Bank Slip",
  "Transfers",
  "Same person transfer",
  "Same person transfer - CASH",
  "Credit card payment",
  "Investments",
  "Loans and financing - Payment",
]);

/** Every Portuguese category name this mapping can produce. */
export function providerCategoryNames(): string[] {
  return [...new Set([...Object.values(PROVIDER_CATEGORY_NAMES), TRANSFER_CATEGORY_NAME])]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
}

export type ProviderCategoryMatch =
  | { kind: "category"; name: string }
  | { kind: "transfer"; name: string }
  | { kind: "unmapped" };

/**
 * What the provider's category means here.
 *
 * `unmapped` is a distinct answer from `transfer`: the first is a gap in this
 * table, worth surfacing so it can be filled; the second is a movement, which is
 * labelled as one and never counted as spending.
 */
export function providerCategoryName(
  providerCategory: string | null | undefined,
): ProviderCategoryMatch {
  if (!providerCategory) return { kind: "unmapped" };
  if (TRANSFER_CATEGORIES.has(providerCategory)) {
    return { kind: "transfer", name: TRANSFER_CATEGORY_NAME };
  }
  const name = PROVIDER_CATEGORY_NAMES[providerCategory];
  return name ? { kind: "category", name } : { kind: "unmapped" };
}

/**
 * Provider categories that say the two accounts have the same holder.
 *
 * A subset of `TRANSFER_CATEGORIES`, because the rest are movements without
 * saying whose the other side is: `Transfer - PIX` is the label Pluggy puts on
 * money from your own savings and on money from a friend alike. Used only to
 * break a tie in `matchSelfTransfers`, never as a requirement — see the note on
 * `SelfTransferLeg.sameOwnerHint`.
 */
const SAME_OWNER_CATEGORIES = new Set([
  "Same person transfer",
  "Same person transfer - CASH",
]);

/** Whether the provider said this row moves money between the holder's own accounts. */
export function isSameOwnerCategory(providerCategory: string | null | undefined): boolean {
  return providerCategory ? SAME_OWNER_CATEGORIES.has(providerCategory) : false;
}
