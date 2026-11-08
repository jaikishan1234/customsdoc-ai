import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { formatLongDateTimeUtc } from "@/lib/date-display";
import { formatDocumentTypeLabel } from "@/lib/document-display";
import { USER_ROLES } from "@/lib/auth";
import { listDocumentsForShipment } from "@/lib/services/document-service";
import { getShipmentById } from "@/lib/services/shipment-service";
import {
  listExtractionHistoryForShipment,
} from "@/lib/services/extraction-read-service";
import { listDiscrepanciesForShipment } from "@/lib/services/discrepancy-read-service";
import type {
  ExtractionDocumentView,
  ShipmentExtractionHistoryResult,
} from "@/lib/services/extraction-read-service";
import { hasRole, requireSession } from "@/lib/server/auth";

import { ActivityPanel, describeAuditEntry } from "./activity-panel";
import { DocumentsPanel, REQUIRED_DOCUMENT_TYPES } from "./documents-panel";
import { ExtractionReviewPanel } from "./extraction-review-panel";
import { ShipmentHeader } from "./shipment-header";
import {
  parseShipmentTab,
  ShipmentTabNav,
  type ShipmentTab,
} from "./shipment-tab-nav";

export const metadata: Metadata = {
  title: "Shipment — CustomsDoc AI",
  description: "Shipment detail, lifecycle state and audit history.",
};

// Reads the server session and live database rows per request, so the
// segment intentionally blocks; Cache Components stay enabled globally.
export const instant = false;

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{
  tab?: string | string[] | undefined;
}>;

const panelClasses =
  "flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950";
const labelClasses =
  "text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const statValueClasses = "text-sm font-medium text-zinc-800 dark:text-zinc-100";
const chipLinkClasses =
  "w-fit rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:bg-zinc-900";

/** Compact stat cell for the Overview workspace group. */
function Stat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className={labelClasses}>{label}</dt>
      <dd className={statValueClasses}>{value}</dd>
    </div>
  );
}

