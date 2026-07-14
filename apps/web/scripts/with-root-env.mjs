import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

try {
  process.loadEnvFile(resolve(process.cwd(), "../../.env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const target = resolve(process.cwd(), process.argv[2]);
process.argv = [process.execPath, target, ...process.argv.slice(3)];
await import(pathToFileURL(target).href);
