/**
 * A thin REST client for the Pluggy data API.
 *
 * This is the only impure file in the package. It is written against `fetch`
 * rather than `pluggy-sdk` because the SDK drags in `got` and `jsonwebtoken`
 * for four GET endpoints, and because an injectable `fetch` is what makes the
 * pagination and retry behaviour testable without a network.
 *
 * Read-only by construction: there is no method here that creates, updates or
 * deletes an Item. Connections are managed by the user at meu.pluggy.ai.
 */
import {
  parseAccount,
  parseAuthResponse,
  parseBill,
  parseCursorPage,
  parseItem,
  parseResults,
  parseTransaction,
  type PluggyAccount,
  type PluggyBill,
  type PluggyItem,
  type PluggyTransaction,
} from "./wire";

export const PLUGGY_BASE_URL = "https://api.pluggy.ai";

/** Pluggy caps transaction pages at 500. */
const TRANSACTIONS_PAGE_SIZE = 500;

/** An API key lives two hours; renew early so a long run never trips over it. */
const API_KEY_TTL_MS = 110 * 60 * 1000;

const MAX_ATTEMPTS = 3;

export class PluggyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PluggyError";
    this.status = status;
    this.code = code;
  }

  /** Retrying will not help: bad credentials, a missing item, a revoked consent. */
  get isPermanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface PluggyClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ListTransactionsOptions {
  /** Inclusive `YYYY-MM-DD` lower bound. */
  from?: string;
  /** Inclusive `YYYY-MM-DD` upper bound. */
  to?: string;
}

export interface PluggyClient {
  getItem(itemId: string): Promise<PluggyItem>;
  listAccounts(itemId: string): Promise<PluggyAccount[]>;
  listTransactions(
    accountId: string,
    options?: ListTransactionsOptions,
  ): Promise<PluggyTransaction[]>;
  listBills(accountId: string): Promise<PluggyBill[]>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function errorFromResponse(response: Response): Promise<PluggyError> {
  let code = String(response.status);
  let message = response.statusText || "request failed";
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // A non-JSON error body tells us nothing beyond the status we already have.
  }
  return new PluggyError(response.status, code, message);
}

export function createPluggyClient(options: PluggyClientOptions): PluggyClient {
  const baseUrl = (options.baseUrl ?? PLUGGY_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  let apiKey: string | null = null;
  let apiKeyExpiresAt = 0;

  async function authenticate(): Promise<string> {
    const response = await doFetch(`${baseUrl}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
      }),
    });
    if (!response.ok) throw await errorFromResponse(response);
    const parsed = parseAuthResponse(await response.json());
    apiKey = parsed.apiKey;
    apiKeyExpiresAt = now() + API_KEY_TTL_MS;
    return parsed.apiKey;
  }

  async function currentApiKey(): Promise<string> {
    if (apiKey && now() < apiKeyExpiresAt) return apiKey;
    return authenticate();
  }

  async function request<T>(path: string, parse: (payload: unknown) => T): Promise<T> {
    let lastError: PluggyError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await doFetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: { "X-API-KEY": await currentApiKey(), accept: "application/json" },
      });

      if (response.ok) return parse(await response.json());

      const error = await errorFromResponse(response);

      // A key that expired mid-run reads as 401/403. Re-authenticate once and
      // let the loop retry; a second failure is a real authorization problem.
      if ((error.status === 401 || error.status === 403) && attempt === 1) {
        apiKey = null;
        lastError = error;
        continue;
      }
      if (error.isPermanent) throw error;

      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 500);
    }

    throw lastError ?? new PluggyError(500, "unknown", "request failed");
  }

  return {
    async getItem(itemId) {
      return request(`/items/${encodeURIComponent(itemId)}`, parseItem);
    },

    async listAccounts(itemId) {
      return request(`/accounts?itemId=${encodeURIComponent(itemId)}`, (payload) =>
        parseResults(payload, "accounts", parseAccount),
      );
    },

    async listBills(accountId) {
      return request(`/bills?accountId=${encodeURIComponent(accountId)}`, (payload) =>
        parseResults(payload, "bills", parseBill),
      );
    },

    async listTransactions(accountId, listOptions = {}) {
      const params = new URLSearchParams({
        accountId,
        pageSize: String(TRANSACTIONS_PAGE_SIZE),
      });
      if (listOptions.from) params.set("from", listOptions.from);
      if (listOptions.to) params.set("to", listOptions.to);

      const collected: PluggyTransaction[] = [];
      const seenCursors = new Set<string>();
      let path = `/v2/transactions?${params.toString()}`;

      for (;;) {
        const page = await request(path, (payload) =>
          parseCursorPage(payload, "transactions", parseTransaction),
        );
        collected.push(...page.results);

        const next = page.next?.trim();
        // `next` comes back as a query string (`?accountId=…&after=…`). A cursor
        // we have already followed means the server is looping; stop rather than
        // paginate forever.
        if (!next || seenCursors.has(next)) break;
        seenCursors.add(next);
        path = next.startsWith("?") ? `/v2/transactions${next}` : next;
      }

      return collected;
    },
  };
}
