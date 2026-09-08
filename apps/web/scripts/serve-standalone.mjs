/**
 * Serves the standalone production build.
 *
 * `next start` does not work with `output: "standalone"` — Next itself warns
 * and then serves an incomplete app. The standalone bundle is a self-contained
 * server that still needs the static assets copied next to it, exactly as the
 * Dockerfile does when it builds the runner image. This script performs that
 * same assembly locally so `pnpm start` matches production.
 */
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const webRoot = resolve(import.meta.dirname, "..");
const standalone = resolve(webRoot, ".next/standalone/apps/web");
const server = resolve(standalone, "server.js");

if (!existsSync(server)) {
  console.error("No standalone build found. Run `pnpm build` first.");
  process.exit(1);
}

// Static assets are not part of the traced bundle; they are copied in.
cpSync(resolve(webRoot, ".next/static"), resolve(standalone, ".next/static"), { recursive: true });
if (existsSync(resolve(webRoot, "public"))) {
  cpSync(resolve(webRoot, "public"), resolve(standalone, "public"), { recursive: true });
}

try {
  process.loadEnvFile(resolve(webRoot, "../../.env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

// The standalone server resolves its own paths from the process working
// directory, so it must be started from the bundle root.
process.chdir(resolve(webRoot, ".next/standalone"));
process.env.PORT ??= "3000";
process.env.HOSTNAME ??= "127.0.0.1";

await import(pathToFileURL(server).href);
