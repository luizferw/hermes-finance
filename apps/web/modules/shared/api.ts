import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getApiUser, type CurrentUser } from "@/lib/session";
import { env } from "@/lib/env";

/**
 * Consistent API envelope:
 *   200: { data: ... }
 *   4xx/5xx: { error: { code, message, details? } }
 */

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, init);
}

export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (
  req: Request,
  ctx: { user: CurrentUser; params: Record<string, string> },
) => Promise<Response>;

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// per-process limiter is enough for a one-box self-hosted app; move
// to Postgres/Redis if Kosh is deployed with multiple web replicas.
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, userId: string): NextResponse | null {
  if (!unsafeMethods.has(req.method)) return null;
  const path = new URL(req.url).pathname;
  const bucket = path.startsWith("/api/imports")
    ? "imports"
    : path.startsWith("/api/agent")
      ? "agent"
      : "write";
  const limit = bucket === "write" ? 60 : 20;
  const now = Date.now();
  const key = `${userId}:${bucket}`;
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + 60_000 });
    return null;
  }
  entry.count += 1;
  if (entry.count > limit) {
    return fail(429, "rate_limited", "Too many requests. Try again shortly.");
  }
  return null;
}

function assertSameOrigin(req: Request): NextResponse | null {
  if (!unsafeMethods.has(req.method)) return null;
  const origin = req.headers.get("origin");
  if (!origin) return fail(403, "csrf_blocked", "Missing request origin.");
  if (origin !== new URL(env().APP_URL).origin) {
    return fail(403, "csrf_blocked", "Request origin is not allowed.");
  }
  return null;
}

/**
 * Wraps a route handler with auth + error mapping. Zod errors become 422,
 * ApiErrors keep their status, anything else is a sanitized 500.
 */
export function withUser(handler: Handler) {
  return async (
    req: Request,
    routeCtx?: { params?: Promise<Record<string, string>> },
  ): Promise<Response> => {
    const user = await getApiUser();
    if (!user) {
      return fail(401, "unauthorized", "Sign in to use the API.");
    }
    const csrf = assertSameOrigin(req);
    if (csrf) return csrf;
    const limited = rateLimit(req, user.id);
    if (limited) return limited;
    try {
      const params = routeCtx?.params ? await routeCtx.params : {};
      return await handler(req, { user, params });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return fail(422, "validation_error", "Invalid request.", err.issues);
      }
      if (err instanceof ApiError) {
        return fail(err.status, err.code, err.message);
      }
      console.error(
        `API error on ${req.method} ${new URL(req.url).pathname}:`,
        err instanceof Error ? err.name : "unknown",
      );
      return fail(500, "internal_error", "Something went wrong on the server.");
    }
  };
}

/** Parse a JSON body against a schema (throws ZodError → 422). */
export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  return schema.parse(raw);
}

/** Parse URL search params against a schema. */
export function parseQuery<T>(req: Request, schema: z.ZodType<T>): T {
  const url = new URL(req.url);
  return schema.parse(Object.fromEntries(url.searchParams));
}
