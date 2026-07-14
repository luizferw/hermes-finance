import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (process.env.NODE_ENV === "production" && !databaseUrl) {
  throw new Error("DATABASE_URL is required for production migrations.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema/index.ts",
  out: process.env.KOSH_MIGRATIONS_DIR ?? "./packages/db/migrations",
  dbCredentials: {
    url: databaseUrl ?? "postgres://kosh:kosh@localhost:5432/kosh",
  },
  verbose: true,
  strict: true,
});
