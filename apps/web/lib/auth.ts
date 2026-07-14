import "server-only";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db, users, sessions, authAccounts, verifications } from "@kosh/db";
import { env } from "./env";

export const auth = betterAuth({
  baseURL: env().APP_URL,
  secret: env().BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: authAccounts,
      verification: verifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  // better-auth enables rate limiting in production by default (off in dev, so
  // tests/scripts aren't throttled). Tighten the credential endpoints against
  // brute force. in-memory store is fine for a single instance; use
  // database storage if Kosh is ever run multi-replica.
  rateLimit: {
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
    },
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
  },
  advanced: {
    database: {
      generateId: () => randomUUID(),
    },
  },
  // nextCookies must stay last so set-cookie headers propagate from
  // server actions.
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
