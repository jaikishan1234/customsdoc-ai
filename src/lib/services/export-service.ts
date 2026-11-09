import "server-only";

/**
 * CSV EXPORT service — the ONLY sanctioned writer of the
 * APPROVED -> EXPORTED shipment transition (`exportedAt` + `exportedBy`
 * stamping) and the builder of the deterministic customs CSV.
 *
 * Export permission (evaluated fresh from the database, never from a cached
 * view) requires ALL of:
 *   1. the shipment's status is APPROVED (re-exporting an EXPORTED shipment
 *      is refused — the stamp is one-shot history);
 *   2. no readiness blocker exists, via `evaluateShipmentReadiness` (the same
 *      engine the approval API enforces): all three required document types
 *      ACTIVE, every active document's LATEST attempt (max(attempt) across
 *      ALL statuses, never a fallback to an older COMPLETED one) COMPLETED,
 *      all catalog-required fields ACCEPTED or CORRECTED, and no OPEN /
 *      RECHECK_PENDING discrepancy;
 *   3. a LIVE approval row exists and is APPROVED (a PENDING decision must be
 *      decided first);
 *   4. no evidence drift: `evaluateApprovalSnapshotFreshness` (the committed
 *      invalidation gate) proves the approved decision's frozen snapshot
 *      still matches the current active documents and latest attempts.
 *
 * The CSV content follows the approved decision's snapshot pairing (document
 * -> current extraction attempt): one row per extracted field of those
 * attempts, with the EFFECTIVE value — the latest field correction's
 * `correctedValue` for CORRECTED fields (max(correctedAt, id), the same rule
 * the check service reads), the immutable extraction value otherwise. A row
 * carries review state only; internal ids, checksums, storage keys and raw
 * snapshots never appear in the output or the logs.
 *
 * Encoding: RFC 4180-compatible, CRLF line endings, UTF-8, quoting only when
 * needed. A value that a spreadsheet could evaluate as a formula (leading
 * `=`, `+`, `-`, `@`, tab or CR) is neutralized with a leading `'` per the
 * conventional CSV-injection guidance — a deliberate trade-off that also
 * touches legitimate negative numbers.
 *
 * Failure policy mirrors the other services (neon-http, no transactions):
 * the CSV is BUILT first, the guarded one-shot stamp is applied second, the
 * EXPORT_COMPLETED audit row is appended last. A failed audit write is
 * reported to the caller (`auditWriteFailed`) without rolling back or
 * retrying anything — the response must never claim a complete trail that
 * does not exist.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  approvals,
  extractedFields,
  fieldCorrections,
  shipments,
  type ApprovalSnapshot,
} from "@/lib/db/schema";
import {
  evaluateShipmentReadiness,
  type ApprovalBlocker,
} from "./approval-service";
import {
  evaluateApprovalSnapshotFreshness,
  type SnapshotDriftCode,
} from "./approval-invalidation-service";
import {
  appendAuditLog,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AuditActor,
} from "./audit-service";

// ---------------------------------------------------------------------------
// Constants and contracts
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same reference rule as the DB CHECK `shipments_reference_fmt`; a matching
 * reference is filename-safe (letters, digits, hyphen only). */
export const SHIPMENT_REFERENCE_PATTERN = /^SHP-[0-9]{4,10}$/;

/** Document types the CSV covers, in pgEnum declaration order. */
const REQUIRED_DOCUMENT_TYPES = [
  "INVOICE",
  "PACKING_LIST",
  "BILL_OF_LADING",
] as const;

type DocumentEntryType = (typeof REQUIRED_DOCUMENT_TYPES)[number];

/** Client-safe, structured reasons an export is blocked (constants only). */
export type ExportBlocker =
  | {
      code: "shipment_status";
      currentStatus: string;
      detail: "not_approved" | "already_exported";
    }
  /** No live approval decision exists at all. */
  | { code: "no_approved_decision" }
  /** A live PENDING decision exists — decide it first. */
  | { code: "decision_pending" }
  /** The approved decision's frozen evidence no longer matches the current
   * documents/attempts (drift codes only — never the values). */
  | { code: "snapshot_stale"; driftCodes: readonly SnapshotDriftCode[] }
  /** The freshness gate could not run — export is refused rather than
   * performed on an unverifiable decision. */
  | { code: "freshness_unavailable" }
  /** Readiness blockers exist (same list the approval API reports). */
  | { code: "not_ready"; blockers: readonly ApprovalBlocker[] };

