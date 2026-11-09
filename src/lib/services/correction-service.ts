import "server-only";

/**
 * Field CORRECTION service — the ONLY sanctioned writer of `field_corrections`
 * (append-only human corrections) plus the single narrow `reviewStatus`
 * transition on `extracted_fields` that the schema contract assigns to a
 * correction: inserting a correction flips the field to CORRECTED. Every
 * other `extracted_fields` write remains with `extraction-service.ts`.
 *
 * Workflow (one call):
 *   1. validate the shipment/field ids and load the field with its extraction
 *      and document;
 *   2. verify eligibility: the field's extraction IS the document's CURRENT
 *      attempt (max(attempt) across ALL statuses — same freshness law as the
 *      check/read services), that attempt is COMPLETED, and the document is
 *      ACTIVE (superseded documents' rows are history, never correctable);
 *   3. validate the corrected value against the field's CATALOG kind
 *      (`extraction-catalogs.ts` is the single source of truth for field
 *      types; numeric/integer values must fit `NUMERIC(14,4)` — validated
 *      here with the same magnitude limit `response-validation.ts` uses);
 *   4. reject a no-op: the submitted value must differ from the field's
 *      CURRENT EFFECTIVE value (latest correction first, original extraction
 *      value otherwise) — the DB CHECK `field_corrections_changes_value`
 *      additionally enforces difference from the stored original snapshot;
 *   5. INSERT the append-only correction row (never updates or deletes —
 *      the latest row per field is the effective one by max(correctedAt, id),
 *      exactly the rule `discrepancy-check-service` already reads);
 *   6. flip `reviewStatus` to CORRECTED via a guarded update re-verifying the
 *      (field, extraction, shipment) triple;
 *   7. audit `FIELD_CORRECTED` (value snapshots + reason; never actor data —
 *      the actor is the audit row's own actorId column);
 *   8. re-evaluate the shipment's discrepancies through
 *      `runCrossCheckForShipment` — NO engine bypass, NO manual discrepancy
 *      writes: the converged lifecycle rules (mismatch -> OPEN, equal ->
 *      OBSOLETE, unverifiable -> RECHECK_PENDING, RESOLVED/WAIVED untouched)
 *      are owned by the check service, and the corrected numeric value feeds
 *      it automatically because participation reads CORRECTED fields'
 *      latest `correctedNumeric`.
 *
 * Deliberate deviations from the schema header's ordering (documented, not
 * silent): instead of blindly moving live discrepancies to RECHECK_PENDING,
 * the full cross-check runs and converges to the CORRECT state for the new
 * evidence. Approval invalidation (schema D5) is handled after step 8 via
 * approval-invalidation-service: a correction always invalidates the
 * shipment's live approval decision (reason "field_corrected"), audited
 * there — it never resolves/waives discrepancies directly and never touches
 * approvals beyond triggering that sanctioned invalidation path.
 *
 * Failure policy: neon-http has no interactive transactions, so the write is
 * a small sequence with the same partial-success discipline as the
 * extraction service — if the AUDIT write fails after the correction row
 * landed, the outcome reports `auditWriteFailed: true` (backfill needed) and
 * the route surfaces a warning; nothing is ever rolled back or deleted.
 *
 * Privacy: console messages carry identifiers and failure-type names only —
 * never correction values, reasons, storage keys, checksums or credentials.
 */

import { and, desc, eq } from "drizzle-orm";

import {
  getExtractionFieldCatalog,
  type ExtractionFieldKind,
} from "@/lib/ai/extraction-catalogs";

import { db } from "@/lib/db";
import {
  documents,
  extractedFields,
  extractions,
  fieldCorrections,
} from "@/lib/db/schema";
import {
  appendAuditLog,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AuditActor,
} from "./audit-service";
import {
  runCrossCheckForShipment,
  type CrossCheckRunOutcome,
} from "./discrepancy-check-service";
import {
  invalidateApprovalsForShipment,
  type ApprovalInvalidationOutcome,
} from "./approval-invalidation-service";

// ---------------------------------------------------------------------------
// Validation constants (mirroring response-validation.ts exactly)
// ---------------------------------------------------------------------------

/** `numeric_value`/`corrected_numeric` are NUMERIC(14,4): 10 integer digits. */
const NUMERIC_MAGNITUDE_LIMIT = 10_000_000_000;
/** Matches the provider-side text/date cap of one correction row. */
const MAX_CORRECTION_TEXT_CHARS = 500;
/** Corrections are snapshots, not essays: same cap as the value cap above. */
const MAX_REASON_CHARS = 500;

