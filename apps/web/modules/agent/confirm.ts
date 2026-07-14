import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Confirmation payloads are frozen server-side and signed so the browser cannot
 * tamper with what it later asks us to execute. The signature binds the tool,
 * the exact concrete payload, the authenticated user, and the idempotency key
 * together — change any one and verification fails.
 */
function secret(): string {
  const e = env();
  return e.KOSH_MCP_AUTH_SECRET || e.BETTER_AUTH_SECRET;
}

interface SealInput {
  toolName: string;
  payload: unknown;
  userId: string;
  idempotencyKey: string;
}

/** Stable JSON — sorted keys — so signing is order-independent. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function signProposal(input: SealInput): string {
  return createHmac("sha256", secret())
    .update(canonical(input))
    .digest("hex");
}

export function verifyProposal(input: SealInput, signature: string): boolean {
  const expected = signProposal(input);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function newIdempotencyKey(): string {
  return randomUUID();
}
