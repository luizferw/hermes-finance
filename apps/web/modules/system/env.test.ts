import { beforeEach, describe, expect, it, vi } from "vitest";

const strongKey = Buffer.alloc(32, 7).toString("base64");

async function loadEnv() {
  vi.resetModules();
  return import("@/lib/env");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("DATABASE_URL", "postgres://kosh:strong-password@db:5432/kosh");
  vi.stubEnv("APP_URL", "https://kosh.example.test");
  vi.stubEnv("BETTER_AUTH_SECRET", "0123456789abcdef0123456789abcdef");
  vi.stubEnv("KOSH_ENCRYPTION_KEY", strongKey);
  vi.stubEnv("KOSH_AI_ENABLED", "false");
  vi.stubEnv("KOSH_MCP_ENABLED", "false");
  vi.stubEnv("PLUGGY_ENABLED", "false");
  vi.stubEnv("PLUGGY_CLIENT_ID", "");
  vi.stubEnv("PLUGGY_CLIENT_SECRET", "");
  vi.stubEnv("NODE_ENV", "production");
});

describe("production env validation", () => {
  it("refuses the placeholder auth secret", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "change-me-to-a-long-random-string");
    const { env } = await loadEnv();
    expect(() => env()).toThrow(/weak\/default secret/);
  });

  it("refuses production boot without the encryption key", async () => {
    vi.stubEnv("KOSH_ENCRYPTION_KEY", "");
    const { env } = await loadEnv();
    expect(() => env()).toThrow(/KOSH_ENCRYPTION_KEY is required/);
  });

  it("accepts a fully configured production environment", async () => {
    vi.stubEnv("APP_URL", "https://kosh.example.com");
    const { env } = await loadEnv();
    expect(env().APP_URL).toBe("https://kosh.example.com");
  });

  it("accepts loopback HTTP for local Docker deployments", async () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const { env } = await loadEnv();
    expect(env().APP_URL).toBe("http://localhost:3000");
  });

  it("refuses non-loopback production HTTP", async () => {
    vi.stubEnv("APP_URL", "http://kosh.example.com");
    const { env } = await loadEnv();
    expect(() => env()).toThrow(/must use HTTPS/);
  });

  it("does not require runtime secrets while Next builds", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("KOSH_ENCRYPTION_KEY", "");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const { env } = await loadEnv();
    expect(env().BETTER_AUTH_SECRET).toMatch(/^build-only/);
  });
});

describe("Open Finance configuration", () => {
  it("refuses to enable Pluggy without credentials, even outside production", async () => {
    // Deliberately not gated on NODE_ENV: a half-configured integration fails in
    // development too, as an opaque 401 from a third party.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PLUGGY_ENABLED", "true");
    const { env } = await loadEnv();
    expect(() => env()).toThrow(/PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET are required/);
  });

  it("accepts Pluggy once both credentials are present", async () => {
    vi.stubEnv("PLUGGY_ENABLED", "true");
    vi.stubEnv("PLUGGY_CLIENT_ID", "client-id");
    vi.stubEnv("PLUGGY_CLIENT_SECRET", "client-secret");
    const { env } = await loadEnv();
    expect(env().PLUGGY_ENABLED).toBe(true);
    expect(env().PLUGGY_BASE_URL).toBe("https://api.pluggy.ai");
  });

  it("leaves Pluggy off and unvalidated by default", async () => {
    const { env } = await loadEnv();
    expect(env().PLUGGY_ENABLED).toBe(false);
    expect(env().PLUGGY_TIMEZONE_OFFSET_MINUTES).toBe(-180);
    expect(env().PLUGGY_BACKFILL_DAYS).toBe(365);
  });
});
