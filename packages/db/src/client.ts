import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import * as relations from "./relations";

const fullSchema = { ...schema, ...relations };

export type Database = NodePgDatabase<typeof fullSchema>;

declare global {
  var __koshDb: { pool: Pool; db: Database } | undefined;
}

function createClient(): { pool: Pool; db: Database } {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and configure it.",
    );
  }
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema: fullSchema, casing: "snake_case" });
  return { pool, db };
}

/**
 * Singleton pool/client. Cached on globalThis so Next.js dev-mode hot reload
 * doesn't leak connections.
 */
function getClient(): { pool: Pool; db: Database } {
  if (!globalThis.__koshDb) {
    globalThis.__koshDb = createClient();
  }
  return globalThis.__koshDb;
}

export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    return getClient().db[prop as keyof Database];
  },
});

export function getPool(): Pool {
  return getClient().pool;
}
