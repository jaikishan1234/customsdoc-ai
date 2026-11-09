import "server-only";

/**
 * Field ACCEPTANCE service — the ONLY sanctioned writer of the
 * PENDING_REVIEW -> ACCEPTED transition on `extracted_fields`.
 *
 * This is deliberately narrower than correction: accepting a value asserts
 * that a human reviewed the ORIGINAL extraction snapshot as correct. The
 * service therefore:
 *   1. validates the shipment/field ids and loads the field with its
 *      extraction and document (explicit verification of the
 *      (field, extraction, shipment) triple);
 *   2. requires the owning document to be ACTIVE and the owning shipment not
 *      yet EXPORTED (CSV export stage: exported records stay final);
 *   3. requires the field's extraction to be the document's CURRENT attempt
 *      (max(attempt) across ALL statuses — the same freshness law the
 *      correction, check and read services use) and that attempt COMPLETED;
 *   4. requires the field to still be PENDING_REVIEW (already reviewed values
 *      are never re-flagged by this service);
 *   5. requires a usable value: a non-empty parsed value that still validates
 *      against the field's catalog kind (numeric/integer/date/text). Missing
 *      or invalid values are refused rather than accepted;
 *   6. flips reviewStatus via a guarded update that re-asserts the full
 *      triple AND `review_status = 'PENDING_REVIEW'` — concurrent acceptance
 *      or a correction therefore wins exactly once, and a lost race maps to
 *      a typed conflict instead of a silent success;
 *   7. appends a FIELD_ACCEPTED audit row (review snapshot only; the actor
 *      lives on the audit row's actorId column and is never duplicated into
 *      details).
 *
 * Value immutability: rawValue/parsedValue/numericValue/confidence are never
 * written. No correction row is created and no discrepancy re-evaluation is
 * triggered — acceptance changes review state only, never evidence.
 *
 * Failure policy mirrors the other services (neon-http, no transactions): a
 * failed AUDIT write after the acceptance landed is reported as
 * `auditWriteFailed: true`; nothing is rolled back and nothing is retried.
 */

import { and, desc, eq } from "drizzle-orm";

import {
  getExtractionFieldCatalog,
  type ExtractionFieldKind,
} from "@/lib/ai/extraction-catalogs";

import { db } from "@/lib/db";
import { documents, extractedFields, extractions, shipments } from "@/lib/db/schema";
import {
  appendAuditLog,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AuditActor,
} from "./audit-service";

// ---------------------------------------------------------------------------
// Validation constants (same limits as extraction / correction)
// ---------------------------------------------------------------------------

/** `numeric_value` is NUMERIC(14,4): 10 integer digits. */
const NUMERIC_MAGNITUDE_LIMIT = 10_000_000_000;
/** Matches the provider-side text cap for one extracted value. */
const MAX_TEXT_CHARS = 500;
/** Strict ISO-8601 date (YYYY-MM-DD) with plausible month/day ranges. */
const ISO_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
/** Decimal literal with at most 4 fractional digits (NUMERIC(14,4)). */
const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d{1,4})?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** Result of one acceptance attempt. */
export type AcceptFieldOutcome =
  | {
      status: "success";
      /** True only when the FIELD_ACCEPTED audit write FAILED (backfill). */
      auditWriteFailed: boolean;
    }
  /** Shipment or field id malformed / not found under the shipment. */
  | { status: "not_found" }
  /** The field cannot be accepted right now. */
  | { status: "field_not_acceptable"; reason: FieldAcceptBlocker }
  /** The field exists but carries no usable value to accept. */
  | { status: "invalid_value" }
  | { status: "unavailable" };

/** Sanitized, client-safe reasons a field cannot be accepted (constants). */
export type FieldAcceptBlocker =
  /** The document was superseded (isActive = false) — history only. */
  | "document_inactive"
  /** The extraction is no longer the document's current attempt. */
  | "attempt_superseded"
  /** The current attempt has not completed — there is no confirmed value. */
  | "attempt_not_completed"
  /** The value was already accepted or corrected (never re-flagged here). */
  | "already_reviewed"
  /** Additive (CSV export stage): the shipment was already exported — the
   * one-shot export stamp is final and reviewed states stay frozen. */
  | "shipment_exported";

