import "server-only";

/**
 * Cross-document discrepancy CHECK service — the ONLY sanctioned writer of
 * `discrepancies` (no read view ships in Milestone 1). One cross-check
 * re-evaluates the confirmed extraction data of a whole shipment and
 * converges the live discrepancy rows onto it:
 *
 *   confirmed mismatch + no live row            -> INSERT (OPEN, audited)
 *   confirmed mismatch + live row, new evidence -> audit BEFORE, then UPDATE
 *   no confirmable mismatch + live rows         -> audit BEFORE, then OBSOLETE
 *
 * Comparison scope (Milestone 1, confirmed business decisions):
 * - PACKING_LIST.gross_weight_kg vs BILL_OF_LADING.gross_weight_kg only.
 * - Any numeric difference at all is a discrepancy — NO tolerance band.
 * - WEIGHT_MISMATCH severity is CRITICAL (can therefore never be WAIVED).
 * - Only ACCEPTED / CORRECTED fields participate; PENDING_REVIEW is never a
 *   confirmed value.
 *
 * Freshness law (identical to extraction-read-service): the CURRENT attempt
 * of a document is max(attempt) across ALL statuses, and its fields are used
 * ONLY when that attempt is COMPLETED. No fallback to an older COMPLETED
 * attempt — when the latest attempt is failed/superseded/incomplete, this
 * run simply cannot confirm that document's weight, and live rows whose
 * mismatch can no longer be confirmed close as OBSOLETE (never RESOLVED,
 * which requires a human actor; RESOLVED/WAIVED rows are never touched).
 *
 * Effective values: a CORRECTED field contributes the LATEST correction's
 * `correctedNumeric` (max correctedAt, ties max id — append-only history, so
 * the newest row is effective). A correction without a numeric value cannot
 * state a KG weight and makes the field non-participating — NEVER a fallback
 * to the superseded extraction value.
 *
 * Concurrency (neon-http compatible — no row locks, no interactive
 * transactions):
 * - A module-level per-shipment in-flight set serialises checks WITHIN one
 *   process (best-effort, mirroring the extract route's fence). Cross-process
 *   interleavings are owned by the DB: the partial unique index
 *   `discrepancies_live_uq` allows exactly one live WEIGHT_MISMATCH row per
 *   (shipment, type, scopeKey), and insert races resolve via
 *   `ON CONFLICT DO NOTHING` (no conflict target — a partial index is not
 *   targetable by column list) + a guarded re-read/update/retry.
 * - Every UPDATE re-verifies `status IN ('OPEN','RECHECK_PENDING')` so a row
 *   concurrently closed (RESOLVED/WAIVED/OBSOLETE) is never resurrected.
 *
 * Privacy contract: console messages contain ids and counts only — never PDF
 * bytes, prompts, raw provider output, storage keys, checksums or extraction
 * values. The expected/actual/delta values live in the discrepancy row
 * itself (schema-designed evidence) and in the audit before/after snapshot
 * per the schema contract (DISCREPANCY_REEVALUATED, before/after JSON) —
 * those are data, not logs.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  discrepancies,
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
  getActiveDocumentsForExtraction,
  type DocumentEntryType,
} from "./document-service";

// ---------------------------------------------------------------------------
// Confirmed business constants (single points of change)
// ---------------------------------------------------------------------------

/** The only comparable field key in Milestone 1 (also the scopeKey value). */
const COMPARED_FIELD_KEY = "gross_weight_kg";
/** Catalog unit of the compared field — both sides must declare exactly this. */
const COMPARED_UNIT = "KG";
/** Document type of the EXPECTED side (document A) of the comparison. */
const DOC_A_TYPE: DocumentEntryType = "PACKING_LIST";
/** Document type of the ACTUAL side (document B) of the comparison. */
const DOC_B_TYPE: DocumentEntryType = "BILL_OF_LADING";
/** Confirmed severity policy for WEIGHT_MISMATCH. */
const WEIGHT_MISMATCH_SEVERITY = "CRITICAL";

