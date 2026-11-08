/**
 * Compact shipment workspace header: breadcrumb, reference + lifecycle badge,
 * optional description line, and a small operational summary row.
 *
 * Deliberately shows NO raw IDs (shipment/user/document) — only names and
 * counts the read services already expose in client-safe projections.
 */
import Link from "next/link";

import { ShipmentStatusBadge } from "@/components/shipment-status-badge";
import type { Shipment } from "@/lib/db/schema";

/** Workspace-level counts computed by the page from the read services. */
export interface ShipmentWorkspaceSummary {
  /** Active document count; null when the listing is unavailable. */
  activeDocumentCount: number | null;
  /** Active documents extracted; null when extraction data is unavailable. */
  extractedDocumentCount: number | null;
  /** Same denominator as above so the ratio renders honestly. */
  totalActiveDocuments: number | null;
  /** Extracted fields awaiting human review; null when unavailable. */
  pendingReviewCount: number | null;
}

export function ShipmentHeader({
  shipment,
  summary,
}: {
  shipment: Shipment;
  summary: ShipmentWorkspaceSummary;
}) {
  const extractionSummary =
    summary.extractedDocumentCount !== null &&
    summary.totalActiveDocuments !== null
      ? `${summary.extractedDocumentCount} of ${summary.totalActiveDocuments} documents extracted`
      : "—";
  const pendingReview =
    summary.pendingReviewCount === null
      ? "—"
      : summary.pendingReviewCount === 0
        ? "Up to date"
        : `${summary.pendingReviewCount} field${summary.pendingReviewCount === 1 ? "" : "s"}`;

  return (
    <header className="flex flex-col gap-4">
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

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {shipment.reference}
          </h1>
          <ShipmentStatusBadge status={shipment.status} />
        </div>
        {shipment.description ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            {shipment.description}
          </p>
        ) : null}
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-1.5">
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">
            Active documents
          </dt>
          <dd className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
            {summary.activeDocumentCount ?? "—"}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">
            Extraction
          </dt>
          <dd className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
            {extractionSummary}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">
            Pending review
          </dt>
          <dd className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
            {pendingReview}
          </dd>
        </div>
      </dl>
    </header>
  );
}
