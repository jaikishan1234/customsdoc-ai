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

/**
 * Mirrors the service-side degraded marker (kept local: this is a client
 * module and must not import the server-only discrepancy service).
 */
const STATE_CHANGE_NOT_APPLIED = "state_change_not_applied";

/**
 * Display labels for the invalidation trigger reason (approval service
 * vocabulary — kept local, same pattern as the discrepancy reasons above).
 */
const APPROVAL_INVALIDATION_REASON_LABELS: Record<string, string> = {
  document_replaced: "a document was replaced",
  evidence_re_extracted: "a new extraction attempt ran",
  field_corrected: "a field value was corrected",
  discrepancy_open: "a discrepancy became open",
  discrepancy_recheck_pending: "a discrepancy was set for re-check",
  snapshot_drift: "approved evidence drifted",
};

/** Display labels for the coarse snapshot-drift codes. */
export const SNAPSHOT_DRIFT_CODE_LABELS: Record<string, string> = {
  document_missing: "a required document version is gone",
  document_version_changed: "a document version changed",
  document_checksum_changed: "a document's content changed",
  attempt_superseded: "extraction attempts were re-run",
  attempt_not_completed: "a current extraction attempt is not complete",
  snapshot_malformed: "the recorded evidence snapshot is unusable",
  approved_state_missing: "the approved state had no approval record",
};

