/**
 * Minimal authenticated navigation bar for the future application layout.
 *
 * Usage (inside a server component, after requireSession()):
 *   <UserNavigation userName={session.user.name} userEmail={session.user.email} />
 *
 * The user identity passed here MUST come from the server-verified session
 * (src/lib/server/auth.ts) — this component renders whatever it is given for
 * display only. It performs no client-side authorization and never gates UI
 * on role state: role-based access control stays entirely in the server-side
 * helpers (requireRole / requireManager) and route-handler guards.
 */

import { LogoutButton } from "./logout-button";

export function UserNavigation({
  userName,
  userEmail,
}: {
  /** User's display name from the server session; falls back to email. */
  userName: string | null | undefined;
  /** User's email from the server session (always present). */
  userEmail: string;
}) {
  const label = userName && userName.trim().length > 0 ? userName : userEmail;

  return (
    <nav
      aria-label="Account"
      className="flex w-full items-center justify-between gap-4 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800"
    >
      <span className="truncate text-sm text-zinc-600 dark:text-zinc-300">
        Signed in as{" "}
        <span className="font-medium text-zinc-900 dark:text-zinc-100">
          {label}
        </span>
      </span>
      <LogoutButton />
    </nav>
  );
}