export default async function ShipmentDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  // Protected by the (app) layout; re-read here for the verified session.
  const session = await requireSession();
  // Correction is a manager decision on the server too — the flag below only
  // hides the UI controls; the correction API independently re-verifies the
  // DOCUMENTATION_MANAGER role on every request.
  const canCorrect = hasRole(session, [USER_ROLES.DOCUMENTATION_MANAGER]);

  const { id } = await params;
  const query = await searchParams;
  const activeTab: ShipmentTab = parseShipmentTab(query.tab);

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
            className={chipLinkClasses}
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

  // Read-only document history — independent of the shipment row above.
  const documentsResult = await listDocumentsForShipment(id);
  const documentEntries =
    documentsResult.status === "success" ? documentsResult.entries : [];
  const documentsUnavailable = documentsResult.status === "unavailable";

  // Read-only extraction history — attempts + extracted fields (typed,
  // client-safe projections; not the privacy listing / storage contract).
  const extractionHistory: ShipmentExtractionHistoryResult =
    await listExtractionHistoryForShipment(id);

  // Read-only cross-document discrepancy list — all statuses; the page
  // derives the active count (OPEN + RECHECK_PENDING) for Overview guidance
  // and hands the ordered list to the Extraction & Review panel.
  const discrepanciesResult = await listDiscrepanciesForShipment(id);
  const discrepancyList =
    discrepanciesResult.status === "success"
      ? [...discrepanciesResult.discrepancies]
      : [];
  const discrepanciesUnavailable = discrepanciesResult.status === "unavailable";
  const activeDiscrepancyCount = discrepancyList.filter(
    (discrepancy) =>
      discrepancy.status === "OPEN" || discrepancy.status === "RECHECK_PENDING",
  ).length;

  // --- Workspace summary (header row + Overview stats + tab pills) --------
  const extractionGroups = new Map<string, ExtractionDocumentView>(
    extractionHistory.status === "success"
      ? extractionHistory.documents.map((group) => [group.documentId, group])
      : [],
  );
  const activeEntries =
    documentsResult.status === "success"
      ? documentEntries.filter((entry) => entry.isActive)
      : [];
  const extractedCount = activeEntries.filter(
    (entry) => extractionGroups.get(entry.id)?.hasCurrentCompleted,
  ).length;
  // Freshness-aware: pending counts use the CURRENT completed attempt only
  // (older completed attempts of stale groups are never "current data").
  const pendingReviewCount = activeEntries.reduce((sum, entry) => {
    const group = extractionGroups.get(entry.id);
    if (!group?.hasCurrentCompleted || !group.latest) return sum;
    return (
      sum +
      group.latest.fields.filter(
        (field) => field.reviewStatus === "PENDING_REVIEW",
      ).length
    );
  }, 0);
  const countsKnown =
    !documentsUnavailable && extractionHistory.status === "success";

  const workspaceSummary = {
    activeDocumentCount: documentsUnavailable ? null : activeEntries.length,
    extractedDocumentCount: countsKnown ? extractedCount : null,
    totalActiveDocuments: documentsUnavailable ? null : activeEntries.length,
    pendingReviewCount: countsKnown ? pendingReviewCount : null,
  };

  // Honest next-step guidance, derived from the same read data (never
  // inventing unavailable downstream features such as approval/export).
  const missingTypes = countsKnown
    ? REQUIRED_DOCUMENT_TYPES.filter(
        (type) => !activeEntries.some((entry) => entry.documentType === type),
      )
    : [];
  const nextStep = documentsUnavailable
    ? "Document data could not be loaded — please refresh to retry."
    : missingTypes.length > 0
      ? `Upload the remaining required document type${missingTypes.length === 1 ? "" : "s"} (${missingTypes
          .map((type) => formatDocumentTypeLabel(type))
          .join(", ")}) in the Documents tab.`
      : extractedCount < activeEntries.length
        ? "Run extraction for the not-yet-extracted documents in the Extraction & Review tab."
        : activeDiscrepancyCount > 0
          ? `Open cross-document discrepanc${activeDiscrepancyCount === 1 ? "y" : "ies"} flagged in the Extraction & Review tab — manager review required before this shipment can progress; active discrepancies block export.`
          : pendingReviewCount > 0
            ? `Review ${pendingReviewCount} pending extracted field value${pendingReviewCount === 1 ? "" : "s"} in the Extraction & Review tab.`
            : "No pending extraction work for this shipment.";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <ShipmentHeader shipment={shipment} summary={workspaceSummary} />

      <ShipmentTabNav
        shipmentId={shipment.id}
        activeTab={activeTab}
        documentCount={workspaceSummary.activeDocumentCount}
        pendingReviewCount={workspaceSummary.pendingReviewCount}
      />

      {activeTab === "overview" ? (
        <div className="flex flex-col gap-6">
          {/* Shipment information — description, notes, lifecycle dates. */}
          <section aria-label="Shipment details" className={panelClasses}>
            <div className="flex flex-col gap-1">
              <h2 className={labelClasses}>Description</h2>
              <p className="text-sm text-zinc-800 dark:text-zinc-200">
                {shipment.description ?? "—"}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <h2 className={labelClasses}>Notes</h2>
              <p className="text-sm text-zinc-800 dark:text-zinc-200">
                {shipment.notes ?? "—"}
              </p>
            </div>
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <Stat
                label="Created"
                value={formatLongDateTimeUtc(shipment.createdAt, "UTC")}
              />
              <Stat
                label="Last updated"
                value={formatLongDateTimeUtc(shipment.updatedAt, "UTC")}
              />
              {/* Export metadata renders only once it exists — no empty rows. */}
              {shipment.exportedAt ? (
                <Stat
                  label="Exported"
                  value={formatLongDateTimeUtc(shipment.exportedAt, "UTC")}
                />
              ) : null}
            </dl>
          </section>

          {/* Workspace status + guided next step. */}
          <section aria-label="Workspace status" className={panelClasses}>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Workspace status
            </h2>
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
              <Stat
                label="Required document types"
                value={
                  countsKnown
                    ? `${REQUIRED_DOCUMENT_TYPES.length - missingTypes.length} of ${REQUIRED_DOCUMENT_TYPES.length} present`
                    : "—"
                }
              />
              <Stat
                label="Extraction progress"
                value={
                  countsKnown
                    ? `${extractedCount} of ${activeEntries.length} documents`
                    : "—"
                }
              />
              <Stat
                label="Pending review"
                value={
                  countsKnown
                    ? `${pendingReviewCount} field${pendingReviewCount === 1 ? "" : "s"}`
                    : "—"
                }
              />
              <Stat
                label="Active discrepancies"
                value={
                  discrepanciesUnavailable ? "—" : String(activeDiscrepancyCount)
                }
              />
            </dl>
            <p className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
              <span className="font-medium">Next step:</span> {nextStep}
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href={`/shipments/${shipment.id}?tab=documents`}
                className={chipLinkClasses}
              >
                Go to Documents
              </Link>
              <Link
                href={`/shipments/${shipment.id}?tab=extraction`}
                className={chipLinkClasses}
              >
                Go to Extraction &amp; Review
              </Link>
            </div>
          </section>

          {/* Recent activity — top three; full timeline in Activity tab. */}
          <section aria-label="Recent activity" className={panelClasses}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Recent activity
              </h2>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                newest first
              </span>
            </div>
            {auditTrail.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                No activity recorded yet for this shipment.
              </p>
            ) : (
              <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
                {auditTrail.slice(0, 3).map((entry) => {
                  const description = describeAuditEntry(entry);
                  return (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
                    >
                      <span className="text-sm text-zinc-800 dark:text-zinc-100">
                        {description.label}
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {formatLongDateTimeUtc(entry.performedAt, "UTC")}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
            {auditTrail.length > 3 ? (
              <Link href={`/shipments/${shipment.id}?tab=activity`} className={chipLinkClasses}>
                View all activity
              </Link>
            ) : null}
          </section>
        </div>
      ) : activeTab === "documents" ? (
        <DocumentsPanel entries={documentEntries} unavailable={documentsUnavailable} />
      ) : activeTab === "extraction" ? (
        <ExtractionReviewPanel
          shipment={shipment}
          history={extractionHistory}
          documentEntries={documentEntries}
          documentsUnavailable={documentsUnavailable}
          discrepancies={discrepancyList}
          discrepanciesUnavailable={discrepanciesUnavailable}
          canCorrect={canCorrect}
        />
      ) : (
        <section className={panelClasses}>
          <ActivityPanel auditTrail={auditTrail} />
        </section>
      )}
    </div>
  );
}
