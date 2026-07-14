import { customType, timestamp } from "drizzle-orm/pg-core";
import { decryptSecret, encryptSecret } from "../crypto";

/**
 * A `text` column whose value is transparently encrypted at rest (AES-256-GCM)
 * when `KOSH_ENCRYPTION_KEY` is configured. The on-disk type is plain `text`,
 * so switching a column to this requires no migration. Drizzle skips these
 * mappers for NULL, so nullable columns are unaffected when empty.
 *
 * Only use this for sensitive columns that are never filtered/sorted in SQL —
 * ciphertext is non-deterministic and not searchable.
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value) {
    return encryptSecret(value);
  },
  fromDriver(value) {
    return decryptSecret(value);
  },
});

/** created_at / updated_at pair used by every mutable table. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};
