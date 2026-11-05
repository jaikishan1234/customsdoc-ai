import type { Metadata } from "next";
import Link from "next/link";

import { countShipments } from "@/lib/services/shipment-service";
import { requireSession } from "@/lib/server/auth";
import { formatRoleLabel } from "@/lib/role-display";

export const metadata: Metadata = {
  title: "Dashboard — CustomsDoc AI",
  description: "Your CustomsDoc AI documentation workspace overview.",
};

// The page reads the server session and a live database count (request-time
// data), so the segment intentionally blocks and renders per-request. See the
// (app) layout for the fuller explanation.
export const instant = false;

export default async function DashboardPage() {
  // Protected by the (app) layout; re-read here for the user's identity.
  const session = await requireSession();
  const displayName =
    session.user.name && session.user.name.trim().length > 0
      ? session.user.name.trim()
      : session.user.email;

  // Real server-side count for shipments; the other two statistics have no
  // backing workflow yet and stay as clearly-labelled placeholders.
  const shipmentsCount = await countShipments();

  const overviewCards = [
    {
      key: "total-shipments",
      label: "Total shipments",
      value:
        shipmentsCount.status === "success" ? shipmentsCount.total : "—",
      note:
        shipmentsCount.status === "success"
          ? "Live count from your shipments."
          : "Counter temporarily unavailable — not a recorded value.",
      dimmed: false,
    },
    {
      key: "pending-reviews",
      label: "Pending reviews",
      value: "—",
      dimmed: true,
      note: "Placeholder — field review workflow is not connected yet.",
    },
    {
      key: "discrepancies",
      label: "Discrepancies",
      value: "—",
      dimmed: true,
      note: "Placeholder — cross-document checks are not connected yet.",
    },
    ] as const;

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

      <nav aria-label="Quick actions" className="flex flex-wrap items-center gap-3">
        <Link
          href="/shipments/new"
          className="inline-flex h-10 items-center justify-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          New shipment
        </Link>
        <Link
          href="/shipments"
          className="inline-flex h-10 items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:bg-zinc-900"
        >
          View shipments
        </Link>
      </nav>

      <section
        aria-label="Overview"
        className="grid gap-4 sm:grid-cols-3"
      >
        {overviewCards.map((card) => (
          <div
            key={card.key}
            className="flex flex-col gap-1 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {card.label}
            </h2>
            <p
              className={
                card.dimmed
                  ? "text-2xl font-semibold text-zinc-300 dark:text-zinc-700"
                  : "text-2xl font-semibold text-zinc-900 dark:text-zinc-100"
              }
            >
              {card.value}
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