/** Result of the export permission evaluation (read-only). */
export type ExportEvaluation =
  | { status: "ready" }
  | { status: "blocked"; blocker: ExportBlocker }
  | { status: "not_found" }
  | { status: "unavailable" };

/** Result of building the CSV (read-only; stamps nothing). */
export type CsvBuildResult =
  | {
      status: "built";
      /** Full file content (header + rows), CRLF line endings throughout. */
      csv: string;
      /** Number of data rows (the header is excluded). */
      rowCount: number;
      /** The shipment reference (validated format; used for the filename). */
      reference: string;
    }
  | { status: "not_found" }
  | { status: "no_approved_decision" }
  | { status: "unavailable" };

/** Result of the guarded one-shot stamp (the only shipment write here). */
export type ExportStampResult =
  | { status: "stamped"; exportedAt: Date }
  /** The shipment status changed concurrently; nothing was modified. */
  | { status: "no_longer_approved"; currentStatus: string | null }
  | { status: "unavailable" };

// ---------------------------------------------------------------------------
// Export permission evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether one shipment may be exported right now. Read-only and
 * non-throwing by contract; every failure maps to a typed outcome. The
 * export route re-enforces the APPROVED status at write time with a guarded
 * stamp, so a race between this evaluation and the stamp cannot over-export.
 */
