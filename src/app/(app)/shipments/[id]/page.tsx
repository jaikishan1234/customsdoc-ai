import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ShipmentStatusBadge } from "@/components/shipment-status-badge";
import { formatLongDateTimeUtc } from "@/lib/date-display";
import {
  formatDocumentTypeLabel,
  formatFileSizeBytes,
} from "@/lib/document-display";
import { listDocumentsForShipment } from "@/lib/services/document-service";
import { getShipmentById } from "@/lib/services/shipment-service";
import {
  listExtractionHistoryForShipment,
  type ExtractedFieldValueView,
  type ExtractionAttemptView,
  type ExtractionDocumentView,
  type ShipmentExtractionHistoryResult,
} from "@/lib/services/extraction-read-service";
import { requireSession } from "@/lib/server/auth";
import type { ShipmentDocumentEntry } from "@/lib/services/document-service";
import type { Shipment } from "@/lib/db/schema";
import { ExtractionPanel } from "./extract-panel";

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
    key: "approval",
    title: "Approval & export",
    note: "Manager approval decisions and export-ready CSV stamping.",
  },
] as const;

/**
 * Shipments whose status permits an extraction run — mirrors the service's
 * ELIGIBLE_STATUSES allow-list (kept in explicit sync; the service stays the
 * single enforcement point, this only gates the button's visibility).
 */
const EXTRACTION_ELIGIBLE_STATUSES = ["DRAFT", "PROCESSING", "REJECTED"] as const;

/** Status pill styling for a document version's active/superseded state. */
const DOCUMENT_VERSION_STATUS = {
  active: {
    label: "Active",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  superseded: {
    label: "Superseded",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
  },
} as const;

const DocumentVersionStatusPill = ({ isActive }: { isActive: boolean }) => {
  const known = isActive ? DOCUMENT_VERSION_STATUS.active : DOCUMENT_VERSION_STATUS.superseded;
  return <span className={known.className}>{known.label}</span>;
};

/**
 * One version row in the Documents section. Renders only the metadata the
 * listing service exposes — no storage keys, checksums or provider facts.
 */
function DocumentRow({ entry }: { entry: ShipmentDocumentEntry }) {
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="break-all text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {entry.originalFilename}
        </span>
        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
          {formatDocumentTypeLabel(entry.documentType)}
        </span>
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
          v{entry.version}
        </span>
        <DocumentVersionStatusPill isActive={entry.isActive} />
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {formatFileSizeBytes(entry.sizeBytes)} PDF · uploaded{" "}
        {formatLongDateTimeUtc(entry.uploadedAt, "UTC")} by{" "}
        {entry.uploadedBy.name}
        {entry.supersededAt
          ? ` · superseded ${formatLongDateTimeUtc(entry.supersededAt, "UTC")}`
          : null}
      </p>
    </li>
  );
}

/**
 * Status pill styling map for extraction attempt statuses (mutually
 * exclusive, one variant per pg enum value).
 */