// ---------------------------------------------------------------------------
// Value validation (per catalog kind — single source of truth)
// ---------------------------------------------------------------------------

/** Resolve the catalog kind for a field; defensive fallback for drift only. */
const resolveKind = (
  documentType: "INVOICE" | "PACKING_LIST" | "BILL_OF_LADING",
  fieldKey: string,
  storedNumericValue: string | null,
): ExtractionFieldKind =>
  getExtractionFieldCatalog(documentType).fields.find(
    (definition) => definition.key === fieldKey,
  )?.kind ??
  (storedNumericValue !== null ? "numeric" : "text");

/**
 * True only when the stored snapshot is complete and still valid for its
 * catalog kind. Acceptance never repairs values — it refuses them.
 */
const hasAcceptableValue = (
  kind: ExtractionFieldKind,
  parsedValue: string | null,
  numericValue: string | null,
): boolean => {
  if (parsedValue === null) return false;
  const value = parsedValue.trim();
  if (value.length === 0) return false;

  if (kind === "numeric" || kind === "integer") {
    if (numericValue === null) return false;
    const numeric = numericValue.trim();
    if (!DECIMAL_PATTERN.test(numeric)) return false;
    const parsed = Number(numeric);
    if (!Number.isFinite(parsed) || !(Math.abs(parsed) < NUMERIC_MAGNITUDE_LIMIT)) {
      return false;
    }
    if (kind === "integer" && (!Number.isInteger(parsed) || parsed < 0)) {
      return false;
    }
    return true;
  }

  if (kind === "date") {
    return ISO_DATE_PATTERN.test(value);
  }

  return value.length <= MAX_TEXT_CHARS;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Accept one extracted field. Strictly typed outcome; non-throwing by
 * contract (DB failures map to `unavailable`). The caller must have already
 * verified session + DOCUMENTATION_MANAGER role — the route re-checks it and
 * this service records the actor id on the audit row.
 */
export async function acceptExtractedField(
  shipmentId: unknown,
  fieldId: unknown,
  actorId: AuditActor,
): Promise<AcceptFieldOutcome> {
  const sid = typeof shipmentId === "string" ? shipmentId.trim() : "";
  const fid = typeof fieldId === "string" ? fieldId.trim() : "";
  if (!UUID_PATTERN.test(sid) || !UUID_PATTERN.test(fid)) {
    return { status: "not_found" };
  }
  // Acceptance is a human decision: the audit row's actorId must be real.
  if (typeof actorId !== "string" || actorId.trim().length === 0) {
    console.error("[field-review-service] Acceptance requires a session actor.");
    return { status: "unavailable" };
  }

  // --- 1. Load the field with its extraction and document -------------------
  let field: {
    id: string;
    extractionId: string;
    shipmentId: string;
    fieldKey: string;
    fieldLabel: string;
    rawValue: string | null;
    parsedValue: string | null;
    numericValue: string | null;
    unit: string | null;
    reviewStatus: "PENDING_REVIEW" | "ACCEPTED" | "CORRECTED";
    shipmentStatus:
      | "DRAFT"
      | "PROCESSING"
      | "REVIEW"
      | "AWAITING_APPROVAL"
      | "APPROVED"
      | "REJECTED"
      | "EXPORTED";
    documentId: string;
    documentType: "INVOICE" | "PACKING_LIST" | "BILL_OF_LADING";
    documentIsActive: boolean;
  } | null = null;
  try {
    const rows = await db
      .select({
        id: extractedFields.id,
        extractionId: extractedFields.extractionId,
        shipmentId: extractedFields.shipmentId,
        fieldKey: extractedFields.fieldKey,
        fieldLabel: extractedFields.fieldLabel,
        rawValue: extractedFields.rawValue,
        parsedValue: extractedFields.parsedValue,
        numericValue: extractedFields.numericValue,
        unit: extractedFields.unit,
        reviewStatus: extractedFields.reviewStatus,
        shipmentStatus: shipments.status,
        documentId: extractions.documentId,
        documentType: documents.documentType,
        documentIsActive: documents.isActive,
      })
      .from(extractedFields)
      .innerJoin(extractions, eq(extractedFields.extractionId, extractions.id))
      .innerJoin(documents, eq(extractions.documentId, documents.id))
      .innerJoin(shipments, eq(extractedFields.shipmentId, shipments.id))
      .where(
        and(eq(extractedFields.id, fid), eq(extractedFields.shipmentId, sid)),
      )
      .limit(1);
    field = rows[0] ?? null;
  } catch {
    console.error(
      "[field-review-service] Failed to load field for acceptance " +
        `(shipmentId=${sid}, fieldId=${fid}).`,
    );
    return { status: "unavailable" };
  }
  if (!field) {
    return { status: "not_found" };
  }

  // --- 2. Active document + current completed attempt ------------------------
  // Lifecycle protection (CSV export stage): an EXPORTED shipment's accepted
  // states are final — its exported CSV must never change after the fact.
  if (field.shipmentStatus === "EXPORTED") {
    return { status: "field_not_acceptable", reason: "shipment_exported" };
  }
  if (!field.documentIsActive) {
    return { status: "field_not_acceptable", reason: "document_inactive" };
  }

  let currentAttempt: { id: string; status: string } | null = null;
  try {
    const rows = await db
      .select({ id: extractions.id, status: extractions.status })
      .from(extractions)
      .where(
        and(
          eq(extractions.documentId, field.documentId),
          eq(extractions.shipmentId, sid),
        ),
      )
      .orderBy(desc(extractions.attempt))
      .limit(1);
    currentAttempt = rows[0] ?? null;
  } catch {
    console.error(
      `[field-review-service] Failed to read current attempt (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }
  if (!currentAttempt || currentAttempt.id !== field.extractionId) {
    return { status: "field_not_acceptable", reason: "attempt_superseded" };
  }
  if (currentAttempt.status !== "COMPLETED") {
    return { status: "field_not_acceptable", reason: "attempt_not_completed" };
  }

  // --- 3. Review state + value usability -------------------------------------
  if (field.reviewStatus !== "PENDING_REVIEW") {
    return { status: "field_not_acceptable", reason: "already_reviewed" };
  }
  const kind = resolveKind(
    field.documentType,
    field.fieldKey,
    field.numericValue,
  );
  if (!hasAcceptableValue(kind, field.parsedValue, field.numericValue)) {
    return { status: "invalid_value" };
  }

  // --- 4. Guarded transition (full triple + PENDING_REVIEW) ------------------
  // The predicate makes acceptance a single-winner write: a concurrent accept
  // or correction leaves this update matching zero rows, reported as a
  // conflict rather than a second success.
  let updated: Array<{ id: string }> = [];
  try {
    updated = await db
      .update(extractedFields)
      .set({ reviewStatus: "ACCEPTED" })
      .where(
        and(
          eq(extractedFields.id, field.id),
          eq(extractedFields.extractionId, field.extractionId),
          eq(extractedFields.shipmentId, field.shipmentId),
          eq(extractedFields.reviewStatus, "PENDING_REVIEW"),
        ),
      )
      .returning({ id: extractedFields.id });
  } catch {
    console.error(
      "[field-review-service] Acceptance update failed " +
        `(shipmentId=${sid}, fieldId=${fid}).`,
    );
    return { status: "unavailable" };
  }
  if (updated.length === 0) {
    return { status: "field_not_acceptable", reason: "already_reviewed" };
  }

  // --- 5. Audit snapshot (partial-success policy) ----------------------------
  let auditWriteFailed = false;
  try {
    await appendAuditLog({
      action: AUDIT_ACTIONS.fieldAccepted,
      entityType: AUDIT_ENTITY_TYPES.extractedField,
      entityId: field.id,
      actorId,
      shipmentId: field.shipmentId,
      details: {
        fieldId: field.id,
        extractionId: field.extractionId,
        fieldKey: field.fieldKey,
        fieldLabel: field.fieldLabel,
        unit: field.unit,
        value: field.parsedValue ?? field.rawValue ?? "",
        reviewStatusBefore: "PENDING_REVIEW",
      },
    });
  } catch {
    auditWriteFailed = true;
    console.error(
      "[field-review-service] FIELD_ACCEPTED audit write failed " +
        `(shipmentId=${sid}, fieldId=${fid}) — audit trail requires manual backfill.`,
    );
  }

  return { status: "success", auditWriteFailed };
}