export async function evaluateExportReadiness(
  shipmentId: unknown,
): Promise<ExportEvaluation> {
  const sid = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(sid)) {
    return { status: "not_found" };
  }

  // --- 1. Readiness (documents, attempts, required fields, discrepancies) ---
  const readiness = await evaluateShipmentReadiness(sid);
  if (readiness.status === "not_found") {
    return { status: "not_found" };
  }
  if (readiness.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (readiness.shipmentStatus !== "APPROVED") {
    return {
      status: "blocked",
      blocker: {
        code: "shipment_status",
        currentStatus: readiness.shipmentStatus,
        detail:
          readiness.shipmentStatus === "EXPORTED"
            ? "already_exported"
            : "not_approved",
      },
    };
  }
  if (!readiness.ready || readiness.snapshot === null) {
    // `ready === true` with a null snapshot cannot happen by contract;
    // treated defensively as unavailable rather than inventing content.
    if (readiness.ready) {
      console.error(
        `[export-service] Readiness reported ready without a snapshot ` +
          `(shipmentId=${sid}).`,
      );
      return { status: "unavailable" };
    }
    return {
      status: "blocked",
      blocker: { code: "not_ready", blockers: readiness.blockers },
    };
  }

  // --- 2. A live decision must exist and be APPROVED ------------------------
  let liveStatus: "PENDING" | "APPROVED";
  try {
    const rows = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(
        and(
          eq(approvals.shipmentId, sid),
          // `approvals_live_uq` guarantees at most one such row.
          inArray(approvals.status, ["PENDING", "APPROVED"]),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      return { status: "blocked", blocker: { code: "no_approved_decision" } };
    }
    if (rows[0].status === "PENDING") {
      return { status: "blocked", blocker: { code: "decision_pending" } };
    }
    if (rows[0].status !== "APPROVED") {
      // Defensive: the WHERE clause above excludes this, but never guess.
      console.error(
        `[export-service] Live approval row is not APPROVED ` +
          `(shipmentId=${sid}).`,
      );
      return { status: "blocked", blocker: { code: "no_approved_decision" } };
    }
    liveStatus = rows[0].status;
  } catch {
    console.error(
      `[export-service] Failed to read the live approval row (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }

  // --- 3. Evidence freshness (the committed invalidation gate) --------------
  const freshness = await evaluateApprovalSnapshotFreshness(sid);
  if (freshness.status === "unavailable") {
    return { status: "blocked", blocker: { code: "freshness_unavailable" } };
  }
  if (freshness.status !== "evaluated") {
    // not_found / no_live_approval contradict the read above; refuse rather
    // than guess which one is true.
    console.error(
      `[export-service] Freshness contradicted the live read ` +
        `(shipmentId=${sid}, live=${liveStatus}, freshness=${freshness.status}).`,
    );
    return { status: "blocked", blocker: { code: "no_approved_decision" } };
  }
  if (!freshness.fresh) {
    return {
      status: "blocked",
      blocker: { code: "snapshot_stale", driftCodes: freshness.driftCodes },
    };
  }

  return { status: "ready" };
}

// ---------------------------------------------------------------------------
// CSV construction
// ---------------------------------------------------------------------------

/** The exact CSV header, in column order. */
const CSV_HEADER = [
  "shipment_reference",
  "document_type",
  "document_version",
  "field_key",
  "field_label",
  "value",
  "unit",
  "confidence",
  "review_status",
] as const;

/**
 * Encode one CSV cell: quote only when needed (comma, double quote, CR or LF
 * inside), doubling inner quotes per RFC 4180, and neutralize values a
 * spreadsheet would evaluate (leading `=`, `+`, `-`, `@`, tab or CR) by
 * prefixing a single quote.
 */
const csvCell = (raw: string): string => {
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}'` : raw;
  return /[",\r\n]/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
};

/** One structurally validated snapshot document entry. */
type SnapshotDocument = {
  documentId: string;
  documentType: DocumentEntryType;
  version: number;
};

/** One snapshot pairing: the approved attempt per document. */
type SnapshotPairing = { documentId: string; extractionId: string };

type ParsedSnapshot = {
  documents: SnapshotDocument[];
  pairings: SnapshotPairing[];
};

/**
 * Defensive structural validation of the stored snapshot JSONB (the same
 * shape rules the invalidation service applies). Returns null when unusable.
 */
const parseSnapshot = (raw: unknown): ParsedSnapshot | null => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<ApprovalSnapshot>;
  if (
    !Array.isArray(candidate.documents) ||
    !Array.isArray(candidate.extractions)
  ) {
    return null;
  }

  const documents: SnapshotDocument[] = [];
  for (const doc of candidate.documents) {
    if (doc === null || typeof doc !== "object") return null;
    const documentId = doc.documentId;
    const documentType = doc.documentType;
    const version = doc.version;
    if (
      typeof documentId !== "string" ||
      documentId.length === 0 ||
      !REQUIRED_DOCUMENT_TYPES.includes(documentType) ||
      typeof version !== "number" ||
      version < 1
    ) {
      return null;
    }
    documents.push({ documentId, documentType, version });
  }

  const pairings: SnapshotPairing[] = [];
  for (const pair of candidate.extractions) {
    if (pair === null || typeof pair !== "object") return null;
    const documentId = pair.documentId;
    const extractionId = pair.extractionId;
    if (
      typeof documentId !== "string" ||
      documentId.length === 0 ||
      typeof extractionId !== "string" ||
      extractionId.length === 0
    ) {
      return null;
    }
    pairings.push({ documentId, extractionId });
  }
  return { documents, pairings };
};

/** Codepoint comparison — deterministic across runtimes, unlike localeCompare. */
const compareByFieldKey = (
  first: { fieldKey: string },
  second: { fieldKey: string },
): number =>
  first.fieldKey === second.fieldKey
    ? 0
    : first.fieldKey < second.fieldKey
      ? -1
      : 1;

/**
 * Build the full CSV for one APPROVED shipment from the approved decision's
 * frozen pairing. Read-only — it stamps nothing and may be called again.
 * Any inconsistency (missing snapshot piece, a CORRECTED field without a
 * stored correction) aborts with a typed failure instead of exporting
 * approximate data.
 */
export async function buildShipmentCsv(
  shipmentId: unknown,
): Promise<CsvBuildResult> {
  const sid = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(sid)) {
    return { status: "not_found" };
  }

  // --- 1. Shipment reference + approved snapshot (single joined read) -------
  let reference: string;
  let snapshotRaw: unknown;
  try {
    const rows = await db
      .select({
        reference: shipments.reference,
        approvalSnapshot: approvals.approvalSnapshot,
      })
      .from(approvals)
      .innerJoin(shipments, eq(approvals.shipmentId, shipments.id))
      .where(
        and(eq(approvals.shipmentId, sid), eq(approvals.status, "APPROVED")),
      )
      .limit(1);
    if (!rows[0]) {
      return { status: "no_approved_decision" };
    }
    reference = rows[0].reference;
    snapshotRaw = rows[0].approvalSnapshot;
  } catch {
    console.error(
      `[export-service] Failed to read the approved snapshot ` +
        `(shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }

  const snapshot = parseSnapshot(snapshotRaw);
  if (snapshot === null) {
    console.error(
      `[export-service] Approved snapshot is structurally unusable ` +
        `(shipmentId=${sid}) — freshness should have flagged this as drift.`,
    );
    return { status: "unavailable" };
  }
  const missingTypes = REQUIRED_DOCUMENT_TYPES.filter(
    (documentType) =>
      !snapshot.documents.some((doc) => doc.documentType === documentType),
  );
  if (missingTypes.length > 0) {
    console.error(
      `[export-service] Approved snapshot lacks required document types ` +
        `(shipmentId=${sid}) — freshness should have flagged this as drift.`,
    );
    return { status: "unavailable" };
  }

  // --- 2. Fields of the approved attempts -----------------------------------
  const extractionIds = snapshot.pairings.map((pair) => pair.extractionId);
  if (extractionIds.length === 0) {
    console.error(
      `[export-service] Approved snapshot has no extractions ` +
        `(shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }

  type FieldRow = {
    id: string;
    extractionId: string;
    fieldKey: string;
    fieldLabel: string;
    parsedValue: string | null;
    rawValue: string | null;
    unit: string | null;
    confidence: string;
    reviewStatus: "PENDING_REVIEW" | "ACCEPTED" | "CORRECTED";
  };
  let fieldRows: FieldRow[];
  try {
    fieldRows = await db
      .select({
        id: extractedFields.id,
        extractionId: extractedFields.extractionId,
        fieldKey: extractedFields.fieldKey,
        fieldLabel: extractedFields.fieldLabel,
        parsedValue: extractedFields.parsedValue,
        rawValue: extractedFields.rawValue,
        unit: extractedFields.unit,
        confidence: extractedFields.confidence,
        reviewStatus: extractedFields.reviewStatus,
      })
      .from(extractedFields)
      .where(
        and(
          eq(extractedFields.shipmentId, sid),
          inArray(extractedFields.extractionId, extractionIds),
        ),
      );
  } catch {
    console.error(
      `[export-service] Failed to read exported fields (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }

  // --- 3. Latest correction per field: max(correctedAt, id) ----------------
  // The check and correction services use the same rule; ties keep the max id.
  const latestCorrectionByField = new Map<string, string>();
  if (fieldRows.length > 0) {
    const fieldIds = fieldRows.map((row) => row.id);
    try {
      const correctionRows = await db
        .select({
          fieldId: fieldCorrections.fieldId,
          correctedValue: fieldCorrections.correctedValue,
        })
        .from(fieldCorrections)
        .where(inArray(fieldCorrections.fieldId, fieldIds))
        .orderBy(desc(fieldCorrections.correctedAt), desc(fieldCorrections.id));
      for (const row of correctionRows) {
        if (!latestCorrectionByField.has(row.fieldId)) {
          latestCorrectionByField.set(row.fieldId, row.correctedValue);
        }
      }
    } catch {
      console.error(
        `[export-service] Failed to read field corrections (shipmentId=${sid}).`,
      );
      return { status: "unavailable" };
    }
  }

  // --- 4. Effective value per field ----------------------------------------
  // CORRECTED rows export the latest correction; anything else exports the
  // immutable extraction value. A CORRECTED row without its correction row is
  // an inconsistency — refuse rather than export the original value while
  // displaying a CORRECTED review state.
  const effectiveValue = (row: FieldRow): string | null => {
    if (row.reviewStatus === "CORRECTED") {
      const corrected = latestCorrectionByField.get(row.id) ?? null;
      if (corrected === null) {
        console.error(
          `[export-service] CORRECTED field without a correction row ` +
            `(shipmentId=${sid}) — export refused.`,
        );
        return null;
      }
      return corrected;
    }
    return row.parsedValue ?? row.rawValue ?? "";
  };

  const fieldsByExtraction = new Map<string, FieldRow[]>();
  for (const row of fieldRows) {
    const group = fieldsByExtraction.get(row.extractionId);
    if (group) {
      group.push(row);
    } else {
      fieldsByExtraction.set(row.extractionId, [row]);
    }
  }

  // --- 5. Compose rows: documents in pgEnum order, fields alphabetical ------
  const parseFailure: CsvBuildResult = { status: "unavailable" };
  const dataRows: string[] = [];
  for (const documentType of REQUIRED_DOCUMENT_TYPES) {
    const doc = snapshot.documents.find(
      (candidate) => candidate.documentType === documentType,
    );
    if (!doc) continue; // unreachable: missing types were rejected in step 1
    const pair = snapshot.pairings.find(
      (candidate) => candidate.documentId === doc.documentId,
    );
    if (!pair) {
      console.error(
        `[export-service] Snapshot pairing missing for a document ` +
          `(shipmentId=${sid}) — export refused.`,
      );
      return parseFailure;
    }
    const fields = (fieldsByExtraction.get(pair.extractionId) ?? [])
      .slice()
      .sort(compareByFieldKey);
    for (const field of fields) {
      const value = effectiveValue(field);
      if (value === null) return parseFailure;
      dataRows.push(
        [
          csvCell(reference),
          csvCell(doc.documentType),
          csvCell(String(doc.version)),
          csvCell(field.fieldKey),
          csvCell(field.fieldLabel),
          csvCell(value),
          csvCell(field.unit ?? ""),
          csvCell(field.confidence),
          csvCell(field.reviewStatus),
        ].join(","),
      );
    }
  }

  const csv = [CSV_HEADER.join(","), ...dataRows].join("\r\n") + "\r\n";
  return {
    status: "built",
    csv,
    rowCount: dataRows.length,
    reference,
  };
}

// ---------------------------------------------------------------------------
// One-shot status stamp
// ---------------------------------------------------------------------------

/** Shipment status payload for the honest post-race message. */
const readShipmentStatus = async (
  sid: string,
): Promise<string | null> => {
  try {
    const rows = await db
      .select({ status: shipments.status })
      .from(shipments)
      .where(eq(shipments.id, sid))
      .limit(1);
    return rows[0]?.status ?? null;
  } catch {
    return null;
  }
};

/**
 * Stamp the export exactly once: `APPROVED -> EXPORTED` guarded on the
 * current status, setting `exportedAt` + `exportedBy` together as the
 * CHECK `shipments_export_consistency` requires. A concurrent export (or any
 * other transition) makes the second statement match zero rows — it can
 * never produce a second success.
 */
export async function stampShipmentExported(
  shipmentId: unknown,
  actorId: string,
): Promise<ExportStampResult> {
  const sid = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(sid)) {
    return { status: "unavailable" };
  }
  if (actorId.trim().length === 0) {
    console.error("[export-service] Export stamping requires an actor.");
    return { status: "unavailable" };
  }

  const exportedAt = new Date();
  try {
    const updated = await db
      .update(shipments)
      .set({ status: "EXPORTED", exportedAt, exportedBy: actorId.trim() })
      .where(and(eq(shipments.id, sid), eq(shipments.status, "APPROVED")))
      .returning({ id: shipments.id });
    if (updated.length > 0) {
      return { status: "stamped", exportedAt };
    }
  } catch {
    console.error(
      `[export-service] Guarded export stamp failed (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }

  const currentStatus = await readShipmentStatus(sid);
  console.error(
    `[export-service] Export stamp matched no APPROVED row ` +
      `(shipmentId=${sid}, currentStatus=${currentStatus ?? "unknown"}).`,
  );
  return { status: "no_longer_approved", currentStatus };
}

// ---------------------------------------------------------------------------
// Audit (partial-success policy)
// ---------------------------------------------------------------------------

/**
 * Append the EXPORT_COMPLETED audit event. Fire-and-forget is NOT allowed —
 * the caller awaits this and owns the failure policy: `auditWriteFailed`
 * must be surfaced (a CSV response cannot carry a JSON warning body, so the
 * route reports it via a dedicated response header); nothing is rolled back
 * or retried. Details carry the row count, the exact stamped instant and the
 * reference — never field values, checksums or snapshot payloads.
 */
export async function appendExportAudit(
  input: {
    shipmentId: string;
    reference: string;
    rowCount: number;
    exportedAt: Date;
  },
  actorId: AuditActor,
): Promise<boolean> {
  try {
    await appendAuditLog({
      action: AUDIT_ACTIONS.exportCompleted,
      entityType: AUDIT_ENTITY_TYPES.shipment,
      entityId: input.shipmentId,
      actorId,
      shipmentId: input.shipmentId,
      details: {
        shipmentReference: input.reference,
        rowCount: input.rowCount,
        exportedAt: input.exportedAt.toISOString(),
      },
    });
    return true;
  } catch {
    console.error(
      "[export-service] EXPORT_COMPLETED audit write failed " +
        `(shipmentId=${input.shipmentId}) — audit trail requires manual backfill.`,
    );
    return false;
  }
}
