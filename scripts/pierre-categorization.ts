export const PIERRE_CATEGORY_NAMES = [
  "Bills & Utilities",
  "Education",
  "Entertainment",
  "Food & Dining",
  "Groceries",
  "Health",
  "Other",
  "Rent",
  "Shopping",
  "Subscriptions",
  "Transport",
  "Travel",
] as const;

export type PierreCategoryName = (typeof PIERRE_CATEGORY_NAMES)[number];

function normalized(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Pierre does not expose a category on the raw transactions used by the
 * migration. This mapping deliberately uses only durable merchant/narration
 * signals. Anything without a defensible match is filed under Other, never
 * left uncategorized.
 */
export function categorizePierreTransaction(input: {
  type: string;
  description: string;
  merchant?: string | null;
  rawDescription?: string | null;
}): PierreCategoryName {
  if (input.type !== "expense") return "Other";

  const text = normalized([input.description, input.merchant, input.rawDescription].filter(Boolean).join(" "));

  if (/\baluguel\b|\brent\b|imobiliari|administradora de imoveis/.test(text)) return "Rent";
  if (/farmacia|drogaria|otica|optica|hospital|clinica|medic|laboratorio|odont|dentist/.test(text)) return "Health";
  if (/udemy|coursera|alura|upeople|university|universidade|faculdade|curso\b|escola|livraria/.test(text)) return "Education";
  if (/hotel|pousada|airbnb|booking\.com|decolar|latam|gol linhas|azul linhas|urentcar|rent ?a ?car|locadora/.test(text)) return "Travel";
  if (/uber|99 ?pop|taxi|posto|petrobras|gasolina|combustivel|estacion|pedagio|sem parar|auto posto/.test(text)) return "Transport";
  if (/openai|chatgpt|claude\.ai|anthropic|spotify|netflix|hetzner|github|google one|icloud|dropbox|youtube premium|prime video|amazon prime|disney\+|hbo max|crunchyroll/.test(text)) return "Subscriptions";
  if (/unifique|telecom|internet|celesc|energia eletrica|agua e esgoto|saneamento|claro\b|vivo\b|tim\b|oi\b|seguradora|protecao veicular|hubcare/.test(text)) return "Bills & Utilities";
  if (/mercadolivre|mercado livre|amazon|shein|shopee|havan|milium|cassol|pittol|calcad|modas|loja\b|decor|colchoes|princesa|magazine/.test(text)) return "Shopping";
  if (/hipermais|hiper popular|komprao|condor|giassi|fort atacadista|atacadista|supermerc|mercado|kiverde|verdureira|sacolao|frutaria|hortifruti|feira\b|mini mercado|1001 atacado/.test(text)) return "Groceries";
  if (/ifood|restaur|pizzaria|lanchonete|hamburg|sorveteria|panificadora|padaria|confeitaria|cafe\b|cafeteria|food\b/.test(text)) return "Food & Dining";
  if (/youtube|clash of clans|steam|playstation|xbox|cinema|teatro|show\b|so festa|festa\b|jogos?\b/.test(text)) return "Entertainment";

  return "Other";
}
