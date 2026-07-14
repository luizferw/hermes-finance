import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

/** Session lookup, deduped per request. */
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
}

/**
 * The guard used by every (app) page and API route. Redirects to /login
 * when unauthenticated.
 */
export async function requireUser(): Promise<CurrentUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  };
}

/** API-route variant: returns null instead of redirecting. */
export async function getApiUser(): Promise<CurrentUser | null> {
  const session = await getSession();
  if (!session) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  };
}
