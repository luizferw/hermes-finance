import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Tight, app-compatible CSP. script/style need 'unsafe-inline' because Next
// emits inline hydration scripts and components use inline styles without a
// nonce. nonce-based strict CSP via middleware is the upgrade path if
// the XSS surface grows. Everything else is locked to same-origin.
// Dev only: Turbopack/React need 'unsafe-eval' for HMR and debug tooling; it is
// never added in production.
const isDev = process.env.NODE_ENV !== "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Pluggy Connect runs on our origin: its script comes from cdn.pluggy.ai and it
 * opens an iframe on connect.pluggy.ai, where the user talks to their bank.
 *
 * Widening the policy is unavoidable to embed it, so it is widened on that one
 * route only. The transactions page has no reason to accept third-party script,
 * and a CSP relaxed everywhere to suit one settings screen is how a tight policy
 * quietly stops being one.
 */
const openFinanceCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://cdn.pluggy.ai${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://api.pluggy.ai",
  "frame-src https://connect.pluggy.ai",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@kosh/db", "@kosh/domain"],
  serverExternalPackages: ["pg", "pg-boss"],
  output: "standalone",
  // Pin the monorepo root. Without this Next infers it by walking up looking
  // for a lockfile, so an unrelated lockfile in a parent directory silently
  // changes the standalone output layout and breaks `node apps/web/server.js`.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  async headers() {
    // The two rules must not overlap. A browser given two CSP headers enforces
    // the intersection, so a catch-all matching this route too would re-impose
    // the strict policy and silently block the widget.
    return [
      {
        source: "/((?!settings/open-finance).*)",
        headers: securityHeaders,
      },
      {
        source: "/settings/open-finance",
        headers: [
          { key: "Content-Security-Policy", value: openFinanceCsp },
          ...securityHeaders.filter((header) => header.key !== "Content-Security-Policy"),
        ],
      },
    ];
  },
};

export default nextConfig;