/** Strict ISO-8601 date (YYYY-MM-DD) with plausible month/day ranges. */
const ISO_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/**
 * Decimal literal with at most 4 fractional digits — NUMERIC(14,4) rejects
 * (rounds) more; a correction must never store a silently-rounded value.
 */
const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d{1,4})?$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** Result of one correction attempt. */
export type CorrectFieldOutcome =
  | {
      status: "success";
      /** The append-only field_corrections row id. */
      correctionId: string;
      /** True only when the FIELD_CORRECTED audit write FAILED (backfill). */
      auditWriteFailed: boolean;
      /** The immediate post-correction discrepancy re-evaluation outcome. */
      crossCheck: CrossCheckRunOutcome;
      /** Additive: the correction changed the evidence a live approval
       * decision was frozen on, so that decision is invalidated (the raw
       * service contract; the route projects the client-safe fields). */
      approvalInvalidation: ApprovalInvalidationOutcome;
    }
  /** Shipment or field id malformed / not found under the shipment. */
  | { status: "not_found" }
  /** The field exists but a correction may not be applied right now. */
  | { status: "field_not_correctable"; reason: CorrectionBlocker }
  | { status: "invalid_value" }
  | { status: "invalid_reason" }
  /** Submitted value equals the field's current effective/original value. */
  | { status: "unchanged_value" }
  | { status: "unavailable" };

/** Sanitized, client-safe reasons a field cannot be corrected (constants). */
export type CorrectionBlocker =
  /** The document was superseded (isActive = false) — history only. */
  | "document_inactive"
  /** The extraction is no longer the document's current attempt. */
  | "attempt_superseded"
  /** The current attempt has not completed — there is no confirmed value. */
  | "attempt_not_completed";

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
  // Belt-and-braces: a key outside the catalog should not exist; classify by
  // the stored numeric column rather than guessing.
  (storedNumericValue !== null ? "numeric" : "text");

/**
 * Validate and normalize one corrected value for a catalog kind. Returns the
 * trimmed, normalized string to persist, or null when invalid. Numeric and
 * integer values additionally produce the canonical numeric text for
 * `corrected_numeric` (same rule as extraction: the raw string IS the
 * canonical form).
 */
const validateCorrectedValue = (
  raw: unknown,
  kind: ExtractionFieldKind,
): { valid: true; value: string; numeric: string | null } | { valid: false } => {
  if (typeof raw !== "string") return { valid: false };
  const value = raw.trim();

  if (kind === "numeric" || kind === "integer") {
    if (!DECIMAL_PATTERN.test(value)) return { valid: false };
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !(Math.abs(parsed) < NUMERIC_MAGNITUDE_LIMIT)) {
      return { valid: false };
    }
    if (kind === "integer" && (!Number.isInteger(parsed) || parsed < 0)) {
      return { valid: false };
    }
    return { valid: true, value, numeric: value };
  }

  if (kind === "date") {
    // Same strict rule the provider output must satisfy.
    if (!ISO_DATE_PATTERN.test(value)) return { valid: false };
    return { valid: true, value, numeric: null };
  }

  // text
  if (value.length === 0 || value.length > MAX_CORRECTION_TEXT_CHARS) {
    return { valid: false };
  }
  return { valid: true, value, numeric: null };
};

const isValidReason = (raw: unknown): raw is string =>
  typeof raw === "string" &&
  raw.trim().length > 0 &&
  raw.trim().length <= MAX_REASON_CHARS;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Apply one human field correction. Strictly typed outcome; non-throwing by
 * contract (DB failures map to `unavailable`). The caller must have already
 * verified session + DOCUMENTATION_MANAGER role — this service re-verifies
 * NOTHING about the session by design (mirroring extraction-service), but
 * never trusts a route-side role check alone: the ROUTE re-checks the role
 * and this service records the actor id on the append-only row.
 */