/** Safely reads a JSON-safe string array from a details payload. */
const detailStringArray = (details: unknown, key: string): string[] | null => {
  if (
    details === null ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    return null;
  }
  const value = (details as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return null;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : null;
};

/**
 * Display labels for the action an AUDIT_RECOVERED marker vouches for. A map
 * keeps the timeline readable ("field value correction") instead of printing
 * the raw action code or the referenced row's identifiers.
 */
const RECOVERED_ACTION_LABELS: Record<string, string> = {
  [AUDIT_ACTIONS.shipmentCreate]: "shipment creation",
  [AUDIT_ACTIONS.documentUpload]: "document upload",
  [AUDIT_ACTIONS.extractionRun]: "extraction run",
  [AUDIT_ACTIONS.fieldCorrected]: "field value correction",
  [AUDIT_ACTIONS.fieldAccepted]: "field value acceptance",
  [AUDIT_ACTIONS.discrepancyReevaluated]: "discrepancy re-evaluation",
  [AUDIT_ACTIONS.approvalInvalidated]: "approval invalidation",
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

  if (entry.action === AUDIT_ACTIONS.fieldAccepted) {
    // Strict whitelist: label, accepted value and unit only. fieldId,
    // extractionId and reviewStatusBefore are never rendered; the accepting
    // actor lives solely on the audit row's own actorId column.
    const fieldLabel = detailString(details, "fieldLabel");
    const value = detailString(details, "value");
    const unit = detailString(details, "unit");
    const parts: string[] = [];
    if (fieldLabel !== null) parts.push(fieldLabel);
    if (value !== null) parts.push(`${value}${unit ? ` ${unit}` : ""}`);
    return { label: "Field value accepted", parts };
  }

  if (entry.action === AUDIT_ACTIONS.fieldCorrected) {
    // Strict whitelist: only the correction snapshot's display-relevant keys
    // are read from the JSONB payload (label, unit, original/corrected
    // values, reason). fieldId/extractionId/reviewStatusBefore and unknown
    // keys are never rendered; the correcting actor lives solely on the
    // audit row's own actorId column and is never displayed.
    const fieldLabel = detailString(details, "fieldLabel");
    const original = detailString(details, "originalValue");
    const corrected = detailString(details, "correctedValue");
    const unit = detailString(details, "unit");
    const reason = detailString(details, "reason");
    const parts: string[] = [];
    if (fieldLabel !== null) parts.push(fieldLabel);
    if (original !== null && corrected !== null) {
      parts.push(`${original} → ${corrected}${unit ? ` ${unit}` : ""}`);
    } else if (corrected !== null) {
      parts.push(`to ${corrected}${unit ? ` ${unit}` : ""}`);
    }
    if (reason !== null) parts.push(`reason: ${reason}`);
    return { label: "Field value corrected", parts };
  }

  if (entry.action === AUDIT_ACTIONS.approvalInvalidated) {
    // Strict whitelist: the trigger reason and drift codes (both mapped
    // from the service's constant vocabulary), and the decision/shipment
    // status transition. Unknown codes are omitted rather than printed
    // verbatim; checksums, snapshot ids and actor ids are never rendered —
    // the acting session lives solely on the audit row's actorId column.
    const parts: string[] = [];
    const reason = detailString(details, "reason");
    const mappedReason =
      reason !== null
        ? APPROVAL_INVALIDATION_REASON_LABELS[reason]
        : undefined;
    if (mappedReason !== undefined) parts.push(`because ${mappedReason}`);
    const statusBefore = detailString(details, "shipmentStatusBefore");
    const statusAfter = detailString(details, "shipmentStatusAfter");
    if (statusBefore && statusAfter && statusBefore !== statusAfter) {
      parts.push(`shipment ${statusBefore} → ${statusAfter}`);
    }
    const driftCodes = detailStringArray(details, "driftCodes");
    if (driftCodes !== null) {
      for (const code of driftCodes) {
        const label = SNAPSHOT_DRIFT_CODE_LABELS[code];
        if (label !== undefined) parts.push(label);
      }
    }
    const degraded = detailString(details, "stateChangeNotApplied");
    if (degraded !== null) {
      parts.push("audited state change did not apply");
    }
    return { label: "Approval invalidated", parts };
  }

  if (entry.action === AUDIT_ACTIONS.auditRecovered) {
    // Whitelist: the recovered action's label, the recovery timestamp and the
    // operator note. The referenced audit row id (entity_id) and every other
    // payload key are never rendered.
    const recoveredAction = detailString(details, "recoveredAction");
    const recoveredAt = detailString(details, "recoveredAt");
    const note = detailString(details, "note");
    const parts: string[] = [];
    const recoveredLabel =
      recoveredAction !== null
        ? RECOVERED_ACTION_LABELS[recoveredAction]
        : undefined;
    if (recoveredLabel !== undefined) parts.push(recoveredLabel);
    if (recoveredAt !== null) {
      const recoveredDate = new Date(recoveredAt);
      if (!Number.isNaN(recoveredDate.getTime())) {
        parts.push(`recovered ${formatLongDateTimeUtc(recoveredDate, "UTC")}`);
      }
    }
    if (note !== null) parts.push(note);
    return { label: "Audit entry recovered", parts };
  }

  if (entry.action === AUDIT_ACTIONS.discrepancyReevaluated) {
    // Strict whitelist: only `change` and `reason` are read from the JSONB
    // payload; the before/after snapshots, checkRunKey and any other keys
    // (including on future changes) are NEVER rendered wholesale. The reason
    // strings themselves are constant service vocabulary — mapped to labels,
    // with unknown reasons omitted rather than printed verbatim.
    const change = detailString(details, "change");
    const reason = detailString(details, "reason");
    const reasonLabels: Record<string, string> = {
      MISMATCH_DETECTED: "mismatch detected",
      EVIDENCE_CHANGED: "evidence changed",
      VALUES_EQUAL: "confirmed values equal",
      EVIDENCE_UNAVAILABLE: "evidence unavailable",
      DUPLICATE_LIVE_ROW: "duplicate live record",
    };
    const parts: string[] = [];
    const mappedReason = reason !== null ? reasonLabels[reason] : undefined;
    if (mappedReason !== undefined) parts.push(mappedReason);
    // Degraded audit entries are explicit: either an evidence snapshot that
    // needs backfill, or an audit-first change whose guarded update did not
    // apply. Both are stated plainly; neither is silently hidden.
    const degraded = detailString(details, "degraded");
    if (degraded !== null) {
      parts.push(
        degraded === STATE_CHANGE_NOT_APPLIED
          ? "audited state change did not apply"
          : "evidence snapshot needs backfill",
      );
    }

    switch (change) {
      case "CREATED":
        return { label: "Discrepancy detected", parts };
      case "UPDATED":
        return { label: "Discrepancy re-evaluated", parts };
      case "OBSOLETED":
        return { label: "Discrepancy closed as obsolete", parts };
      case "RECHECK_PENDING":
        return { label: "Discrepancy set for re-check", parts };
      case "RESOLVED":
        return { label: "Discrepancy resolved", parts };
      case "WAIVED":
        return { label: "Discrepancy waived", parts };
      default:
        // Unknown future change values: the generic label still shows, never
        // the raw JSON payload.
        return { label: "Discrepancy re-evaluated", parts };
    }
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
