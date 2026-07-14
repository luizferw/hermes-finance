import { z } from "zod";

const isProductionBuild =
  process.env.NEXT_PHASE === "phase-production-build";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .default("postgres://kosh:kosh@localhost:5432/kosh"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(16, "BETTER_AUTH_SECRET must be at least 16 characters"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  KOSH_STORAGE_DIR: z.string().optional(),
  // Optional AES-256-GCM key (base64, 32 bytes) enabling column encryption for
  // sensitive fields. Validated here so a malformed key fails fast at boot.
  KOSH_ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v.trim() === "" || Buffer.from(v, "base64").length === 32,
      "KOSH_ENCRYPTION_KEY must decode to 32 bytes (openssl rand -base64 32).",
    ),
  KOSH_DISABLE_JOBS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // ── AI / agent ──────────────────────────────────────────────────────────
  // Kosh runs fully without any of these; absent key ⇒ deterministic fallback.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  KOSH_AI_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  KOSH_MCP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  KOSH_MCP_BASE_URL: z.string().optional(),
  /** Secret for signing confirmation payloads + (optionally) MCP. Falls back to
   * BETTER_AUTH_SECRET when unset. */
  KOSH_MCP_AUTH_SECRET: z.string().optional(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
}).superRefine((cfg, ctx) => {
  // Never let a real deployment run on the example/placeholder secret.
  const placeholders = ["change-me-to-a-long-random-string", "change-me"];
  if (cfg.NODE_ENV !== "production" || isProductionBuild) return;

  if (!process.env.DATABASE_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "DATABASE_URL must be set explicitly in production.",
    });
  }
  if (cfg.DATABASE_URL.includes("kosh:kosh@")) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "Refusing the default database credentials in production.",
    });
  }
  const appUrl = new URL(cfg.APP_URL);
  const loopbackAppUrl = ["localhost", "127.0.0.1", "::1"].includes(
    appUrl.hostname,
  );
  if (appUrl.protocol !== "https:" && !loopbackAppUrl) {
    ctx.addIssue({
      code: "custom",
      path: ["APP_URL"],
      message: "APP_URL must use HTTPS in production unless it is loopback-only.",
    });
  }
  if (placeholders.includes(cfg.BETTER_AUTH_SECRET) || cfg.BETTER_AUTH_SECRET.length < 32) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_SECRET"],
      message:
        "Refusing to start in production with a weak/default secret. " +
        "Set BETTER_AUTH_SECRET to a unique value (openssl rand -base64 32).",
    });
  }
  if (!cfg.KOSH_ENCRYPTION_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["KOSH_ENCRYPTION_KEY"],
      message:
        "KOSH_ENCRYPTION_KEY is required in production. Back it up separately; losing it loses encrypted fields.",
    });
  }
  if (cfg.KOSH_AI_ENABLED && !cfg.GEMINI_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["GEMINI_API_KEY"],
      message: "GEMINI_API_KEY is required when KOSH_AI_ENABLED=true.",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated environment. Throws a readable error on first access if misconfigured. */
export function env(): Env {
  if (!cached) {
    const source =
      isProductionBuild && !process.env.BETTER_AUTH_SECRET
        ? {
            ...process.env,
            DATABASE_URL:
              process.env.DATABASE_URL ||
              "postgres://build:build@localhost:5432/build",
            BETTER_AUTH_SECRET: "build-only-secret-not-used-at-runtime",
          }
        : process.env;
    const parsed = envSchema.safeParse(source);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
