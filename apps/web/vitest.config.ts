import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["modules/**/*.test.{ts,tsx}"],
    env: {
      BETTER_AUTH_SECRET: "test-secret-0123456789abcdef-please",
      KOSH_AI_ENABLED: "false",
      KOSH_MCP_ENABLED: "true",
    },
  },
  resolve: {
    alias: {
      "server-only": resolve(__dirname, "test/stubs/server-only.ts"),
      "@": resolve(__dirname, "."),
    },
  },
});
