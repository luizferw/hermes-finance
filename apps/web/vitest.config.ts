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
      // Pinned so assertions on formatted output do not depend on whatever
      // locale the developer happens to have in their .env.
      NEXT_PUBLIC_KOSH_LOCALE: "en-IN",
      // Same reason: the root .env is loaded before vitest starts, so a
      // developer with working Pluggy credentials would otherwise see different
      // results from CI, and a test could reach a real third party.
      PLUGGY_ENABLED: "false",
      PLUGGY_CLIENT_ID: "",
      PLUGGY_CLIENT_SECRET: "",
    },
  },
  resolve: {
    alias: {
      "server-only": resolve(__dirname, "test/stubs/server-only.ts"),
      "@": resolve(__dirname, "."),
    },
  },
});
