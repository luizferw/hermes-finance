import "server-only";
import {
  createPluggyClient,
  type NormalizeContext,
  type PluggyClient,
} from "@hermes-finance/open-finance";
import { minorUnitExponent } from "@kosh/domain";
import { env } from "@/lib/env";

/**
 * The Pluggy client, built from the deployment's credentials.
 *
 * Memoized on `globalThis` so the two-hour API key is shared between the job
 * worker and request handlers instead of being re-issued on every call, and so
 * Next's dev-mode module reloading does not quietly leak a new client per
 * reload. Returns null when the integration is switched off, which is how every
 * caller decides whether there is anything to do.
 */
const CLIENT_KEY = "__hermesPluggyClient";

type ClientHolder = typeof globalThis & { [CLIENT_KEY]?: PluggyClient };

export function getPluggyClient(): PluggyClient | null {
  const config = env();
  if (!config.PLUGGY_ENABLED) return null;
  if (!config.PLUGGY_CLIENT_ID || !config.PLUGGY_CLIENT_SECRET) return null;

  const holder = globalThis as ClientHolder;
  if (!holder[CLIENT_KEY]) {
    holder[CLIENT_KEY] = createPluggyClient({
      clientId: config.PLUGGY_CLIENT_ID,
      clientSecret: config.PLUGGY_CLIENT_SECRET,
      baseUrl: config.PLUGGY_BASE_URL,
    });
  }
  return holder[CLIENT_KEY];
}

/**
 * The context the pure normalizers need.
 *
 * `minorUnitExponent` is passed in from `@kosh/domain` rather than duplicated in
 * the integration package, so there is exactly one table deciding how many
 * decimal places a currency has.
 */
export function normalizeContext(): NormalizeContext {
  return {
    minorUnitExponent,
    defaultCurrencyCode: "BRL",
    utcOffsetMinutes: env().PLUGGY_TIMEZONE_OFFSET_MINUTES,
  };
}
