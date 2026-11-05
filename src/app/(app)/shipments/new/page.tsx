import type { Metadata } from "next";
import Link from "next/link";

import { ShipmentCreateForm } from "./shipment-create-form";

export const metadata: Metadata = {
  title: "New shipment — CustomsDoc AI",
  description: "Register a new shipment in CustomsDoc AI.",
};

// The authenticated wall for this route is the protected (app) layout
// (requireSession there). This page itself renders only static markup.
export default function NewShipmentPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <nav aria-label="Breadcrumb" className="text-xs text-zinc-500 dark:text-zinc-400">
          <Link
            href="/"
            className="transition hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            Dashboard
          </Link>
          <span aria-hidden className="px-1">
            /
          </span>
          <span aria-current="page" className="font-medium text-zinc-700 dark:text-zinc-300">
            New shipment
          </span>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          New shipment
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Register a shipment to start collecting its customs documents,
          extraction results and review history.
        </p>
      </header>

      <section
        aria-label="Registration form"
        className="flex flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
      >
        {/* Client form: field-level errors, loading state, duplicate-submit
            guard, and the server action integration. */}
        <ShipmentCreateForm />
      </section>
    </div>
  );
}