/** Provenance key recorded on every row this service writes. */
const CHECK_RUN_KEY = "crosscheck-v1";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export interface CrossCheckSummary {
  /** True when a confirmable PL/BOL weight pair differs (by any amount). */
  mismatchDetected: boolean;
  /** True when BOTH documents had a confirmable weight this run. */
  comparedPairFound: boolean;
  discrepanciesCreated: number;
  discrepanciesUpdated: number;
  discrepanciesObsoleted: number;
  /** Audit writes that failed AFTER the DB change (manual backfill needed). */
  auditWritesFailed: number;
}

export type CrossCheckRunOutcome =
  | { status: "applied"; summary: CrossCheckSummary }
  | { status: "skipped_concurrent" }
  | { status: "not_found" }
  | { status: "unavailable" };

/** One confirmed, comparable weight value on an ACTIVE document. */
interface ComparableWeight {
  documentId: string;
  documentType: DocumentEntryType;
  version: number;
  /** extracted_fields.id — the exact evidence FK target. */
  fieldId: string;
  /** Effective numeric value after applying the latest correction (if any). */
  value: number;
  isCorrected: boolean;
}

/** The numeric evidence trio + evidence FKs (inserts and updates share it). */
interface MismatchEvidence {
  expectedValue: string;
  actualValue: string;
  deltaValue: string;
  unit: string;
  fieldAId: string;
  fieldBId: string;
  documentAId: string;
  documentBId: string;
}

/** This checker's scope: live WEIGHT_MISMATCH rows for the compared key. */
interface LiveDiscrepancyRow {
  id: string;
  severity: string;
  status: string;
  expectedValue: string | null;
  actualValue: string | null;
  deltaValue: string | null;
  unit: string | null;
  fieldAId: string | null;
  fieldBId: string | null;
  documentAId: string | null;
  documentBId: string | null;
}

/** Whitelisted, client/audit-safe snapshot of a discrepancy row. */
interface DiscrepancySnapshot {
  id: string;
  severity: string;
  status: string;
  expectedValue: string | null;
  actualValue: string | null;
  deltaValue: string | null;
  unit: string | null;
  fieldAId: string | null;
  fieldBId: string | null;
  documentAId: string | null;
  documentBId: string | null;
}

