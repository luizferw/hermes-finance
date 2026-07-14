import { beforeEach, describe, expect, it, vi } from "vitest";

const key = Buffer.alloc(32, 9).toString("base64");

async function cryptoModule() {
  vi.resetModules();
  return import("@kosh/db");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("KOSH_ENCRYPTION_KEY", key);
});

describe("column encryption", () => {
  it("round-trips encrypted fields and rejects tampering", async () => {
    const { encryptSecret, decryptSecret, isEncrypted } = await cryptoModule();
    const encrypted = encryptSecret("upi:merchant@bank");
    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted).not.toContain("merchant@bank");
    expect(decryptSecret(encrypted)).toBe("upi:merchant@bank");

    const tampered = encrypted.slice(0, -1) + (encrypted.endsWith("A") ? "B" : "A");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
