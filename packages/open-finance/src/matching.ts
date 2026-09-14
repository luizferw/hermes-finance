/**
 * Deciding which Hermes account a provider account belongs to.
 *
 * Pure, because it is the decision most worth testing and the one most likely to
 * be wrong: attaching a provider account to the wrong Hermes account interleaves
 * two institutions' histories into one ledger, and attaching it to none when a
 * match exists duplicates an account, doubling net worth.
 *
 * When more than one candidate is plausible the answer is never "pick one".
 * PRD §14 is explicit that the system must not choose arbitrarily between
 * plausible matches, so an ambiguous case creates a new account and says so.
 */

/** The Hermes `account_type` values a provider account can map onto. */
export type HermesAccountType = "asset" | "credit_card";

export interface AccountMatchCandidate {
  accountId: string;
  name: string;
  institution: string | null;
  /** Decrypted before it gets here: this column cannot be matched in SQL. */
  numberMask: string | null;
  currencyCode: string;
  type: string;
}

export interface AccountMatchInput {
  name: string;
  connectorName: string | null;
  numberMask: string | null;
  currencyCode: string;
  hermesType: HermesAccountType;
}

export type AccountMatchConfidence = "exact_mask" | "institution_mask" | "name";

export type AccountMatchDecision =
  | { kind: "match"; accountId: string; confidence: AccountMatchConfidence; note: string }
  | { kind: "create"; note: string }
  | { kind: "ambiguous"; note: string; candidateIds: string[] };

/**
 * Map the provider's account type onto Hermes'.
 *
 * A savings account maps to `asset` rather than a type of its own so it stays
 * inside the liquid balance the position is built from; ring-fencing it is what
 * `financial_reserves` is for. Anything else — investments, loans — returns
 * null: Hermes has no model for it yet and inventing one would put numbers in
 * the forecast that nobody can explain.
 */
export function hermesAccountTypeFor(
  providerType: string,
  providerSubtype: string | null,
): HermesAccountType | null {
  const type = providerType.toUpperCase();
  const subtype = providerSubtype?.toUpperCase() ?? null;

  if (type === "CREDIT") {
    return subtype === null || subtype === "CREDIT_CARD" ? "credit_card" : null;
  }
  if (type === "BANK") {
    if (subtype === null || subtype === "CHECKING_ACCOUNT" || subtype === "SAVINGS_ACCOUNT") {
      return "asset";
    }
  }
  return null;
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Lowercase, unaccented, punctuation-free, single-spaced. */
export function normalizeName(value: string): string {
  return stripDiacritics(value.toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The last four digits of an account or card number.
 *
 * Providers and humans write the same number many ways — `****1234`, `1234`,
 * `0001/12345-0` — so everything but the digits is discarded and only the tail
 * is compared. Fewer than four digits is not distinctive enough to match on.
 */
export function lastFourDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function sharesInstitutionToken(input: AccountMatchInput, candidate: AccountMatchCandidate): boolean {
  const providerTokens = new Set(
    normalizeName(`${input.connectorName ?? ""} ${input.name}`)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
  if (providerTokens.size === 0) return false;
  const candidateTokens = normalizeName(`${candidate.institution ?? ""} ${candidate.name}`)
    .split(" ")
    .filter((token) => token.length >= 3);
  return candidateTokens.some((token) => providerTokens.has(token));
}

function namesOverlap(input: AccountMatchInput, candidate: AccountMatchCandidate): boolean {
  const provider = normalizeName(`${input.connectorName ?? ""} ${input.name}`);
  const own = normalizeName(candidate.name);
  if (!provider || !own) return false;
  return provider === own || provider.includes(own) || own.includes(provider);
}

export function matchAccountCandidate(
  input: AccountMatchInput,
  candidates: readonly AccountMatchCandidate[],
): AccountMatchDecision {
  // Currency and type are hard gates, not signals. A BRL card is never the same
  // account as a USD one however similar the names look.
  const comparable = candidates.filter(
    (candidate) =>
      candidate.currencyCode.toUpperCase() === input.currencyCode.toUpperCase() &&
      candidate.type === input.hermesType,
  );
  if (comparable.length === 0) {
    return { kind: "create", note: "no existing account of the same type and currency" };
  }

  const wantedTail = lastFourDigits(input.numberMask);
  const byTail = wantedTail
    ? comparable.filter((candidate) => lastFourDigits(candidate.numberMask) === wantedTail)
    : [];

  const rules: { confidence: AccountMatchConfidence; matches: AccountMatchCandidate[]; note: string }[] = [
    {
      confidence: "exact_mask",
      matches: byTail.filter((candidate) => sharesInstitutionToken(input, candidate)),
      note: wantedTail ? `last four ${wantedTail} and the institution match` : "",
    },
    {
      confidence: "institution_mask",
      matches: byTail,
      note: wantedTail ? `last four ${wantedTail} match` : "",
    },
    {
      confidence: "name",
      matches: comparable.filter((candidate) => namesOverlap(input, candidate)),
      note: "the name matches",
    },
  ];

  for (const rule of rules) {
    if (rule.matches.length === 1) {
      const matched = rule.matches[0]!;
      return {
        kind: "match",
        accountId: matched.accountId,
        confidence: rule.confidence,
        note: `linked to "${matched.name}": ${rule.note}`,
      };
    }
    if (rule.matches.length > 1) {
      return {
        kind: "ambiguous",
        note: `${rule.matches.length} of your accounts match (${rule.note}); none was chosen`,
        candidateIds: rule.matches.map((candidate) => candidate.accountId),
      };
    }
  }

  return { kind: "create", note: "no existing account matches" };
}

/**
 * A name no other account of this user already holds.
 *
 * `accounts_user_name_unique` makes a collision an insert failure rather than a
 * cosmetic problem, and two cards from the same issuer collide routinely.
 */
export function uniqueAccountName(base: string, taken: ReadonlySet<string>): string {
  const trimmed = base.trim() || "Account";
  if (!taken.has(trimmed)) return trimmed;
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${trimmed} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${trimmed} (${Date.now()})`;
}

/** `Nubank Conta Corrente (1234)` — what an auto-created account gets called. */
export function proposeAccountName(input: {
  connectorName: string | null;
  providerName: string;
  numberMask: string | null;
}): string {
  const connector = input.connectorName?.trim() ?? "";
  const name = input.providerName.trim();
  const head = normalizeName(name).includes(normalizeName(connector)) || !connector
    ? name
    : `${connector} ${name}`;
  const tail = lastFourDigits(input.numberMask);
  return tail ? `${head} (${tail})` : head;
}
