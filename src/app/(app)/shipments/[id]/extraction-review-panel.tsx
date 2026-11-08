/**
 * Extraction & Review tab content — the previous "AI extraction" section
 * restructured as a workspace:
 *
 * Structure (top → bottom):
 *   1. Extraction status overview: compact per-active-document rows.
 *   2. Run action: the existing ExtractionPanel client component, untouched
 *      (same fetch, fences, honest unconfirmed states, outcomes rendering).
 *   3. Per-document result cards: identity + current status, then a compact
 *      derived field summary, with the FULL field list collapsed behind a
 *      disclosure (two columns on sm+, one column on mobile).
 *   4. Attempt history: collapsed by default per document — technical
 *      metadata (engine, timestamps, sanitized error labels) lives there.
 *
 * Behavioural contract preserved exactly: freshness is decided by the read
 * service's max(attempt) rule (hasCurrentCompleted); an older COMPLETED
 * attempt renders ONLY as explicitly-labelled non-current history; values
 * are the client-safe parsed projections (no raw provider output); error
 * codes map through constant label strings; review rules and attempt
 * selection behaviour are untouched.
 */
import type { Shipment } from "@/lib/db/schema";
import { formatDocumentTypeLabel } from "@/lib/document-display";
import { formatLongDateTimeUtc } from "@/lib/date-display";
import type {
  ShipmentDocumentEntry,
} from "@/lib/services/document-service";
import type {
  ExtractionAttemptView,
  ExtractionDocumentView,
  ExtractedFieldValueView,
  ShipmentExtractionHistoryResult,
} from "@/lib/services/extraction-read-service";

import { ExtractionPanel } from "./extract-panel";

/**
 * Shipments whose status permits an extraction run — mirrors the service's
 * ELIGIBLE_STATUSES allow-list (kept in explicit sync; the service stays the
 * single enforcement point, this only gates the button's visibility).
 */
const EXTRACTION_ELIGIBLE_STATUSES = ["DRAFT", "PROCESSING", "REJECTED"] as const;

