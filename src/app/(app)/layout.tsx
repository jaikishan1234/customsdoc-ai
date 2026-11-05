/**
 * Protected application layout.
 *
 * Single authentication mechanism: every request through this layout is
 * gated by the existing server-side requireSession() helper from
 * src/lib/server/auth.ts (which validates the session server-side via
 * Better Auth and redirects unauthenticated visitors to /sign-in). No
 * client-side session state is consulted for protection.
 */

import { UserNavigation } from "@/components/user-navigation";
import { requireSession } from "@/lib/server/auth";

// The layout reads the server session (request-time data) before rendering,
// so this route subtree intentionally serves a dynamic (blocking) shell.
// `instant = false` opts the segment out of instant-navigation validation
// while Cache Components stay enabled globally.
export const instant = false;

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await requireSession();

  return (
    <div className="flex flex-1 flex-col font-sans">
      <UserNavigation
        product="CustomsDoc AI"
        userName={session.user.name}
        userEmail={session.user.email}
        role={session.user.role}
      />
      <main className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
        {children}
      </main>
    </div>
  );
}
