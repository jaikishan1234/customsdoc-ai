/**
 * Activity tab content — the append-only audit trail re-rendered as an
 * operational timeline.
 *
 * Presentation rules:
 * - Known actions map to readable event labels; the raw action code is shown
 *   only for UNKNOWN future actions (so new enum entries are never hidden).
 * - Details payloads render through a strict whitelist projection purpose-
 *   built per action: storage keys, SHA-256 checksums and internal user IDs
 *   are NEVER rendered. Keys outside the whitelist (including on unknown
 *   actions) are likewise omitted.
 * - Actor handling: audit rows only carry actor IDs. The raw ID is never
 *   rendered; a null actor is shown as "system". (Actor names would require
 *   a new read-service join — reported as a known limitation, not invented.)
 * - No audit data is filtered, rewritten or dropped: every entry stays in
 *   the list; only the *rendered text* per entry is minimized.
 */
import { formatLongDateTimeUtc } from "@/lib/date-display";
import { formatDocumentTypeLabel } from "@/lib/document-display";
import { AUDIT_ACTIONS } from "@/lib/services/audit-service";
import type { ShipmentAuditEntry } from "@/lib/services/shipment-service";

import { EXTRACTION_ERROR_LABELS } from "./extraction-review-panel";

export interface AuditEntryDescription {
  label: string;
  /** Short human-readable context parts, joined with " · ". */
  parts: readonly string[];
}

/** Safely reads a JSON-safe string/number property from a details payload. */
const detailString = (
  details: unknown,
  key: string,
): string | null => {
  if (
    details === null ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    return null;
  }
  const value = (details as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

const documentTypePart = (details: unknown): string | null => {
  const raw = detailString(details, "documentType");
  return raw === null
    ? null
    : formatDocumentTypeLabel(
        raw as Parameters<typeof formatDocumentTypeLabel>[0],
      );
};

/**
 * Project ONE audit entry to its display shape. Pure and side-effect free;
 * also used by the Overview tab for the recent-activity summary so both
 * presentations stay consistent.
 */
export const describeAuditEntry = (
  entry: ShipmentAuditEntry,
): AuditEntryDescription => {
  const details = entry.details;

  if (entry.action === AUDIT_ACTIONS.shipmentCreate) {
    return { label: "Shipment created", parts: [] };
  }

  if (entry.action === AUDIT_ACTIONS.documentUpload) {
    const parts: string[] = [];
    const typePart = documentTypePart(details);
    const version = detailString(details, "version");
    if (typePart !== null) parts.push(typePart);
    if (version !== null) parts.push(`version ${version}`);
    // replacedVersionId is an internal UUID — only its PRESENCE is rendered.
    const replaced =
      details !== null &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      (details as Record<string, unknown>).replacedVersionId != null;
    parts.push(replaced ? "replaced an earlier version" : "initial upload");
    return { label: "Document uploaded", parts };
  }

  if (entry.action === AUDIT_ACTIONS.extractionRun) {
    const status = detailString(details, "status");
    const baseParts: string[] = [];
    const typePart = documentTypePart(details);
    if (typePart !== null) baseParts.push(typePart);
    const version = detailString(details, "version");
    if (version !== null) baseParts.push(`version ${version}`);
    const attempt = detailString(details, "attempt");
    if (attempt !== null) baseParts.push(`attempt ${attempt}`);

    if (status === "COMPLETED") {
      const fieldCount = detailString(details, "fieldCount");
      if (fieldCount !== null) {
        baseParts.push(
          `${fieldCount} field${fieldCount === "1" ? "" : "s"} extracted`,
        );
      }
      const missing = detailString(details, "missingRequiredKeys");
      if (missing !== null) baseParts.push(`${missing} required key(s) missing`);
      return { label: "Extraction completed", parts: baseParts };
    }
    if (status === "FAILED") {
      const errorCode = detailString(details, "errorCode");
      if (errorCode !== null) {
        baseParts.push(EXTRACTION_ERROR_LABELS[errorCode] ?? `error ${errorCode}`);
      }
      return { label: "Extraction failed", parts: baseParts };
    }
    if (status !== null) baseParts.push(status.toLowerCase());
    return { label: "Extraction run", parts: baseParts };
  }

  // Unknown/future action: show the raw action code (never hidden) plus a
  // safe whitelist of detail keys; anything non-whitelisted is omitted.
  const parts: string[] = [];
  const typePart = documentTypePart(details);
  if (typePart !== null) parts.push(typePart);
  for (const key of ["version", "attempt", "status", "fieldCount"] as const) {
    const value = detailString(details, key);
    if (value !== null) parts.push(`${key} ${value}`);
  }
  return { label: entry.action, parts };
};

export function ActivityPanel({
  auditTrail,
}: {
  auditTrail: readonly ShipmentAuditEntry[];
}) {
  if (auditTrail.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
        No activity recorded yet for this shipment.
      </p>
    );
  }

  return (
    <section aria-label="Activity" className="flex flex-col gap-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Append-only activity trail (newest first, latest 50 entries).
      </p>
      <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
        {auditTrail.map((entry) => {
          const description = describeAuditEntry(entry);
          return (
            <li key={entry.id} className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                  {description.label}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {formatLongDateTimeUtc(entry.performedAt, "UTC")}
                </span>
                {entry.actorId === null ? (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    system
                  </span>
                ) : null}
              </div>
              {description.parts.length > 0 ? (
                <p className="text-xs text-zinc-600 dark:text-zinc-300">
                  {description.parts.join(" · ")}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
