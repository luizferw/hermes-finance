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
 * Transfer categories are deliberately absent. Money moving between your own
 * accounts is neither income nor expense (PRD R5), so a PIX between your own
 * accounts, a card bill payment or an investment move must stay uncategorized —
 * giving them a category would inflate every spending report with money that
 * only changed place.
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
  Salary: "Salário",
  Refunds: "Reembolsos",
};

/**
 * Provider categories that must never become a Hermes category.
 *
 * Listed rather than merely omitted so an unmapped category can be reported as
 * a gap worth filling, while these are reported as nothing at all.
 */
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
  return [...new Set(Object.values(PROVIDER_CATEGORY_NAMES))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

export type ProviderCategoryMatch =
  | { kind: "category"; name: string }
  | { kind: "transfer" }
  | { kind: "unmapped" };

/**
 * What the provider's category means here.
 *
 * `unmapped` is a distinct answer from `transfer`: the first is a gap in this
 * table, worth surfacing so it can be filled, and the second is a deliberate
 * refusal to categorize.
 */
export function providerCategoryName(
  providerCategory: string | null | undefined,
): ProviderCategoryMatch {
  if (!providerCategory) return { kind: "unmapped" };
  if (TRANSFER_CATEGORIES.has(providerCategory)) return { kind: "transfer" };
  const name = PROVIDER_CATEGORY_NAMES[providerCategory];
  return name ? { kind: "category", name } : { kind: "unmapped" };
}