const ATTEMPT_STATUS_PILLS = {
  COMPLETED: {
    label: "Completed",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  FAILED: {
    label: "Failed",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  },
  PROCESSING: {
    label: "In progress",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300",
  },
  PENDING: {
    label: "Pending",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
  },
  SUPERSEDED: {
    label: "Superseded",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
  },
} as const;

const ExtractionAttemptStatusPill = ({
  status,
}: {
  status: ExtractionAttemptView["status"];
}) => {
  const known = ATTEMPT_STATUS_PILLS[status];
  return (
    <span className={known.className}>{known.label}</span>
  );
};

/** Review-status pill: pending review must be visually obvious. */
const REVIEW_STATUS_PILLS = {
  PENDING_REVIEW: {
    label: "Pending review",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  },
  ACCEPTED: {
    label: "Accepted",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  CORRECTED: {
    label: "Corrected",
    className:
      "inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300",
  },
} as const;

const ReviewStatusPill = ({
  status,
}: {
  status: ExtractedFieldValueView["reviewStatus"];
}) => {
  const known = REVIEW_STATUS_PILLS[status];
  return <span className={known.className}>{known.label}</span>;
};

/** Client-friendly text for sanitized extraction error codes. */
const EXTRACTION_ERROR_LABELS: Record<string, string> = {
  STORAGE_NOT_FOUND: "Stored document no longer found",
  STORAGE_KEY_INVALID: "Stored document reference invalid",
  STORAGE_UNAVAILABLE: "Document storage temporarily unavailable",
  CHECKSUM_MISMATCH: "Stored document failed the integrity check",
  PROVIDER_UNAVAILABLE: "AI provider temporarily unavailable",
  PROVIDER_RATE_LIMITED: "AI provider rate limit hit",
  PROVIDER_REJECTED: "AI provider rejected the request",
  PROVIDER_INVALID_OUTPUT: "AI output failed validation",
  DAILY_CEILING: "Daily extraction ceiling reached",
  PERSISTENCE_FAILED: "Results could not be saved",
  SUPERSEDE_INCOMPLETE: "Retired the previous result but save incomplete",
  STALE_PROCESSING: "Abandoned attempt recovered",
  INTERNAL_ERROR: "Internal error",
};

const formatConfidence = (confidence: string): string =>
  // NUMERIC(4,3) arrives as text ("0.950"); display as a percentage.
  `${Math.round(Number(confidence) * 100)}%`;

/**
 * One attempt's extracted fields as a definition list — label, value (+unit),
 * confidence, page number and review status. Values are the parsed canonical
 * strings the read service exposes; no raw documents or provider output.
 */
function ExtractedFieldList({ fields }: { fields: readonly ExtractedFieldValueView[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
      {fields.map((field) => (
        <div
          key={field.fieldKey}
          className="flex flex-col gap-1 border-b border-dashed border-zinc-200 pb-2 dark:border-zinc-800"
        >
          <dt className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            {field.fieldLabel}
          </dt>
          <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={
                field.reviewStatus === "PENDING_REVIEW"
                  ? "break-all font-mono text-xs text-amber-800 dark:text-amber-200"
                  : "break-all font-mono text-xs text-zinc-800 dark:text-zinc-200"
              }
            >
              {field.parsedValue}
              {field.unit ? ` ${field.unit}` : ""}
            </span>
            <span
              title="Model confidence"
              className="text-[11px] text-zinc-500 dark:text-zinc-400"
            >
              {formatConfidence(field.confidence)}
            </span>
            {field.pageNumber !== null ? (
              <span
                title="Page where the value was found"
                className="text-[11px] text-zinc-500 dark:text-zinc-400"
              >
                p.{field.pageNumber}
              </span>
            ) : null}
            <ReviewStatusPill status={field.reviewStatus} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Compact attempt history rows for one document (newest first). Attempts are
 * plain status/timestamp/error rows; fields render only in the labelled
 * current / previous-completed blocks below.
 */
function AttemptHistoryRow({
  attempt,
  isCurrent,
}: {
  attempt: ExtractionAttemptView;
  isCurrent: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs text-zinc-600 dark:text-zinc-300">
      <span className="font-mono text-zinc-500 dark:text-zinc-400">
        attempt {attempt.attempt}
        {isCurrent ? " (current)" : ""}
      </span>
      <ExtractionAttemptStatusPill status={attempt.status} />
      <span className="text-zinc-500 dark:text-zinc-400">
        started{" "}
        {attempt.startedAt
          ? formatLongDateTimeUtc(attempt.startedAt, "UTC")
          : "—"}
      </span>
      {attempt.completedAt ? (
        <span className="text-zinc-500 dark:text-zinc-400">
          finished {formatLongDateTimeUtc(attempt.completedAt, "UTC")}
        </span>
      ) : null}
      {attempt.errorCode ? (
        <span className="text-red-700 dark:text-red-300">
          {EXTRACTION_ERROR_LABELS[attempt.errorCode] ?? attempt.errorCode}
        </span>
      ) : null}
      <span className="text-zinc-400 dark:text-zinc-500" title="Engine/model">
        engine: {attempt.engine}
      </span>
    </li>
  );
}

/**
 * One document block in the AI-extraction section: identity, the CURRENT
 * attempt line, extracted fields of the current (or previous completed)
 * attempt, and the bounded attempt history. An older COMPLETED attempt is
 * rendered ONLY in the explicitly-labelled "no longer current" block — never
 * as current data — because a newer FAILED/PROCESSING attempt owns freshness
 * (max(attempt) rule).
 */
function ExtractionDocumentBlock({ group }: { group: ExtractionDocumentView }) {
  const latest = group.latest;
  const current =
    latest && latest.status === "COMPLETED" && latest.fields.length > 0
      ? latest
      : null;
  const previous = current
    ? null
    : (group.attempts.find(
        (attempt) => attempt.status === "COMPLETED" && attempt.fields.length > 0,
      ) ?? null);

  return (
    <li className="flex flex-col gap-2.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="break-all text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {group.documentFilename}
        </span>
        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
          {formatDocumentTypeLabel(group.documentType)}
        </span>
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
          v{group.documentVersion}
        </span>
      </div>

      {latest === null ? null : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span>
              Current attempt: {latest.attempt}
            </span>
            <ExtractionAttemptStatusPill status={latest.status} />
            {latest.status !== "COMPLETED" && latest.errorCode ? (
              <span className="text-red-700 dark:text-red-300">
                {EXTRACTION_ERROR_LABELS[latest.errorCode] ?? latest.errorCode}
              </span>
            ) : null}
            <span title="Engine/model">engine: {latest.engine}</span>
            {latest.startedAt ? (
              <span>
                started {formatLongDateTimeUtc(latest.startedAt, "UTC")}
              </span>
            ) : null}
          </div>

          {current ? (
            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                Extracted fields — attempt {current.attempt} (current)
              </h4>
              <ExtractedFieldList fields={current.fields} />
            </div>
          ) : (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              The current attempt is not COMPLETED — there is no current
              extracted data for this document. History below shows when this
              changed; a new extraction run recovers it.
            </p>
          )}

          {previous ? (
            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                Previous completed extraction — attempt {previous.attempt}
              </h4>
              <p className="text-[11px] italic text-amber-700 dark:text-amber-300">
                No longer current: attempt {latest?.attempt} is the latest. Do
                not use these values as fresh data.
              </p>
              <ExtractedFieldList fields={previous.fields} />
            </div>
          ) : null}

          <details className="text-xs text-zinc-600 dark:text-zinc-300">
            <summary className="cursor-pointer select-none">
              Attempt history ({group.attempts.length})
            </summary>
            <ul className="mt-1 flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
              {group.attempts.map((attempt) => (
                <AttemptHistoryRow
                  key={attempt.id}
                  attempt={attempt}
                  isCurrent={attempt.id === latest.id}
                />
              ))}
            </ul>
          </details>
        </>
      )}
    </li>
  );
}

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

  // Read-only document history — independent of the shipment row above.
  const documentsResult = await listDocumentsForShipment(id);
  const documentEntries =
    documentsResult.status === "success" ? documentsResult.entries : [];
  const documentsUnavailable = documentsResult.status === "unavailable";

  // Read-only extraction history — attempts + extracted fields (typed,
  // client-safe projections; not the privacy listing / storage contract).
  const extractionHistory: ShipmentExtractionHistoryResult =
    await listExtractionHistoryForShipment(id);

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

      {/* Documents & uploads — versioned per-type history (documents table). */}
      <section aria-label="Documents and uploads" className={panelClasses}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Documents &amp; uploads
          </h2>
          {documentEntries.length > 0 ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {documentEntries.filter((entry) => entry.isActive).length} active
              of {documentEntries.length} version
              {documentEntries.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Version history per document type, newest version first. Superseded
          versions are retained for traceability.
        </p>
        {documentsUnavailable ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
            Document data could not be loaded. Please try again.
          </p>
        ) : documentEntries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
            No documents uploaded yet for this shipment. Invoices, packing
            lists and bills of lading will appear here with their full version
            history once uploaded.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {documentEntries.map((entry) => (
              <DocumentRow key={entry.id} entry={entry} />
            ))}
          </ol>
        )}
      </section>

      {/* AI extraction — trigger + attempt history + extracted fields. */}
      <section aria-label="AI extraction" className={panelClasses}>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          AI extraction
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Attempt history and extracted values per document, newest attempt
          first. Values marked pending review need human confirmation before
          approval.
        </p>
        <ExtractionPanel
          shipmentId={shipment.id}
          canRun={(EXTRACTION_ELIGIBLE_STATUSES as readonly string[]).includes(
            shipment.status,
          )}
          currentStatus={shipment.status}
        />
        {extractionHistory.status !== "success" ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
            Extraction data could not be loaded. Please try again.
          </p>
        ) : extractionHistory.documents.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
            No extraction attempts yet. Run extraction to pull values from the
            active documents into the review-ready list below.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {extractionHistory.documents.map((group) => (
              <ExtractionDocumentBlock key={group.documentId} group={group} />
            ))}
          </ol>
        )}
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
        <div className="grid gap-4 sm:grid-cols-2">
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
