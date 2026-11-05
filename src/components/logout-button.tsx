"use client";

/**
 * Reusable logout button.
 *
 * Behavior: calls Better Auth's server-side sign-out (invalidating the
 * session server-side), then redirects to /sign-in and refreshes the router
 * so no stale authenticated UI is retained.
 *
 * Security: session/cookie handling is entirely Better Auth's; this component
 * never inspects or manipulates cookies, tokens or headers, and never logs
 * credentials, session tokens or secrets. Client state is used for the
 * loading indicator only — never for authorization.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { authClient } from "@/lib/auth-client";

export function LogoutButton({
  className,
  disabled = false,
}: {
  className?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    if (isSigningOut) return; // guard against duplicate submissions

    setError(null);
    setIsSigningOut(true);
    try {
      const response = await authClient.signOut();

      if (response?.error) {
        // Generic, non-sensitive messaging — the server error detail is not
        // rendered (it never contains credentials, but staying generic
        // avoids leaking anything about the auth flow).
        setError("Sign out failed. Please try again.");
        return;
      }

      // Token invalidated server-side; drop all cached authenticated UI.
      router.replace("/sign-in");
      router.refresh();
    } catch {
      setError("Sign out failed. Please try again.");
    } finally {
      setIsSigningOut(false);
    }
  };

  const baseClasses =
    "inline-flex h-8 items-center justify-center rounded-full border border-zinc-300 px-3 text-xs font-medium text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:bg-zinc-900";

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleSignOut}
        disabled={isSigningOut || disabled}
        className={className ?? baseClasses}
        aria-busy={isSigningOut}
      >
        {isSigningOut ? "Signing out…" : "Sign out"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}
