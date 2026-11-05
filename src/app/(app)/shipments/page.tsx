import type { Metadata } from "next";
import Link from "next/link";

import { ShipmentStatusBadge } from "@/components/shipment-status-badge";
import {
  listShipments,
  type ShipmentStatusValue,
} from "@/lib/services/shipment-service";
import { requireSession } from "@/lib/server/auth";
import { formatLongDateTimeUtc } from "@/lib/date-display";

/** Human labels for the status filter pills (order = listing order). */
const SHIPMENT_FILTER_OPTIONS: Array<{
  value: ShipmentStatusValue;
  label: string;
}> = [
  { value: "DRAFT", label: "Draft" },
  { value: "PROCESSING", label: "Processing" },
  { value: "REVIEW", label: "Review" },
  { value: "AWAITING_APPROVAL", label: "Awaiting approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "EXPORTED", label: "Exported" },
];

export const metadata: Metadata = {
  title: "Shipments — CustomsDoc AI",
  description: "Browse and track your customs shipments.",
};

// Reads the server session and live database rows per request, so the
// segment intentionally blocks; Cache Components stay enabled globally.
export const instant = false;

type SearchParams = Promise<{
  page?: string | string[] | undefined;
  status?: string | string[] | undefined;
}>;

const primaryParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const chipBase =
  "rounded-full border px-3 py-1 text-xs font-medium transition";
const chipActive =
  "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900";
const chipIdle =
  "border-zinc-300 text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:bg-zinc-900";
const pageLinkClasses =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:bg-zinc-900";
const pageLinkDisabled =
  "rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-400 dark:border-zinc-800 dark:text-zinc-600";

export default async function ShipmentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Protected by the (app) layout; re-read here for the verified session.
  await requireSession();

  const params = await searchParams;
  const result = await listShipments({
    page: primaryParam(params.page),
    status: primaryParam(params.status),
  });

  const buildHref = (page: number, status: string | null): string => {
    const query = new URLSearchParams();
    // omit for "all" (no filter) and page 1 (default) to keep clean URLs
    if (status) query.set("status", status);
    if (page > 1) query.set("page", String(page));
    const qs = query.toString();
    return qs ? `/shipments?${qs}` : "/shipments";
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
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
            <span
              aria-current="page"
              className="font-medium text-zinc-700 dark:text-zinc-300"
            >
              Shipments
            </span>
          </nav>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Shipments
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {result.status === "success"
              ? `${result.total} shipment${result.total === 1 ? "" : "s"}${
                  result.statusFilter ? ` with ${result.statusFilter.toLowerCase().replace(/_/g, " ")} status` : ""
                }.`
              : "Shipment data is temporarily unavailable."}
          </p>
        </div>
        <Link
          href="/shipments/new"
          className="inline-flex h-10 items-center justify-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          New shipment
        </Link>
      </header>

      {result.status === "unavailable" ? (
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
            className={`${pageLinkClasses} w-fit`}
          >
            Retry
          </Link>
        </section>
      ) : (
        <>
          {/* Status filter — server-rendered links; no client JS required.
              Changing the filter resets to page 1. */}
          <nav
            aria-label="Filter by status"
            className="flex flex-wrap items-center gap-2"
          >
            <Link
              href="/shipments"
              className={`${chipBase} ${result.statusFilter === null ? chipActive : chipIdle}`}
            >
              All
            </Link>
            {SHIPMENT_FILTER_OPTIONS.map((status) => (
              <Link
                key={status.value}
                href={`/shipments?status=${status.value}`}
                className={`${chipBase} ${
                  result.statusFilter === status.value ? chipActive : chipIdle
                }`}
              >
                {status.label}
              </Link>
            ))}
          </nav>

          {result.shipments.length === 0 ? (
            <section
              aria-label="No shipments"
              className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-zinc-300 bg-white p-12 text-center dark:border-zinc-700 dark:bg-zinc-950"
            >
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                {result.total === 0
                  ? "No shipments yet. Create your first shipment to get started."
                  : `No shipments on this page — try an earlier page number with the current filter.`}
              </p>
              <Link
                href="/shipments/new"
                className="inline-flex h-10 items-center justify-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                New shipment
              </Link>
            </section>
          ) : (
            <section aria-label="Shipment list" className="flex flex-col gap-4">
              <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Reference
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Status
                      </th>
                      <th
                        scope="col"
                        className="hidden px-4 py-3 font-medium md:table-cell"
                      >
                        Description
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Created
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {result.shipments.map((shipment) => (
                      <tr
                        key={shipment.id}
                        className="transition hover:bg-zinc-50 dark:hover:bg-zinc-900"
                      >
                        <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                          <Link
                            href={`/shipments/${shipment.id}`}
                            className="underline-offset-2 transition hover:underline dark:text-zinc-100"
                          >
                            {shipment.reference}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <ShipmentStatusBadge status={shipment.status} />
                        </td>
                        <td className="hidden max-w-[24rem] truncate px-4 py-3 text-zinc-600 md:table-cell dark:text-zinc-300">
                          {shipment.description ?? (
                            <span className="text-zinc-400 dark:text-zinc-600">
                              —
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-zinc-600 dark:text-zinc-300">
                          {formatLongDateTimeUtc(shipment.createdAt, "UTC")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <nav
                aria-label="Pagination"
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Page {result.page} of {result.totalPages} • {result.total}{" "}
                  shipment{result.total === 1 ? "" : "s"}
                </p>
                <div className="flex items-center gap-2">
                  {result.page > 1 ? (
                    <Link
                      href={buildHref(result.page - 1, result.statusFilter)}
                      className={pageLinkClasses}
                    >
                      Previous
                    </Link>
                  ) : (
                    <span aria-hidden className={pageLinkDisabled}>
                      Previous
                    </span>
                  )}
                  {result.page < result.totalPages ? (
                    <Link
                      href={buildHref(result.page + 1, result.statusFilter)}
                      className={pageLinkClasses}
                    >
                      Next
                    </Link>
                  ) : (
                    <span aria-hidden className={pageLinkDisabled}>
                      Next
                    </span>
                  )}
                </div>
              </nav>
            </section>
          )}
        </>
      )}
    </div>
  );
}