/** Client-friendly text for the sanitized error codes (constant strings). */
export const EXTRACTION_ERROR_LABELS: Record<string, string> = {
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

const noticeClasses =
  "rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300";
const cardClasses =
  "flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950";
const notRunPill =
  "rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400";

/* --- Status pills (moved unchanged from the previous page) --------------- */

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

const ExtractedAttemptStatusPill = ({
  status,
}: {
  status: ExtractionAttemptView["status"];
}) => {
  const known = ATTEMPT_STATUS_PILLS[status];
  return <span className={known.className}>{known.label}</span>;
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

const formatConfidence = (confidence: string): string =>
  // NUMERIC(4,3) arrives as text ("0.950"); display as a percentage.
  `${Math.round(Number(confidence) * 100)}%`;

/** Derived (not invented) summary counters for one attempt's field set. */
const summarizeFields = (fields: readonly ExtractedFieldValueView[]) => {
  const pending = fields.filter(
    (field) => field.reviewStatus === "PENDING_REVIEW",
  ).length;
  const avgConfidence = fields.length
    ? Math.round(
        (fields.reduce((sum, field) => sum + Number(field.confidence), 0) /
          fields.length) *
          100,
      )
    : null;
  return { pending, avgConfidence };
};

/**
 * Full field list — label, value (+unit), confidence, page number and review
 * status. Values are the parsed canonical strings the read service exposes;
 * responsive two columns on sm+, one on mobile. Callers collapse this behind
 * the compact summary.
 */
function ExtractedFieldList({
  fields,
}: {
  fields: readonly ExtractedFieldValueView[];
}) {
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
 * Compact attempt-history rows (newest first). Technical by design — engine,
 * timestamps and sanitized failure labels live here, collapsed by default.
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
      <ExtractedAttemptStatusPill status={attempt.status} />
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
 * Compact derived summary for one attempt's fields, rendered above the
 * collapsed full field list. Pending-review counts tint amber so unreviewed
 * values stay clearly unverified without opening the details.
 */
function FieldSummaryLine({
  fields,
}: {
  fields: readonly ExtractedFieldValueView[];
}) {
  const { pending, avgConfidence } = summarizeFields(fields);
  return (
    <p
      className={
        pending > 0
          ? "text-xs text-amber-800 dark:text-amber-200"
          : "text-xs text-zinc-600 dark:text-zinc-300"
      }
    >
      {fields.length} field{fields.length === 1 ? "" : "s"} extracted
      {pending > 0
        ? ` · ${pending} pending review`
        : " · none pending review"}
      {avgConfidence !== null ? ` · avg confidence ${avgConfidence}%` : ""}
    </p>
  );
}

/**
 * One document card: identity, current status, collapsed field detail and
 * attempt history — with the previous-completed branch preserved from the
 * previous layout (fields of a superseded attempt never present as current).
 */
function ExtractionDocumentCard({
  group,
}: {
  group: ExtractionDocumentView;
}) {
  const latest = group.latest;
  const current =
    latest && latest.status === "COMPLETED" && latest.fields.length > 0
      ? latest
      : null;
  const previous = current
    ? null
    : (group.attempts.find(
        (attempt) =>
          attempt.status === "COMPLETED" && attempt.fields.length > 0,
      ) ?? null);

  return (
    <section aria-label={group.documentFilename} className={cardClasses}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="break-all text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {group.documentFilename}
        </h3>
        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
          {formatDocumentTypeLabel(group.documentType)}
        </span>
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
          v{group.documentVersion}
        </span>
        {latest ? (
          <ExtractedAttemptStatusPill status={latest.status} />
        ) : (
          <span className={notRunPill}>Not run</span>
        )}
        {latest && latest.status !== "COMPLETED" && latest.errorCode ? (
          <span className="text-xs text-red-700 dark:text-red-300">
            {EXTRACTION_ERROR_LABELS[latest.errorCode] ?? latest.errorCode}
          </span>
        ) : null}
      </div>

      {current ? (
        <div className="flex flex-col gap-1.5">
          <FieldSummaryLine fields={current.fields} />
          <details className="text-xs text-zinc-600 dark:text-zinc-300">
            <summary className="cursor-pointer select-none">
              View extracted fields — attempt {current.attempt} (current)
            </summary>
            <div className="mt-2">
              <ExtractedFieldList fields={current.fields} />
            </div>
          </details>
        </div>
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          No current extracted data: the current attempt is not completed. A
          new extraction run recovers it; any previous values below are
          historical.
        </p>
      )}

      {previous ? (
        <details className="text-xs text-zinc-600 dark:text-zinc-300">
          <summary className="cursor-pointer select-none">
            Previous completed extraction — attempt {previous.attempt} (no
            longer current)
          </summary>
          <p className="mt-1 text-[11px] italic text-amber-700 dark:text-amber-300">
            Attempt {latest?.attempt} is the latest and not completed. Do not
            use these values as fresh data.
          </p>
          <div className="mt-2">
            <ExtractedFieldList fields={previous.fields} />
          </div>
        </details>
      ) : null}

      {latest ? (
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
      ) : null}
    </section>
  );
}

export function ExtractionReviewPanel({
  shipment,
  history,
  documentEntries,
  documentsUnavailable,
}: {
  shipment: Shipment;
  history: ShipmentExtractionHistoryResult;
  documentEntries: readonly ShipmentDocumentEntry[];
  documentsUnavailable: boolean;
}) {
  const activeEntries = documentEntries.filter((entry) => entry.isActive);
  const groupFor = (documentId: string): ExtractionDocumentView | null =>
    history.status === "success"
      ? (history.documents.find((group) => group.documentId === documentId) ??
        null)
      : null;

  return (
    <div className="flex flex-col gap-6">
      {/* 1. Extraction status overview — one compact row per active document. */}
      <section aria-label="Extraction overview" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Extraction status
        </h2>
        {documentsUnavailable ? (
          <p className={noticeClasses}>
            Document data could not be loaded, so the per-document status
            summary is hidden. The per-document cards below remain available.
          </p>
        ) : activeEntries.length === 0 ? (
          <p className={noticeClasses}>
            No active documents yet — upload them in the Documents tab before
            running extraction.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {activeEntries.map((entry) => {
              const group = groupFor(entry.id);
              return (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs text-zinc-600 dark:text-zinc-300"
                >
                  <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                    {formatDocumentTypeLabel(entry.documentType)}
                  </span>
                  <span className="break-all">{entry.originalFilename}</span>
                  {group?.latest ? (
                    <ExtractedAttemptStatusPill status={group.latest.status} />
                  ) : (
                    <span className={notRunPill}>Not run</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* 2. Run action — existing client panel, preserved untouched. */}
      <section aria-label="Run extraction" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Run extraction
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          One AI request per active document; the resulting run becomes the
          current attempt. Values flagged pending review need human
          confirmation before approval.
        </p>
        <ExtractionPanel
          shipmentId={shipment.id}
          canRun={(EXTRACTION_ELIGIBLE_STATUSES as readonly string[]).includes(
            shipment.status,
          )}
          currentStatus={shipment.status}
        />
      </section>

      {/* 3. Per-document results. */}
      <section
        aria-label="Per-document extraction results"
        className="flex flex-col gap-3"
      >
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Extracted values
        </h2>
        {history.status !== "success" ? (
          <p className={noticeClasses}>
            Extraction data could not be loaded. Please try again.
          </p>
        ) : history.documents.length === 0 ? (
          <p className={noticeClasses}>
            No extraction attempts yet. Run extraction to pull values from the
            active documents.
          </p>
        ) : (
          history.documents.map((group) => (
            <ExtractionDocumentCard key={group.documentId} group={group} />
          ))
        )}
      </section>
    </div>
  );
}
