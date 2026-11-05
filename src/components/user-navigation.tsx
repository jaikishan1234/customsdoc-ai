/**
 * Minimal authenticated application navigation/header.
 *
 * Usage (inside the protected (app) layout, after requireSession()):
 *   <UserNavigation
 *     product="CustomsDoc AI"
 *     userName={session.user.name}
 *     userEmail={session.user.email}
 *     role={session.user.role}
 *   />
 *
 * The user identity and role passed here MUST come from the server-verified
 * session (src/lib/server/auth.ts) — this component renders whatever it is
 * given for DISPLAY only. It performs no client-side authorization and never
 * gates UI on role state: role-based access control stays entirely in the
 * server-side helpers (requireRole / requireManager) and route-handler guards.
 */

import Link from "next/link";

import { LogoutButton } from "./logout-button";
import { formatRoleLabel } from "@/lib/role-display";

export function UserNavigation({
  userName,
  userEmail,
  role,
  product,
}: {
  /** User's display name from the server session; falls back to email. */
  userName: string | null | undefined;
  /** User's email from the server session (always present). */
  userEmail: string;
  /** User's role from the server session (display only). */
  role?: string | null;
  /** Product name shown on the left side of the header. */
  product?: string;
}) {
  const label = userName && userName.trim().length > 0 ? userName : userEmail;
  const roleLabel = role ? formatRoleLabel(role) : null;

  return (
    <nav
      aria-label="Application"
      className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950 sm:px-6"
    >
      <div className="flex items-center gap-1">
        {product && (
          <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {product}
          </span>
        )}
        {/* Display-only entry point to the (already server-protected)
            shipments pages — never an authorization boundary itself. */}
        <Link
          href="/shipments"
          className="rounded-full px-2 py-1 text-sm text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
        >
          Shipments
        </Link>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm text-zinc-600 dark:text-zinc-300">
          <span className="sr-only sm:not-sr-only">Signed in as </span>
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {label}
          </span>
        </span>
        {roleLabel && (
          <span className="hidden whitespace-nowrap rounded-full border border-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-500 md:inline dark:border-zinc-700 dark:text-zinc-400">
            {roleLabel}
          </span>
        )}
        <LogoutButton />
      </div>
    </nav>
  );
}
