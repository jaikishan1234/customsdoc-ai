import type { Metadata } from "next";

import { requireSession } from "@/lib/server/auth";
import { formatRoleLabel } from "@/lib/role-display";

export const metadata: Metadata = {
  title: "Dashboard — CustomsDoc AI",
  description: "Your CustomsDoc AI documentation workspace overview.",
};

// The page reads the server session (request-time data) for the personal
// welcome message, so the segment intentionally blocks and renders
// per-request. See the (app) layout for the fuller explanation.
export const instant = false;

const placeholderCards = [
  {
    label: "Total shipments",
    note: "Placeholder — shipment tracking is not connected yet.",
  },
  {
    label: "Pending reviews",
    note: "Placeholder — field review workflow is not connected yet.",
  },
  {
    label: "Discrepancies",
    note: "Placeholder — cross-document checks are not connected yet.",
  },
] as const;

export default async function DashboardPage() {
  // Protected by the (app) layout; re-read here for the user's identity.
  const session = await requireSession();
  const displayName =
    session.user.name && session.user.name.trim().length > 0
      ? session.user.name.trim()
      : session.user.email;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Welcome back, {displayName}
          </h1>
          <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            {formatRoleLabel(session.user.role)}
          </span>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          CustomsDoc AI reviews invoices, packing lists and bills of lading
          with AI-assisted extraction, flags cross-document discrepancies and
          keeps your customs paperwork export-ready.
        </p>
      </header>

      <section
        aria-label="Overview"
        className="grid gap-4 sm:grid-cols-3"
      >
        {placeholderCards.map((card) => (
          <div
            key={card.label}
            className="flex flex-col gap-1 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {card.label}
            </h2>
            <p className="text-2xl font-semibold text-zinc-300 dark:text-zinc-700">
              —
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {card.note}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