export async function correctExtractedField(
  shipmentId: unknown,
  fieldId: unknown,
  correctedValueRaw: unknown,
  reasonRaw: unknown,
  actorId: AuditActor,
): Promise<CorrectFieldOutcome> {
  const sid = typeof shipmentId === "string" ? shipmentId.trim() : "";
  const fid = typeof fieldId === "string" ? fieldId.trim() : "";
  // Malformed ids are a caller bug or tampering: not a real "not found", but
  // the typed outcome is identical to the client (404) either way.
  if (!UUID_PATTERN.test(sid) || !UUID_PATTERN.test(fid)) {
    return { status: "not_found" };
  }
  // Corrections REQUIRE a human actor: `field_corrections.corrected_by` is
  // NOT NULL and references the user table. The null/system actor path can
  // only arise from a route bug (the API session is verified); it must not
  // attempt an audit row pointing at "(system)".
  if (typeof actorId !== "string" || actorId.trim().length === 0) {
    console.error("[correction-service] Correction requires a session actor.");
    return { status: "unavailable" };
  }

  // --- 1. Load the field with its extraction and document (explicit D5
  // verification of the (field, extraction, shipment) triple the composite
  // FK already enforces) ------------------------------------------------------
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
    confidence: string;
    reviewStatus: "PENDING_REVIEW" | "ACCEPTED" | "CORRECTED";
    documentId: string;
    documentType: "INVOICE" | "PACKING_LIST" | "BILL_OF_LADING";
    documentVersion: number;
    documentIsActive: boolean;
    extractionStatus: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "SUPERSEDED";
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
        confidence: extractedFields.confidence,
        reviewStatus: extractedFields.reviewStatus,
        documentId: extractions.documentId,
        documentType: documents.documentType,
        documentVersion: documents.version,
        documentIsActive: documents.isActive,
        extractionStatus: extractions.status,
      })
      .from(extractedFields)
      .innerJoin(extractions, eq(extractedFields.extractionId, extractions.id))
      .innerJoin(documents, eq(extractions.documentId, documents.id))
      .where(
        and(
          eq(extractedFields.id, fid),
          eq(extractedFields.shipmentId, sid),
        ),
      )
      .limit(1);
    field = rows[0] ?? null;
  } catch {
    console.error(
      "[correction-service] Failed to load field for correction " +
        `(shipmentId=${sid}, fieldId=${fid}).`,
    );
    return { status: "unavailable" };
  }
  if (!field) {
    return { status: "not_found" };
  }

  // --- 2. Eligibility: current attempt (max(attempt) across ALL statuses)
  // of an ACTIVE document, COMPLETED — no corrections on history --------------
  const exactBlocker = ((): CorrectionBlocker | null => {
    if (!field!.documentIsActive) return "document_inactive";
    return null;
  })();
  if (exactBlocker) {
    return { status: "field_not_correctable", reason: exactBlocker };
  }

  let currentAttempt: { id: string; status: string } | null = null;
  try {
    const rows = await db
      .select({ id: extractions.id, status: extractions.status })
      .from(extractions)
      .where(
        and(
          eq(extractions.documentId, field!.documentId),
          eq(extractions.shipmentId, sid),
        ),
      )
      .orderBy(desc(extractions.attempt))
      .limit(1);
    currentAttempt = rows[0] ?? null;
  } catch {
    console.error(
      `[correction-service] Failed to read current attempt (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }
  if (!currentAttempt || currentAttempt.id !== field!.extractionId) {
    return { status: "field_not_correctable", reason: "attempt_superseded" };
  }
  if (currentAttempt.status !== "COMPLETED") {
    return { status: "field_not_correctable", reason: "attempt_not_completed" };
  }

  // --- 3. Effective value (latest correction first) + input validation ------
  let latestCorrection: {
    correctedValue: string;
    correctedNumeric: string | null;
  } | null = null;
  try {
    const rows = await db
      .select({
        correctedValue: fieldCorrections.correctedValue,
        correctedNumeric: fieldCorrections.correctedNumeric,
      })
      .from(fieldCorrections)
      .where(eq(fieldCorrections.fieldId, field!.id))
      .orderBy(desc(fieldCorrections.correctedAt), desc(fieldCorrections.id))
      .limit(1);
    latestCorrection = rows[0] ?? null;
  } catch {
    console.error(
      `[correction-service] Failed to read latest correction (fieldId=${fid}).`,
    );
    return { status: "unavailable" };
  }

  // Original = the immutable extraction snapshot this triple points at.
  const originalValue = field!.parsedValue ?? field!.rawValue ?? "";
  const isCorrected = field!.reviewStatus === "CORRECTED";
  const effectiveValue = isCorrected && latestCorrection
    ? latestCorrection.correctedValue
    : originalValue;

  const kind = resolveKind(field!.documentType, field!.fieldKey, field!.numericValue);
  const validated = validateCorrectedValue(correctedValueRaw, kind);
  if (!validated.valid) {
    return { status: "invalid_value" };
  }
  if (!isValidReason(reasonRaw)) {
    return { status: "invalid_reason" };
  }

  // --- 4. No-op rejection: must differ from BOTH the effective value and the
  // stored original snapshot (the DB CHECK enforces the latter on insert; the
  // numeric comparison catches equal values whose strings differ). ----------
  const numericallyEqual = (first: string | null, second: string | null): boolean =>
    first !== null &&
    second !== null &&
    Number.isFinite(Number(first)) &&
    Number.isFinite(Number(second)) &&
    Number(first) === Number(second);

  const effectiveNumeric =
    isCorrected && latestCorrection
      ? latestCorrection.correctedNumeric
      : field!.numericValue;

  if (
    validated.value === effectiveValue ||
    validated.value === originalValue ||
    (kind === "numeric" || kind === "integer") &&
      (numericallyEqual(validated.numeric, effectiveNumeric) ||
        numericallyEqual(validated.numeric, field!.numericValue))
  ) {
    return { status: "unchanged_value" };
  }

  // --- 5. Append the correction row (insert-only; deterministic effective
  // value = max(correctedAt, id), exactly what the check service reads) ------
  let correctionId: string;
  try {
    const inserted = await db
      .insert(fieldCorrections)
      .values({
        fieldId: field!.id,
        extractionId: field!.extractionId,
        shipmentId: field!.shipmentId,
        originalValue,
        originalNumeric: field!.numericValue,
        correctedValue: validated.value,
        correctedNumeric: validated.numeric,
        unit: field!.unit,
        reason: reasonRaw.trim(),
        confidenceBefore: field!.confidence,
        correctedBy: actorId,
      })
      .returning({ id: fieldCorrections.id });
    if (inserted.length === 0) {
      // defensive only — an insert never returns zero rows in drizzle
      throw new Error("FIELD_CORRECTION_INSERT_EMPTY");
    }
    correctionId = inserted[0].id;
  } catch {
    // Includes the DB CHECK `field_corrections_changes_value` (defense in
    // depth behind step 4) and FK failures — all map to one typed outcome.
    console.error(
      "[correction-service] Correction insert failed " +
        `(shipmentId=${sid}, fieldId=${fid}).`,
    );
    return { status: "unavailable" };
  }

  // --- 6. Flip reviewStatus to CORRECTED (guarded on the full triple) -------
  const reviewStatusUpdated = await db
    .update(extractedFields)
    .set({ reviewStatus: "CORRECTED" })
    .where(
      and(
        eq(extractedFields.id, field!.id),
        eq(extractedFields.extractionId, field!.extractionId),
        eq(extractedFields.shipmentId, field!.shipmentId),
      ),
    )
    .returning({ id: extractedFields.id });
  if (reviewStatusUpdated.length === 0) {
    // Practically unreachable (the triple was just re-read); the append-only
    // correction row exists but the engine only feeds CORRECTED fields —
    // surface the inconsistency loudly, never silently claim success.
    console.error(
      "[correction-service] Guarded reviewStatus update matched no row " +
        `(fieldId=${fid}, shipmentId=${sid}) — correction row ` +
        `${correctionId} needs manual review.`,
    );
    return { status: "unavailable" };
  }

  // --- 7. Audit snapshot (partial-success policy as in extraction-service) --
  let auditWriteFailed = false;
  try {
    await appendAuditLog({
      action: AUDIT_ACTIONS.fieldCorrected,
      entityType: AUDIT_ENTITY_TYPES.fieldCorrection,
      entityId: correctionId,
      actorId,
      shipmentId: field!.shipmentId,
      details: {
        fieldId: field!.id,
        extractionId: field!.extractionId,
        fieldKey: field!.fieldKey,
        fieldLabel: field!.fieldLabel,
        unit: field!.unit,
        originalValue,
        originalNumeric: field!.numericValue,
        correctedValue: validated.value,
        correctedNumeric: validated.numeric,
        reviewStatusBefore: field!.reviewStatus,
        reason: reasonRaw.trim(),
      },
    });
  } catch {
    auditWriteFailed = true;
    console.error(
      "[correction-service] FIELD_CORRECTED audit write failed " +
        `for correction ${correctionId} (shipmentId=${sid}) — ` +
        "audit trail requires manual backfill.",
    );
  }

  // --- 8. Re-evaluate the shipment's discrepancies via the check service.
  // No engine bypass and no manual discrepancy writes: the corrected numeric
  // value flows in because participation reads CORRECTED fields' latest
  // correction; lifecycle rules (OPEN / OBSOLETE / RECHECK_PENDING, and the
  // RESOLVED/WAIVED blind spot) are the check service's alone. ---------------
  const crossCheck = await runCrossCheckForShipment(sid, actorId);

  // --- 9. Approval invalidation (additive, never demoting) ------------------
  // A correction is by definition a change to the evidence a live approval
  // decision was frozen on ("after successful field correction"). The
  // cross-check above may already have invalidated it via its OPEN /
  // RECHECK_PENDING hooks — that second call is then a plain no-op.
  const approvalInvalidation = await invalidateApprovalsForShipment(
    sid,
    "field_corrected",
    actorId,
  );

  return {
    status: "success",
    correctionId,
    auditWriteFailed,
    crossCheck,
    approvalInvalidation,
  };
}
