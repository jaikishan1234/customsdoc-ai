/**
 * Approval & Export tab content (approval phase; CSV export is not built).
 *
 * Server-rendered presentation over the existing read paths:
 * - readiness + exact blockers: `evaluateShipmentReadiness()` (approval
 *   service — the same rules the approve API enforces, never re-implemented
 *   in the browser);
 * - latest decision: `getShipmentApproval()` (client-safe projection: status,
 *   timestamps, decider name, note, snapshot counts — never ids/checksums);
 * - documents/extraction state: the document and extraction read services the
 *   other tabs already use.
 *
 * Authorization: the decision controls render only for a verified
 * DOCUMENTATION_MANAGER session (the flag comes from the server page). The
 * API re-verifies the role on every request; hiding controls is convenience,
 * not authorization.
 *
 * The panel never blocks approval when readiness reports blockers: the
 * approve control is disabled with the reason and the exact blocker list stays
 * visible.
 */
import type { Shipment } from "@/lib/db/schema";
import { formatDocumentTypeLabel } from "@/lib/document-display";
import { formatLongDateTimeUtc } from "@/lib/date-display";
import { ShipmentStatusBadge } from "@/components/shipment-status-badge";
import type {
  ApprovalBlocker,
  ShipmentReadinessResult,
} from "@/lib/services/approval-service";
import type {
  ShipmentApprovalView,
} from "@/lib/services/approval-read-service";
import type { ShipmentDocumentEntry } from "@/lib/services/document-service";
import type {
  ShipmentExtractionHistoryResult,
} from "@/lib/services/extraction-read-service";

import { ApprovalDecisionControls } from "./approval-decision-controls";
import { REQUIRED_DOCUMENT_TYPES } from "./documents-panel";

const panelClasses =
  "flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950";
const noticeClasses =
  "rounded-xl border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300";
const labelClasses =
  "text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const mutedText = "text-xs text-zinc-500 dark:text-zinc-400";

const APPROVAL_STATUS_PILLS: Record<
  ShipmentApprovalView["status"],
  { label: string; className: string }
