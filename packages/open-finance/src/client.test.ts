import { describe, expect, it } from "vitest";
import { createPluggyClient, PluggyError } from "./client";

interface Call {
  url: string;
  method: string;
  apiKey: string | null;
}

interface StubResponse {
  status?: number;
  body: unknown;
}

/**
 * A `fetch` stand-in that answers from a queue of scripted responses and records
 * every call, so pagination, authentication and retries can be asserted without
 * a network.
 */
function stubFetch(script: (call: Call, index: number) => StubResponse) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      apiKey: headers.get("X-API-KEY"),
    };
    calls.push(call);

    const { status = 200, body } = script(call, calls.length - 1);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch, overrides: { now?: () => number } = {}) {
  return createPluggyClient({
    clientId: "id",
    clientSecret: "secret",
    baseUrl: "https://api.test",
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
}

const ITEM = { id: "item-1", status: "UPDATED", lastUpdatedAt: "2026-03-10T09:00:00.000Z" };

describe("authentication", () => {
  it("exchanges the client credentials once and reuses the key", async () => {
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.endsWith("/auth") ? { body: { apiKey: "key-1" } } : { body: ITEM },
    );
    const pluggy = client(fetchImpl);

    await pluggy.getItem("item-1");
    await pluggy.getItem("item-1");

    expect(calls.filter((call) => call.url.endsWith("/auth"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes("/items/"))).toHaveLength(2);
    expect(calls.at(-1)?.apiKey).toBe("key-1");
  });

  it("re-authenticates once when the key expires mid-run", async () => {
    let issued = 0;
    const { fetchImpl, calls } = stubFetch((call) => {
      if (call.url.endsWith("/auth")) {
        issued += 1;
        return { body: { apiKey: `key-${issued}` } };
      }
      // The first data call is made with the stale key and is rejected.
      return call.apiKey === "key-1"
        ? { status: 401, body: { code: "expired", message: "API key expired" } }
        : { body: ITEM };
    });
    const pluggy = client(fetchImpl);

    await expect(pluggy.getItem("item-1")).resolves.toMatchObject({ id: "item-1" });
    expect(calls.filter((call) => call.url.endsWith("/auth"))).toHaveLength(2);
  });

  it("gives up when the credentials are genuinely wrong", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/auth")
        ? { body: { apiKey: "key-1" } }
        : { status: 403, body: { code: "forbidden", message: "no access" } },
    );

    await expect(client(fetchImpl).getItem("item-1")).rejects.toBeInstanceOf(PluggyError);
  });

  it("renews the key when its lifetime has elapsed", async () => {
    let clock = 0;
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.endsWith("/auth") ? { body: { apiKey: "key" } } : { body: ITEM },
    );
    const pluggy = client(fetchImpl, { now: () => clock });

    await pluggy.getItem("item-1");
    clock += 3 * 60 * 60 * 1000;
    await pluggy.getItem("item-1");

    expect(calls.filter((call) => call.url.endsWith("/auth"))).toHaveLength(2);
  });
});

describe("errors", () => {
  it("surfaces the Pluggy error code rather than a bare status", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/auth")
        ? { body: { apiKey: "key" } }
        : { status: 404, body: { code: "ITEM_NOT_FOUND", message: "not found" } },
    );

    await expect(client(fetchImpl).getItem("nope")).rejects.toMatchObject({
      status: 404,
      code: "ITEM_NOT_FOUND",
    });
  });

  it("retries a rate limit and succeeds", async () => {
    let dataCalls = 0;
    const { fetchImpl } = stubFetch((call) => {
      if (call.url.endsWith("/auth")) return { body: { apiKey: "key" } };
      dataCalls += 1;
      return dataCalls === 1
        ? { status: 429, body: { code: "RATE_LIMIT", message: "slow down" } }
        : { body: ITEM };
    });

    await expect(client(fetchImpl).getItem("item-1")).resolves.toMatchObject({ id: "item-1" });
    expect(dataCalls).toBe(2);
  });

  it("stops retrying a server error after three attempts", async () => {
    let dataCalls = 0;
    const { fetchImpl } = stubFetch((call) => {
      if (call.url.endsWith("/auth")) return { body: { apiKey: "key" } };
      dataCalls += 1;
      return { status: 502, body: { code: "BAD_GATEWAY", message: "upstream" } };
    });

    await expect(client(fetchImpl).getItem("item-1")).rejects.toMatchObject({ status: 502 });
    expect(dataCalls).toBe(3);
  });
});

describe("listAccounts and listBills", () => {
  it("unwraps the results array", async () => {
    const { fetchImpl, calls } = stubFetch((call) => {
      if (call.url.endsWith("/auth")) return { body: { apiKey: "key" } };
      if (call.url.includes("/accounts")) {
        return { body: { results: [{ id: "acc-1", type: "BANK", balance: 10 }], total: 1 } };
      }
      return { body: { results: [{ id: "bill-1", dueDate: "2026-03-15", totalAmount: 1 }] } };
    });
    const pluggy = client(fetchImpl);

    await expect(pluggy.listAccounts("item-1")).resolves.toHaveLength(1);
    await expect(pluggy.listBills("acc-1")).resolves.toHaveLength(1);
    expect(calls.some((call) => call.url.includes("/accounts?itemId=item-1"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/bills?accountId=acc-1"))).toBe(true);
  });
});

describe("listTransactions", () => {
  const row = (id: string) => ({
    id,
    accountId: "acc-1",
    amount: 1,
    date: "2026-03-10T00:00:00.000Z",
  });

  it("follows the cursor until the last page", async () => {
    const pages = [
      { results: [row("a"), row("b")], next: "?accountId=acc-1&after=CURSOR_1" },
      { results: [row("c")], next: null },
    ];
    let index = 0;
    const { fetchImpl, calls } = stubFetch((call) => {
      if (call.url.endsWith("/auth")) return { body: { apiKey: "key" } };
      return { body: pages[index++] };
    });

    const transactions = await client(fetchImpl).listTransactions("acc-1", {
      from: "2025-03-10",
      to: "2026-03-10",
    });

    expect(transactions.map((t) => t.id)).toEqual(["a", "b", "c"]);
    const dataCalls = calls.filter((call) => call.url.includes("/v2/transactions"));
    expect(dataCalls).toHaveLength(2);
    expect(dataCalls[0]!.url).toContain("from=2025-03-10");
    expect(dataCalls[0]!.url).toContain("pageSize=500");
    expect(dataCalls[1]!.url).toContain("after=CURSOR_1");
  });

  it("stops instead of looping when the server repeats a cursor", async () => {
    let dataCalls = 0;
    const { fetchImpl } = stubFetch((call) => {
      if (call.url.endsWith("/auth")) return { body: { apiKey: "key" } };
      dataCalls += 1;
      return { body: { results: [row(`r${dataCalls}`)], next: "?accountId=acc-1&after=SAME" } };
    });

    const transactions = await client(fetchImpl).listTransactions("acc-1");

    expect(dataCalls).toBe(2);
    expect(transactions).toHaveLength(2);
  });

  it("omits the date bounds when none are given", async () => {
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.endsWith("/auth")
        ? { body: { apiKey: "key" } }
        : { body: { results: [], next: null } },
    );

    await client(fetchImpl).listTransactions("acc-1");

    const dataCall = calls.find((call) => call.url.includes("/v2/transactions"))!;
    expect(dataCall.url).not.toContain("from=");
    expect(dataCall.url).not.toContain("to=");
  });
});
