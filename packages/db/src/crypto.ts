import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-level encryption for the handful of sensitive, display-only
 * columns that never participate in SQL filters (UPI ids, account masks, free
 * text notes, bank references). Used by the `encryptedText` Drizzle column type
 * so encryption is transparent to every query.
 *
 * Algorithm: AES-256-GCM. Stored format: `enc:v1:base64(iv[12] | tag[16] | ct)`.
 *
 * Keying: `KOSH_ENCRYPTION_KEY` is a base64-encoded 32-byte key
 * (`openssl rand -base64 32`). When it is **unset**, encryption is disabled and
 * values are stored as plaintext — this keeps development and existing
 * deployments working. Legacy plaintext rows always remain readable, so the
 * key can be introduced on a live database (run `pnpm db:encrypt` to backfill).
 */

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null | undefined;

function key(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.KOSH_ENCRYPTION_KEY?.trim();
  if (!raw) {
    cachedKey = null;
    return null;
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "KOSH_ENCRYPTION_KEY must decode to 32 bytes — generate one with `openssl rand -base64 32`.",
    );
  }
  cachedKey = buf;
  return buf;
}

/** True when a stored value is in the encrypted envelope format. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Whether encryption is active (a valid key is configured). */
export function encryptionEnabled(): boolean {
  return key() !== null;
}

export function encryptSecret(plaintext: string): string {
  const k = key();
  if (!k) return plaintext; // encryption disabled
  if (isEncrypted(plaintext)) return plaintext; // already encrypted — don't double-wrap
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value; // legacy plaintext passthrough
  const k = key();
  if (!k) {
    throw new Error(
      "Found encrypted data but KOSH_ENCRYPTION_KEY is not set. Restore the key to read this database.",
    );
  }
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
