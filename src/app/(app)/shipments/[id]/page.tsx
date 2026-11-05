import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ShipmentStatusBadge } from "@/components/shipment-status-badge";
import { formatLongDateTimeUtc } from "@/lib/date-display";
import { getShipmentById } from "@/lib/services/shipment-service";
import { requireSession } from "@/lib/server/auth";
import type { Shipment } from "@/lib/db/schema";

export const metadata: Metadata = {
  title: "Shipment — CustomsDoc AI",
  description: "Shipment detail, lifecycle state and audit history.",
};

// Reads the server session and live database rows per request, so the
// segment intentionally blocks; Cache Components stay enabled globally.
export const instant = false;

type Params = Promise<{ id: string }>;

const panelClasses =
  "flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950";
const labelClasses =
  "block text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const monoValueClasses =
  "mt-1 break-all font-mono text-xs text-zinc-800 dark:text-zinc-200";

const placeholderSections = [
  {
    key: "documents",
    title: "Documents & uploads",
    note: "Versioned invoice, packing list and bill of lading uploads with checksums.",
  },
  {
    key: "extraction",
    title: "AI extraction & cross-document validation",
    note: "Field extraction with confidence plus cross-document discrepancy checks.",
  },
  {
    key: "approval",
    title: "Approval & export",
    note: "Manager approval decisions and export-ready CSV stamping.",
  },
] as const;

/**
 * The read-only facts shown on the detail page, mapped directly from the
 * schema's real column types (uuid/text/timestamptz) — no guessed columns.
 */
const factList = (shipment: Shipment) =>
  [
    {
      label: "Description",
      value: shipment.description ?? "—",
      fullWidth: true,
      mono: false,
    },
    {
      label: "Notes",
      value: shipment.notes ?? "—",
      fullWidth: true,
      mono: false,
    },
    {
      label: "Created",
      value: formatLongDateTimeUtc(shipment.createdAt, "UTC"),
      fullWidth: false,
      mono: false,
    },
    {
      label: "Updated",
      value: formatLongDateTimeUtc(shipment.updatedAt, "UTC"),
      fullWidth: false,
      mono: false,
    },
    {
      label: "Created by (user ID)",
      value: shipment.createdBy,
      fullWidth: false,
      mono: true,
    },
    {
      label: "Assigned to (user ID)",
      value: shipment.assignedTo ?? "Not assigned",
      fullWidth: false,
      // Mono styling only when there IS a real id to render.
      mono: Boolean(shipment.assignedTo),
    },
    {
      label: "Exported at",
      value: shipment.exportedAt
        ? formatLongDateTimeUtc(shipment.exportedAt, "UTC")
        : "Not exported yet",
      fullWidth: false,
      mono: Boolean(shipment.exportedAt),
    },
    {
      label: "Exported by (user ID)",
      value: shipment.exportedBy ?? "—",
      fullWidth: false,
      mono: Boolean(shipment.exportedBy),
    },
  ] as const;

/**
 * Render a JSONB details payload defensively: plain-object payloads render as
 * `key: value` rows; anything else (primitives) renders as its string form,
 * truncated and always escaped by React. These payloads never contain secrets
 * in the current design, but rendering stays minimal and bounded regardless.
 */
function formatDetailValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value) ?? "";
    return json.length > 160 ? `${json.slice(0, 160)}…` : json;
  } catch {
    return "";
  }
}

const detailEntries = (
  details: unknown,
): Array<[string, unknown]> | null => {
  if (
    details === null ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    return null;
  }
  return Object.entries(details as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
};

function DetailPayload({ details }: { details: unknown }) {
  const entries = detailEntries(details);

  if (entries !== null && entries.length > 0) {
    return (
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-1.5">
            <dt className="text-zinc-400 dark:text-zinc-500">{key}:</dt>
            <dd className="break-all font-mono text-zinc-700 dark:text-zinc-200">
              {formatDetailValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  if (details === null || details === undefined) return null;
  const text = typeof details === "string" ? details : formatDetailValue(details);
  return (
    <p className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">
      {text}
    </p>
  );
}

export default async function ShipmentDetailPage({ params }: { params: Params }) {
  // Protected by the (app) layout; re-read here for the verified session.
  await requireSession();

  const { id } = await params;
  const result = await getShipmentById(id);

  // Database failure: explicit panel (not a silent 404 — the record may
  // actually exist and this distinguishes transport/DB problems).
  if (result.status === "unavailable") {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <section
          role="alert"
          aria-label="Data unavailable"
          className="flex flex-col items-center gap-3 rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Shipment data could not be loaded. Please try again.
          </p>
          <Link
            href="/shipments"
            className="w-fit rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:bg-zinc-900"
          >
            Back to shipments
          </Link>
        </section>
      </div>
    );
  }

  // Invalid UUID or nonexistent shipment → Next 16 typed 404.
  if (result.status !== "found") {
    notFound();
  }

  const { shipment, auditTrail } = result;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <nav
          aria-label="Breadcrumb"
          className="text-xs text-zinc-500 dark:text-zinc-400"
        >
          <Link
            href="/"
            className="transition hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            Dashboard
          </Link>
          <span aria-hidden className="px-1">
            /
          </span>
          <Link
            href="/shipments"
            className="transition hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            Shipments
          </Link>
          <span aria-hidden className="px-1">
            /
          </span>
          <span
            aria-current="page"
            className="font-medium text-zinc-700 dark:text-zinc-300"
          >
            {shipment.reference}
          </span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {shipment.reference}
          </h1>
          <ShipmentStatusBadge status={shipment.status} />
        </div>
      </header>

      {/* Primary facts — everything the read-only view exposes today. */}
      <section aria-label="Shipment details" className={panelClasses}>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {factList(shipment).map((fact) => (
            <div
              key={fact.label}
              className={fact.fullWidth ? "sm:col-span-2" : ""}
            >
              <span className={labelClasses}>{fact.label}</span>
              <div
                className={fact.mono ? monoValueClasses : "mt-1 text-sm text-zinc-800 dark:text-zinc-200"}
              >
                {fact.value as ReactNode}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Audit history — append-only trail (audit_logs, newest first). */}
      <section aria-label="Audit history" className={panelClasses}>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Audit history
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Append-only activity trail for this shipment (newest first, latest 50
          entries).
        </p>
        {auditTrail.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
            No audit records yet for this shipment.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {auditTrail.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1.5 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs font-medium text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                    {entry.action}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {formatLongDateTimeUtc(entry.performedAt, "UTC")}
                  </span>
                  <span className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    actor: {entry.actorId ?? "system"}
                  </span>
                </div>
                <DetailPayload details={entry.details} />
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Future workflow placeholders — clearly labelled, not implemented. */}
      <section aria-label="Coming soon" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Coming to this page
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {placeholderSections.map((section) => (
            <div
              key={section.key}
              className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {section.title}
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {section.note}
              </p>
              <p className="mt-auto text-xs italic text-zinc-400 dark:text-zinc-600">
                Placeholder — not connected yet.
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
