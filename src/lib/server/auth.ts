/**
 * Server-side session & authorization helpers.
 *
 * These helpers are the ONLY sanctioned gateway for authentication state on
 * the server. The role used for authorization ALWAYS comes from the
 * server-side session (Better Auth `user` table, written server-side with
 * `input: false`), never from anything the browser supplies.
 *
 * Safe for: Server Components, Server Actions and Route Handlers.
 * Note: `requireSession`/`requireRole` call Next's `redirect()`, which is
 * intended for render paths (layouts, pages, actions). In Route Handlers
 * prefer `getSession()` + `hasRole()` and return an explicit 40x response.
 */

import "server-only";

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { auth, USER_ROLES, type Session, type UserRole } from "../auth";

/** The current server-verified session, or null when unauthenticated. */
export async function getSession(): Promise<Session | null> {
  const sessionHeaders = await headers(); // async in Next.js 16
  return await auth.api.getSession({ headers: sessionHeaders });
}

/** Only allow app-internal paths as post-auth redirect targets. */
export const isSafeRedirectPath = (path: string): boolean =>
  path.startsWith("/") && !path.startsWith("//");

/**
 * Require an authenticated user.
 * `nextPath` (optional) is forwarded to /sign-in so the flow can return the
 * user to where they started. Unauthenticated visitors are redirected; this
 * throws a NEXT_REDIRECT control-flow error — never wrap it in try/catch.
 */
export async function requireSession(nextPath?: string): Promise<Session> {
  const session = await getSession();

  if (!session) {
    redirect(
      nextPath && isSafeRedirectPath(nextPath)
        ? `/sign-in?next=${encodeURIComponent(nextPath)}`
        : "/sign-in",
    );
  }

  return session;
}

/** Pure role predicate — no redirect side effects; ideal for Route Handlers. */
export function hasRole(
  session: Session,
  permittedRoles: ReadonlyArray<UserRole>,
): boolean {
  const role: unknown = session.user?.role;
  return (
    typeof role === "string" && (permittedRoles as readonly string[]).includes(role)
  );
}

/**
 * Require an authenticated user holding one of the permitted roles.
 * Unauthorized (but authenticated) users are redirected to a forbidden page
 * (customizable via `forbiddenRedirect`). The role is read exclusively from
 * the server-verified session — a client-supplied role is never trusted.
 */
export async function requireRole(
  permittedRoles: ReadonlyArray<UserRole>,
  optionalArgs?: { forbiddenRedirect?: string },
): Promise<Session> {
  const session = await requireSession();

  if (!hasRole(session, permittedRoles)) {
    redirect(optionalArgs?.forbiddenRedirect ?? "/forbidden");
  }

  return session;
}

/** Convenience guard: only DOCUMENTATION_MANAGER may act as approver. */
export async function requireManager(optionalArgs?: {
  forbiddenRedirect?: string;
}): Promise<Session> {
  return requireRole([USER_ROLES.DOCUMENTATION_MANAGER], optionalArgs);
}