> = {
  PENDING: {
    label: "Pending",
    className:
      "inline-block whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  },
  APPROVED: {
    label: "Approved",
    className:
      "inline-block whitespace-nowrap rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  REJECTED: {
    label: "Rejected",
    className:
      "inline-block whitespace-nowrap rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  },
  INVALIDATED: {
    label: "Invalidated",
    className:
      "inline-block whitespace-nowrap rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
  },
};

/** Exact backend blocker -> client-safe presentation text. */
const blockerText = (blocker: ApprovalBlocker): string => {
  switch (blocker.code) {
    case "missing_document":
      return `${formatDocumentTypeLabel(blocker.documentType)} is missing — upload an active version.`;
    case "attempt_not_completed":
      return `${formatDocumentTypeLabel(blocker.documentType)}: the latest extraction attempt (${blocker.attempt}) is ${blocker.extractionStatus}; it must be COMPLETED.`;
    case "required_field_missing":
      return `${formatDocumentTypeLabel(blocker.documentType)} · ${blocker.fieldLabel} is missing from the latest extraction.`;
    case "required_field_pending":
      return `${formatDocumentTypeLabel(blocker.documentType)} · ${blocker.fieldLabel} is pending review — accept or correct it.`;
    case "blocking_discrepancy":
      return `${blocker.discrepancyType}${blocker.scopeKey ? ` (${blocker.scopeKey})` : ""} is ${blocker.status} at ${blocker.severity} severity — open findings block approval.`;
  }
};

function BlockerList({
  blockers,
  tone = "amber",
}: {
  blockers: readonly ApprovalBlocker[];
  tone?: "amber" | "red";
}) {
  if (blockers.length === 0) return null;
  return (
    <ul
      className={
        tone === "red"
          ? "list-disc rounded-lg border border-red-200 bg-red-50 py-2 pl-7 pr-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          : "list-disc rounded-lg border border-amber-200 bg-amber-50 py-2 pl-7 pr-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      }
    >
      {blockers.map((blocker, index) => (
        <li key={`${blocker.code}-${index}`}>{blockerText(blocker)}</li>
      ))}
    </ul>
  );
}

export function ApprovalPanel({
  shipment,
  readiness,
  approval,
  approvalUnavailable,
  documentEntries,
  documentsUnavailable,
  history,
  canDecide,
}: {
  shipment: Shipment;
  /** Server-side readiness evaluation; null only if the tab did not load it. */
  readiness: ShipmentReadinessResult | null;
  approval: ShipmentApprovalView | null;
  approvalUnavailable: boolean;
  documentEntries: readonly ShipmentDocumentEntry[];
  documentsUnavailable: boolean;
  history: ShipmentExtractionHistoryResult;
  /** True only for a DOCUMENTATION_MANAGER session (server-verified). */
  canDecide: boolean;
}) {
  const readinessSuccess =
    readiness?.status === "success" ? readiness : null;
  const blockers = readinessSuccess?.blockers ?? [];
  const activeEntries = documentEntries.filter((entry) => entry.isActive);
  const groupFor = (documentId: string) =>
    history.status === "success"
      ? (history.documents.find((group) => group.documentId === documentId) ??
        null)
      : null;

  const pendingFields = blockers.filter(
    (blocker) => blocker.code === "required_field_pending",
  );
  const missingFields = blockers.filter(
    (blocker) =>
      blocker.code === "required_field_missing" ||
      blocker.code === "missing_document",
  );
  const extractionBlockers = blockers.filter(
    (blocker) => blocker.code === "attempt_not_completed",
  );
  const discrepancyBlockers = blockers.filter(
    (blocker) => blocker.code === "blocking_discrepancy",
  );

  const liveDecision =
    approval?.status === "PENDING" || approval?.status === "APPROVED";

  const approveDisabledReason = ((): string | null => {
    if (liveDecision) return "a live approval decision already exists.";
    if (shipment.status === "EXPORTED")
      return "exported shipments cannot be decided.";
    if (readiness === null || readiness.status !== "success")
      return "readiness could not be evaluated.";
    if (!readiness.ready)
      return "resolve every readiness blocker before approving.";
    if (
      !["PROCESSING", "REVIEW", "REJECTED"].includes(shipment.status)
    )
      return "the shipment's current status does not allow approval.";
    return null;
  })();

  const rejectDisabledReason = ((): string | null => {
    if (liveDecision) return "a live approval decision already exists.";
    if (shipment.status === "EXPORTED")
      return "exported shipments cannot be decided.";
    if (
      !["PROCESSING", "REVIEW", "AWAITING_APPROVAL"].includes(shipment.status)
    )
      return "the shipment's current status does not allow rejection.";
    return null;
  })();

  return (
    <div className="flex flex-col gap-6">
      {/* 1. Current state + latest decision. */}
      <section aria-label="Approval status" className={panelClasses}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Approval
          </h2>
          <ShipmentStatusBadge status={shipment.status} />
          {approval ? (
            <span className={APPROVAL_STATUS_PILLS[approval.status].className}>
              Decision {APPROVAL_STATUS_PILLS[approval.status].label}
            </span>
          ) : null}
        </div>

        {approvalUnavailable ? (
          <p
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            The latest approval decision could not be loaded. Refresh to retry;
            no decision is implied either way.
          </p>
        ) : approval === null ? (
          <p className={mutedText}>
            No approval decision has been recorded for this shipment yet.
          </p>
        ) : (
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-0.5">
              <dt className={labelClasses}>Decision</dt>
              <dd className="text-zinc-800 dark:text-zinc-100">
                {APPROVAL_STATUS_PILLS[approval.status].label}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className={labelClasses}>Decided</dt>
              <dd className="text-zinc-800 dark:text-zinc-100">
                {approval.decidedAt
                  ? formatLongDateTimeUtc(approval.decidedAt, "UTC")
                  : "—"}
                {approval.decidedByName
                  ? ` · ${approval.decidedByName}`
                  : ""}
              </dd>
            </div>
            {approval.decisionNote !== null ? (
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className={labelClasses}>Decision note</dt>
                <dd className="text-zinc-800 dark:text-zinc-100">
                  {approval.decisionNote}
                </dd>
              </div>
            ) : null}
            {approval.snapshot !== null ? (
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className={labelClasses}>Evidence snapshot</dt>
                <dd className={mutedText}>
                  {approval.snapshot.capturedAt
                    ? `captured ${formatLongDateTimeUtc(
                        new Date(approval.snapshot.capturedAt),
                        "UTC",
                      )}`
                    : "captured at decision time"}{" "}
                  · {approval.snapshot.documentCount} document
                  {approval.snapshot.documentCount === 1 ? "" : "s"} ·{" "}
                  {approval.snapshot.extractionCount} extraction
                  {approval.snapshot.extractionCount === 1 ? "" : "s"}
                </dd>
              </div>
            ) : null}
          </dl>
        )}

        {approval?.status === "APPROVED" ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            This shipment is approved. CSV export is not available yet — it
            will be added in a later stage.
          </p>
        ) : null}
      </section>

      {/* 2. Readiness. */}
      <section aria-label="Approval readiness" className={panelClasses}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Readiness
          </h2>
          {readinessSuccess ? (
            <span
              className={
                readinessSuccess.ready
                  ? "rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              }
            >
              {readinessSuccess.ready
                ? "Ready for approval"
                : `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`}
            </span>
          ) : null}
        </div>

        {readiness === null || readiness.status !== "success" ? (
          <p
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            Readiness could not be evaluated right now. Approval stays
            unavailable until the checks can run; refresh to retry.
          </p>
        ) : readinessSuccess!.ready ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            All approval requirements are met: required documents are present,
            every latest extraction is completed, required fields are reviewed
            and no blocking discrepancy is open.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Pending required fields
              </h3>
              {pendingFields.length > 0 ? (
                <BlockerList blockers={pendingFields} />
              ) : (
                <p className={mutedText}>None.</p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Missing documents or fields
              </h3>
              {missingFields.length > 0 ? (
                <BlockerList blockers={missingFields} tone="red" />
              ) : (
                <p className={mutedText}>None.</p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Extraction blockers
              </h3>
              {extractionBlockers.length > 0 ? (
                <BlockerList blockers={extractionBlockers} />
              ) : (
                <p className={mutedText}>None.</p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Blocking discrepancies
              </h3>
              {discrepancyBlockers.length > 0 ? (
                <BlockerList blockers={discrepancyBlockers} tone="red" />
              ) : (
                <p className={mutedText}>None.</p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* 3. Required documents + extraction completion. */}
      <section aria-label="Required documents" className={panelClasses}>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Required documents and extraction
        </h2>
        {documentsUnavailable || history.status !== "success" ? (
          <p className={noticeClasses}>
            Document or extraction data could not be loaded, so this summary is
            hidden. Readiness above is still authoritative.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {REQUIRED_DOCUMENT_TYPES.map((documentType) => {
              const entry =
                activeEntries.find(
                  (candidate) => candidate.documentType === documentType,
                ) ?? null;
              const group = entry ? groupFor(entry.id) : null;
              const latest = group?.latest ?? null;
              return (
                <li
                  key={documentType}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs text-zinc-600 dark:text-zinc-300"
                >
                  <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                    {formatDocumentTypeLabel(documentType)}
                  </span>
                  {entry ? (
                    <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      v{entry.version}
                    </span>
                  ) : (
                    <span className="font-medium text-red-700 dark:text-red-300">
                      Missing
                    </span>
                  )}
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {latest
                      ? `latest attempt ${latest.attempt} · ${latest.status}`
                      : "extraction not run"}
                  </span>
                  {entry && group?.hasCurrentCompleted ? (
                    <span className="ml-auto rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                      Current data confirmed
                    </span>
                  ) : entry ? (
                    <span className="ml-auto rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      No current completed attempt
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* 4. Manager decision controls (or the read-only explanation). */}
      <section aria-label="Approval decision" className={panelClasses}>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Decision
        </h2>
        {canDecide ? (
          <ApprovalDecisionControls
            shipmentId={shipment.id}
            approveDisabledReason={approveDisabledReason}
            rejectDisabledReason={rejectDisabledReason}
          />
        ) : (
          <p className={mutedText}>
            Only documentation managers may approve or reject shipments. The
            decision API independently enforces this on every request.
          </p>
        )}
      </section>
    </div>
  );
}