const projectSnapshot = (row: LiveDiscrepancyRow): DiscrepancySnapshot => ({
  id: row.id,
  severity: row.severity,
  status: row.status,
  expectedValue: row.expectedValue,
  actualValue: row.actualValue,
  deltaValue: row.deltaValue,
  unit: row.unit,
  fieldAId: row.fieldAId,
  fieldBId: row.fieldBId,
  documentAId: row.documentAId,
  documentBId: row.documentBId,
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Deterministic 4-dp rendering for NUMERIC(14,4) columns. */
const formatNumeric = (value: number): string => value.toFixed(4);

/** Whole kilograms print clean; fractional values keep 2 dp. */
const formatKg = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Per-shipment in-flight fence (best-effort, per process — see module header)
// ---------------------------------------------------------------------------

const inFlightChecks = new Set<string>();

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Re-evaluate the cross-document discrepancies of one shipment from its
 * CURRENT, confirmable extraction state. Non-throwing by contract; every
 * failure maps to a typed outcome so the post-extraction caller can report
 * it without disturbing completed extraction attempts.
 */
export async function runCrossCheckForShipment(
  shipmentId: unknown,
  actorId: AuditActor,
): Promise<CrossCheckRunOutcome> {
  const id = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(id)) {
    return { status: "not_found" };
  }

  // Best-effort same-process fence: a check already running for this
  // shipment defers this request (that run's re-evaluation converges the
  // same state). Cross-process races are owned by the DB, not this set.
  if (inFlightChecks.has(id)) {
    return { status: "skipped_concurrent" };
  }
  inFlightChecks.add(id);

  try {
    return await evaluateShipment(id, actorId);
  } catch (error) {
    console.error(
      "[discrepancy-check-service] Cross-check failed " +
        `(shipmentId=${id}, reason=${error instanceof Error ? error.name : "unknown error type"}).`,
    );
    return { status: "unavailable" };
  } finally {
    inFlightChecks.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Evaluation pipeline
// ---------------------------------------------------------------------------

const evaluateShipment = async (
  id: string,
  actorId: AuditActor,
): Promise<CrossCheckRunOutcome> => {
  // --- 1. Active documents + shipment existence (one shared helper read) ---
  const docsResult = await getActiveDocumentsForExtraction(id);
  if (docsResult.status === "not_found") {
    return { status: "not_found" };
  }
  if (docsResult.status === "unavailable") {
    return { status: "unavailable" };
  }
  // Active-document index (id -> meta). Attempts of replaced documents may
  // still exist, but inactive documents never participate.
  const activeDocs = new Map(
    docsResult.documents.map((doc) => [doc.id, doc]),
  );

  if (docsResult.documents.length === 0) {
    // No active documents -> nothing confirmable; live rows (if any) close.
    return closeUnconfirmable(id, actorId, "EVIDENCE_UNAVAILABLE", {
      mismatchDetected: false,
      comparedPairFound: false,
      discrepanciesCreated: 0,
      discrepanciesUpdated: 0,
    });
  }

  // --- 2. CURRENT attempt per document: max(attempt) across ALL statuses ---
  const attemptRows = await db
    .select({
      id: extractions.id,
      documentId: extractions.documentId,
      attempt: extractions.attempt,
      status: extractions.status,
    })
    .from(extractions)
    .where(
      and(
        eq(extractions.shipmentId, id),
        inArray(
          extractions.documentId,
          docsResult.documents.map((doc) => doc.id),
        ),
      ),
    );

  const currentAttemptByDoc = new Map<string, (typeof attemptRows)[number]>();
  for (const row of attemptRows) {
    const current = currentAttemptByDoc.get(row.documentId);
    if (!current || row.attempt > current.attempt) {
      currentAttemptByDoc.set(row.documentId, row);
    }
  }

  // Freshness rule: only documents whose CURRENT attempt is COMPLETED
  // contribute; a failed/superseded/incomplete latest attempt means the
  // document has NO confirmable weight this run (no older-attempt fallback).
  const documentIdByExtraction = new Map<string, string>();
  const completedExtractionIds: string[] = [];
  for (const row of currentAttemptByDoc.values()) {
    documentIdByExtraction.set(row.id, row.documentId);
    if (row.status === "COMPLETED") {
      completedExtractionIds.push(row.id);
    }
  }

  if (completedExtractionIds.length === 0) {
    return closeUnconfirmable(id, actorId, "EVIDENCE_UNAVAILABLE", {
      mismatchDetected: false,
      comparedPairFound: false,
      discrepanciesCreated: 0,
      discrepanciesUpdated: 0,
    });
  }

  // --- 3. The compared field on current COMPLETED attempts only -----------
  // `shipment_id` appears in the predicate as an explicit check that the
  // referenced fields belong to THIS shipment (the composite FK already
  // enforces the same bound; D5 keeps service-layer verification explicit).
  const fieldRows = await db
    .select({
      id: extractedFields.id,
      extractionId: extractedFields.extractionId,
      fieldKey: extractedFields.fieldKey,
      numericValue: extractedFields.numericValue,
      unit: extractedFields.unit,
      reviewStatus: extractedFields.reviewStatus,
    })
    .from(extractedFields)
    .where(
      and(
        inArray(extractedFields.extractionId, completedExtractionIds),
        eq(extractedFields.shipmentId, id),
      ),
    );

  const participation = fieldRows
    .filter(
      (row) =>
        row.fieldKey === COMPARED_FIELD_KEY &&
        row.unit === COMPARED_UNIT &&
        (row.reviewStatus === "ACCEPTED" || row.reviewStatus === "CORRECTED") &&
        row.numericValue !== null &&
        documentIdByExtraction.has(row.extractionId) &&
        activeDocs.has(documentIdByExtraction.get(row.extractionId)!),
    );

  // --- 4. Effective values for CORRECTED fields ---------------------------
  // Latest correction per field = max(correctedAt, id) -> last row of the
  // ascending ordering. A null correctedNumeric (no numeric correction) must
  // NOT fall back to the superseded extraction value: the field simply does
  // not participate.
  const correctedFieldIds = participation
    .filter((row) => row.reviewStatus === "CORRECTED")
    .map((row) => row.id);

  const latestCorrectionNumeric = new Map<string, number>();
  if (correctedFieldIds.length > 0) {
    const correctionRows = await db
      .select({
        fieldId: fieldCorrections.fieldId,
        correctedNumeric: fieldCorrections.correctedNumeric,
      })
      .from(fieldCorrections)
      .where(inArray(fieldCorrections.fieldId, correctedFieldIds))
      .orderBy(asc(fieldCorrections.correctedAt), asc(fieldCorrections.id));
    for (const row of correctionRows) {
      if (row.correctedNumeric !== null) {
        latestCorrectionNumeric.set(row.fieldId, Number(row.correctedNumeric));
      } else {
        latestCorrectionNumeric.delete(row.fieldId);
      }
    }
  }

  const comparableByDocument: ComparableWeight[] = [];
  for (const field of participation) {
    const documentId = documentIdByExtraction.get(field.extractionId)!;
    const doc = activeDocs.get(documentId)!;
    const isCorrected = field.reviewStatus === "CORRECTED";
    const effective = isCorrected
      ? latestCorrectionNumeric.get(field.id)
      : Number(field.numericValue);
    if (effective === undefined || Number.isNaN(effective)) {
      continue; // corrected field without a numeric correction (see above)
    }
    comparableByDocument.push({
      documentId: doc.id,
      documentType: doc.documentType,
      version: doc.version,
      fieldId: field.id,
      value: effective,
      isCorrected,
    });
  }

  // --- 5. Deterministic candidate per document type (highest version) -----
  const pickForType = (documentType: DocumentEntryType): ComparableWeight | null => {
    const candidates = comparableByDocument
      .filter((weight) => weight.documentType === documentType)
      .sort((first, second) =>
        second.version !== first.version
          ? second.version - first.version
          : first.documentId.localeCompare(second.documentId),
      );
    return candidates[0] ?? null;
  };
  const packingList = pickForType(DOC_A_TYPE);
  const billOfLading = pickForType(DOC_B_TYPE);
  const comparedPairFound = packingList !== null && billOfLading !== null;

  // --- 6. Comparison + converge -------------------------------------------
  if (comparedPairFound && packingList!.value !== billOfLading!.value) {
    // Convention: document A (Packing List) is the EXPECTED side, document B
    // (Bill of Lading) the ACTUAL side.
    const delta = Math.abs(packingList!.value - billOfLading!.value);
    const evidence: MismatchEvidence = {
      expectedValue: formatNumeric(packingList!.value),
      actualValue: formatNumeric(billOfLading!.value),
      deltaValue: formatNumeric(delta),
      unit: COMPARED_UNIT,
      fieldAId: packingList!.fieldId,
      fieldBId: billOfLading!.fieldId,
      documentAId: packingList!.documentId,
      documentBId: billOfLading!.documentId,
    };
    const title =
      `Gross weight mismatch: Packing List ${formatKg(packingList!.value)} KG vs ` +
      `Bill of Lading ${formatKg(billOfLading!.value)} KG`;
    const detail =
      `Confirmed gross weight differs by ${formatKg(delta)} KG with no tolerance ` +
      `(weights from the current completed extraction attempt of each document, ` +
      `corrections applied).`;

    const outcome = await convergeMismatch(id, actorId, evidence, title, detail);
    return {
      status: "applied",
      summary: {
        mismatchDetected: true,
        comparedPairFound: true,
        discrepanciesCreated: outcome.created,
        discrepanciesUpdated: outcome.updated,
        discrepanciesObsoleted: outcome.obsoleted,
        auditWritesFailed: outcome.auditWritesFailed,
      },
    };
  }

  // No confirmable differing pair: values now equal, OR one/both documents
  // lack a confirmable weight this run. Under the freshness law both mean
  // "no active mismatch" — live rows close as OBSOLETE.
  const reason =
    comparedPairFound ? "VALUES_EQUAL" : "EVIDENCE_UNAVAILABLE";
  return closeUnconfirmable(id, actorId, reason, {
    mismatchDetected: false,
    comparedPairFound,
    discrepanciesCreated: 0,
    discrepanciesUpdated: 0,
  });
};

// ---------------------------------------------------------------------------
// Live-row readers & writers
// ---------------------------------------------------------------------------

/** This checker's managed scope: live WEIGHT_MISMATCH rows for the key. */
const selectLiveRows = async (shipmentId: string): Promise<LiveDiscrepancyRow[]> =>
  db
    .select({
      id: discrepancies.id,
      severity: discrepancies.severity,
      status: discrepancies.status,
      expectedValue: discrepancies.expectedValue,
      actualValue: discrepancies.actualValue,
      deltaValue: discrepancies.deltaValue,
      unit: discrepancies.unit,
      fieldAId: discrepancies.fieldAId,
      fieldBId: discrepancies.fieldBId,
      documentAId: discrepancies.documentAId,
      documentBId: discrepancies.documentBId,
    })
    .from(discrepancies)
    .where(
      and(
        eq(discrepancies.shipmentId, shipmentId),
        eq(discrepancies.type, "WEIGHT_MISMATCH"),
        sql`coalesce(${discrepancies.scopeKey}, '') = ${COMPARED_FIELD_KEY}`,
        inArray(discrepancies.status, ["OPEN", "RECHECK_PENDING"]),
      ),
    )
    .orderBy(asc(discrepancies.createdAt), asc(discrepancies.id));

interface UpsertOutcome {
  created: number;
  updated: number;
  obsoleted: number;
  auditWritesFailed: number;
}

/**
 * Converge ONE confirmed mismatch onto the live rows. Assumes at most one
 * normal live row (the DB's partial unique index enforces it); defensive
 * handling for a pre-existing duplicate set: the OLDEST row is primary and
 * converges, extras close as OBSOLETE duplicates.
 */
const convergeMismatch = async (
  shipmentId: string,
  actorId: AuditActor,
  evidence: MismatchEvidence,
  title: string,
  detail: string,
): Promise<UpsertOutcome> => {
  const liveRows = await selectLiveRows(shipmentId);
  if (liveRows.length > 0) {
    return applyMismatchToLive(shipmentId, actorId, liveRows, evidence, title, detail);
  }

  // No live row: INSERT (OPEN). `onConflictDoNothing` without a target so the
  // partial index `discrepancies_live_uq` is honoured; a lost race falls back
  // to the guarded update path (bounded retries).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inserted = await db
      .insert(discrepancies)
      .values({
        shipmentId,
        type: "WEIGHT_MISMATCH",
        scopeKey: COMPARED_FIELD_KEY,
        severity: WEIGHT_MISMATCH_SEVERITY,
        status: "OPEN",
        title,
        detail,
        ...evidence,
        // checkRunKey keeps its schema default (same "crosscheck-v1").
      })
      .onConflictDoNothing()
      .returning({ id: discrepancies.id });

    if (inserted.length > 0) {
      const snapshot = (await selectLiveRows(shipmentId)).find(
        (row) => row.id === inserted[0].id,
      );
      if (snapshot) {
        // Creation is part of the re-evaluation: audited with the evidence
        // snapshot (before = null) per the schema contract.
        try {
          await appendAuditLog({
            action: AUDIT_ACTIONS.discrepancyReevaluated,
            entityType: AUDIT_ENTITY_TYPES.discrepancy,
            entityId: inserted[0].id,
            actorId,
            shipmentId,
            details: {
              change: "CREATED",
              reason: "MISMATCH_DETECTED",
              checkRunKey: CHECK_RUN_KEY,
              before: null,
              after: projectSnapshot(snapshot),
            },
          });
          return { created: 1, updated: 0, obsoleted: 0, auditWritesFailed: 0 };
        } catch {
          console.error(
            "[discrepancy-check-service] DISCREPANCY_REEVALUATED audit write failed " +
              `for created discrepancy ${inserted[0].id} (shipmentId=${shipmentId}) ` +
              "— audit trail requires manual backfill.",
          );
          return { created: 1, updated: 0, obsoleted: 0, auditWritesFailed: 1 };
        }
      }
      // The row vanished from the live set before its snapshot could be read
      // (concurrent close). The creation still happened — flag the missing
      // audit so it is never silently untracked.
      console.error(
        "[discrepancy-check-service] Created discrepancy not re-readable as live " +
          `(${inserted[0].id}, shipmentId=${shipmentId}) — concurrent status change; ` +
          "audit trail requires manual backfill.",
      );
      return { created: 1, updated: 0, obsoleted: 0, auditWritesFailed: 1 };
    }

    // Insert lost a race to a concurrent check: if that writer's row is now
    // visible, converge onto IT instead of inserting a duplicate.
    const raced = await selectLiveRows(shipmentId);
    if (raced.length > 0) {
      return applyMismatchToLive(shipmentId, actorId, raced, evidence, title, detail);
    }
    // Row was created and closed again concurrently — retry the INSERT.
  }

  // Two failed attempts with no visible live row is pathological; surface it
  // as an unavailable run (the caller reports it, extraction stays intact).
  throw new Error("DISCREPANCY_LIVE_INSERT_RACE");
};

/**
 * Update an EXISTING live row when the evidence changed (audit BEFORE the
 * update, per the schema contract), and close duplicate extras.
 */
const applyMismatchToLive = async (
  shipmentId: string,
  actorId: AuditActor,
  liveRows: LiveDiscrepancyRow[],
  evidence: MismatchEvidence,
  title: string,
  detail: string,
): Promise<UpsertOutcome> => {
  let updated = 0;
  let obsoleted = 0;
  let auditWritesFailed = 0;

  // Primary = oldest (deterministic; extras are historical duplicates).
  const [primary, ...extras] = liveRows;
  const evidenceUnchanged =
    primary.expectedValue === evidence.expectedValue &&
    primary.actualValue === evidence.actualValue &&
    primary.deltaValue === evidence.deltaValue &&
    primary.unit === evidence.unit &&
    primary.fieldAId === evidence.fieldAId &&
    primary.fieldBId === evidence.fieldBId &&
    primary.documentAId === evidence.documentAId &&
    primary.documentBId === evidence.documentBId;

  if (!evidenceUnchanged) {
    const before = primary;
    // Audit FIRST: the before/after snapshot must exist before the row
    // changes (append-only evidence per the schema design).
    try {
      await appendAuditLog({
        action: AUDIT_ACTIONS.discrepancyReevaluated,
        entityType: AUDIT_ENTITY_TYPES.discrepancy,
        entityId: primary.id,
        actorId,
        shipmentId,
        details: {
          change: "UPDATED",
          reason: "EVIDENCE_CHANGED",
          checkRunKey: CHECK_RUN_KEY,
          before: projectSnapshot(before),
          after: { ...projectSnapshot(before), status: "OPEN", ...evidence },
        },
      });
    } catch {
      auditWritesFailed = 1;
      console.error(
        "[discrepancy-check-service] DISCREPANCY_REEVALUATED audit write failed " +
          `for discrepancy ${primary.id} (shipmentId=${shipmentId}) — ` +
          "update aborted; the next cross-check retries.",
      );
      // Skip the update: never change a live row without its audit snapshot.
      const extrasOutcome = await closeDuplicateExtras(shipmentId, actorId, extras);
      return {
        created: 0,
        updated: 0,
        obsoleted: extrasOutcome.obsoleted,
        auditWritesFailed,
      };
    }

    const updatedRows = await db
      .update(discrepancies)
      .set({
        status: "OPEN", // RECHECK_PENDING rows re-confirm back to OPEN
        title,
        detail,
        ...evidence,
      })
      .where(
        and(
          eq(discrepancies.id, primary.id),
          inArray(discrepancies.status, ["OPEN", "RECHECK_PENDING"]),
        ),
      )
      .returning({ id: discrepancies.id });
    updated = updatedRows.length;
    if (updated === 0) {
      // A concurrent flow closed the row between the audit and the update —
      // the audited "after" did not happen (audit-only, no state change).
      console.error(
        "[discrepancy-check-service] Guarded mismatch update matched no live row " +
          `(${primary.id}, shipmentId=${shipmentId}) — concurrent status change.`,
      );
    }
  }

  const extrasOutcome = await closeDuplicateExtras(shipmentId, actorId, extras);
  obsoleted = extrasOutcome.obsoleted;
  auditWritesFailed += extrasOutcome.auditWritesFailed;

  return { created: 0, updated, obsoleted, auditWritesFailed };
};

/** Defensive: historical duplicate live rows close as OBSOLETE duplicates. */
const closeDuplicateExtras = async (
  shipmentId: string,
  actorId: AuditActor,
  extras: LiveDiscrepancyRow[],
): Promise<{ obsoleted: number; auditWritesFailed: number }> => {
  if (extras.length === 0) {
    return { obsoleted: 0, auditWritesFailed: 0 };
  }
  return closeLiveRows(shipmentId, actorId, extras, "DUPLICATE_LIVE_ROW");
};

/**
 * Automatically close live rows as OBSOLETE (RESOLVED requires a human actor
 * and WAIVED is forbidden for CRITICAL — both beyond this service's remit).
 * Audit-FIRST per row, then a guarded UPDATE that re-verifies the row is
 * still live; rows concurrently closed by another flow are skipped untouched.
 */
const closeLiveRows = async (
  shipmentId: string,
  actorId: AuditActor,
  rows: LiveDiscrepancyRow[],
  reason: "VALUES_EQUAL" | "EVIDENCE_UNAVAILABLE" | "DUPLICATE_LIVE_ROW",
): Promise<{ obsoleted: number; auditWritesFailed: number }> => {
  let obsoleted = 0;
  let auditWritesFailed = 0;

  for (const row of rows) {
    try {
      await appendAuditLog({
        action: AUDIT_ACTIONS.discrepancyReevaluated,
        entityType: AUDIT_ENTITY_TYPES.discrepancy,
        entityId: row.id,
        actorId,
        shipmentId,
        details: {
          change: "OBSOLETED",
          reason,
          checkRunKey: CHECK_RUN_KEY,
          before: projectSnapshot(row),
          after: { ...projectSnapshot(row), status: "OBSOLETE" },
        },
      });
    } catch {
      auditWritesFailed += 1;
      console.error(
        "[discrepancy-check-service] DISCREPANCY_REEVALUATED audit write failed " +
          `for obsolete close of ${row.id} (shipmentId=${shipmentId}) — ` +
          "closure aborted; the row stays live for the next cross-check.",
      );
      continue;
    }

    const closed = await db
      .update(discrepancies)
      .set({ status: "OBSOLETE" })
      .where(
        and(
          eq(discrepancies.id, row.id),
          inArray(discrepancies.status, ["OPEN", "RECHECK_PENDING"]),
        ),
      )
      .returning({ id: discrepancies.id });
    obsoleted += closed.length;
    if (closed.length === 0) {
      console.error(
        "[discrepancy-check-service] Guarded obsolete close matched no live row " +
          `(${row.id}, shipmentId=${shipmentId}) — concurrent status change.`,
      );
    }
  }

  return { obsoleted, auditWritesFailed };
};

/**
 * Close the live rows of this checker's scope after auditing them when no
 * confirmable mismatch holds this run (equal values or unavailable evidence).
 */
const closeUnconfirmable = async (
  shipmentId: string,
  actorId: AuditActor,
  reason: "VALUES_EQUAL" | "EVIDENCE_UNAVAILABLE",
  summaryBase: Pick<CrossCheckSummary, "mismatchDetected" | "comparedPairFound" | "discrepanciesCreated" | "discrepanciesUpdated">,
): Promise<CrossCheckRunOutcome> => {
  const rows = await selectLiveRows(shipmentId);
  const { obsoleted, auditWritesFailed } = await closeLiveRows(
    shipmentId,
    actorId,
    rows,
    reason,
  );
  return {
    status: "applied",
    summary: {
      ...summaryBase,
      discrepanciesObsoleted: obsoleted,
      auditWritesFailed,
    },
  };
};
