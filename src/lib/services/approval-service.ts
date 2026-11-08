import "server-only";

/**
 * Approval service — the ONLY sanctioned writer of `approvals` and the
 * manager-only approval/rejection decisions (stage 2; no approval UI or CSV
 * export yet).
 *
 * Readiness law (evaluated from the database, never from a cached view):
 *   1. all three required document types (INVOICE, PACKING_LIST,
 *      BILL_OF_LADING) have an ACTIVE version;
 *   2. for every active document, the LATEST extraction attempt — max(attempt)
 *      across ALL statuses, never a fallback to an older COMPLETED attempt —
 *      is COMPLETED;
 *   3. every catalog-required field of that current attempt is ACCEPTED or
 *      CORRECTED (PENDING_REVIEW blocks, and a missing required key blocks);
 *   4. no discrepancy in OPEN or RECHECK_PENDING status exists. OBSOLETE,
 *      RESOLVED and WAIVED rows are historical and never block.
 *
 * The snapshot uses the existing `ApprovalSnapshot` type: active document ids,
 * types, versions and checksums plus the document -> extraction pairs, the
 * check-run provenance key and the capture timestamp. Checksums never leave
 * the server.
 *
 * Decisions are manager-only at the route; this service records the actor.
 * Approval inserts an APPROVED row with a mandatory snapshot, then moves the
 * shipment PROCESSING|REVIEW|REJECTED -> APPROVED through a guarded update.
 * Rejection requires a note, inserts a REJECTED row (snapshot not required),
 * then moves PROCESSING|REVIEW|AWAITING_APPROVAL -> REJECTED. Rows are never
 * deleted or overwritten: a superseded decision is referenced by
 * `supersedesId`, and a failed guarded status update compensates by
 * invalidating the just-inserted row (append-only history is preserved).
 *
 * Live uniqueness is enforced by `approvals_live_uq`; a concurrent decision
 * therefore cannot create a second PENDING/APPROVED row and maps to
 * `already_decided`.
 *
 * Partial success (neon-http, no transactions): the decision and shipment
 * status are written first, then the audit row. If the audit write fails, the
 * outcome reports `auditWriteFailed: true` so the route can warn; nothing is
 * rolled back or retried.
 */

import { and, desc, eq, inArray } from "drizzle-orm";

import { getExtractionFieldCatalog } from "@/lib/ai/extraction-catalogs";

import { db } from "@/lib/db";
import {
  approvals,
  discrepancies,
  documents,
  extractedFields,
  extractions,
  shipments,
  type ApprovalSnapshot,
} from "@/lib/db/schema";
import {
  appendAuditLog,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AuditActor,
} from "./audit-service";
import type { DocumentEntryType } from "./document-service";

// ---------------------------------------------------------------------------
// Constants and contracts
// ---------------------------------------------------------------------------

/** Provenance key recorded alongside the approved evidence. */
const CHECK_RUN_KEY = "crosscheck-v1";

/** Required document types, in pgEnum declaration order. */
const REQUIRED_DOCUMENT_TYPES: ReadonlyArray<DocumentEntryType> = [
  "INVOICE",
  "PACKING_LIST",
  "BILL_OF_LADING",
];

/** Shipment states an approval may move to APPROVED from. */
const APPROVABLE_FROM = ["PROCESSING", "REVIEW", "REJECTED"] as const;

/** Shipment states a rejection may move to REJECTED from. */
const REJECTABLE_FROM = [
  "PROCESSING",
  "REVIEW",
  "AWAITING_APPROVAL",
] as const;

/** Discrepancy states that block approval at any severity. */
const BLOCKING_DISCREPANCY_STATUSES = ["OPEN", "RECHECK_PENDING"] as const;

/** Rejection is documented: same cap as a correction reason. */
const MAX_DECISION_NOTE_CHARS = 500;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ShipmentStatusValue =
  | "DRAFT"
  | "PROCESSING"
  | "REVIEW"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "EXPORTED";

/** Structured, client-safe readiness blocker (no ids/checksums/values). */
export type ApprovalBlocker =
  | { code: "missing_document"; documentType: DocumentEntryType }
  | {
      code: "attempt_not_completed";
      documentType: DocumentEntryType;
      attempt: number;
      extractionStatus: string;
    }
  | {
      code: "required_field_missing";
      documentType: DocumentEntryType;
      fieldKey: string;
      fieldLabel: string;
    }
  | {
      code: "required_field_pending";
      documentType: DocumentEntryType;
      fieldKey: string;
      fieldLabel: string;
    }
  | {
      code: "blocking_discrepancy";
      discrepancyType: string;
      status: "OPEN" | "RECHECK_PENDING";
      severity: string;
      scopeKey: string | null;
    };

/** Readiness result: blockers plus the snapshot when evidence is complete. */
export type ShipmentReadinessResult =
  | {
      status: "success";
      shipmentStatus: ShipmentStatusValue;
      ready: boolean;
      blockers: ApprovalBlocker[];
      /** Non-null only when the snapshot inputs are complete. */
      snapshot: ApprovalSnapshot | null;
    }
  | { status: "not_found" }
  | { status: "unavailable" };

/** Result of one manager decision. */
export type ApprovalDecisionOutcome =
  | {
      status: "approved";
      approvalId: string;
      shipmentStatus: "APPROVED";
      snapshot: ApprovalSnapshot;
      /** True only when the APPROVAL_APPROVED audit write FAILED. */
      auditWriteFailed: boolean;
    }
  | {
      status: "rejected";
      approvalId: string;
      shipmentStatus: "REJECTED";
      /** True only when the APPROVAL_REJECTED audit write FAILED. */
      auditWriteFailed: boolean;
    }
  | { status: "not_ready"; blockers: ApprovalBlocker[] }
  | { status: "invalid_status"; shipmentStatus: ShipmentStatusValue }
  | { status: "already_decided"; decidedStatus: "PENDING" | "APPROVED" }
  | { status: "invalid_note" }
  | { status: "not_found" }
  | { status: "unavailable" };

// ---------------------------------------------------------------------------
// Readiness evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate one shipment against the approval rules. Read-only and
 * non-throwing by contract; every failure maps to a typed outcome.
 */
export async function evaluateShipmentReadiness(
  shipmentId: unknown,
): Promise<ShipmentReadinessResult> {
  const id = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(id)) {
    return { status: "not_found" };
  }

  let shipmentRow: { id: string; status: ShipmentStatusValue } | null = null;
  let activeDocs: Array<{
    id: string;
    documentType: DocumentEntryType;
    version: number;
    checksumSha256: string;
  }> = [];
  let attemptRows: Array<{
    id: string;
    documentId: string;
    attempt: number;
    status: string;
  }> = [];
  let blockingRows: Array<{
    type: string;
    status: "OPEN" | "RECHECK_PENDING";
    severity: string;
    scopeKey: string | null;
  }> = [];

  try {
    const [shipmentRows, docRows, extractionRows, discrepancyRows] =
      await Promise.all([
        db
          .select({ id: shipments.id, status: shipments.status })
          .from(shipments)
          .where(eq(shipments.id, id))
          .limit(1),
        db
          .select({
            id: documents.id,
            documentType: documents.documentType,
            version: documents.version,
            checksumSha256: documents.checksumSha256,
          })
          .from(documents)
          .where(
            and(eq(documents.shipmentId, id), eq(documents.isActive, true)),
          ),
        db
          .select({
            id: extractions.id,
            documentId: extractions.documentId,
            attempt: extractions.attempt,
            status: extractions.status,
          })
          .from(extractions)
          .where(eq(extractions.shipmentId, id)),
        db
          .select({
            type: discrepancies.type,
            status: discrepancies.status,
            severity: discrepancies.severity,
            scopeKey: discrepancies.scopeKey,
          })
          .from(discrepancies)
          .where(
            and(
              eq(discrepancies.shipmentId, id),
              inArray(discrepancies.status, [
                ...BLOCKING_DISCREPANCY_STATUSES,
              ]),
            ),
          ),
      ]);

    shipmentRow = shipmentRows[0] ?? null;
    activeDocs = docRows;
    attemptRows = extractionRows;
    blockingRows = discrepancyRows as typeof blockingRows;
  } catch {
    console.error(
      `[approval-service] Failed to read readiness (shipmentId=${id}).`,
    );
    return { status: "unavailable" };
  }

  if (!shipmentRow) {
    return { status: "not_found" };
  }

  // --- 1. Required documents present (one active version each) --------------
  const blockers: ApprovalBlocker[] = [];
  const activeByType = new Map<DocumentEntryType, (typeof activeDocs)[number]>();
  for (const doc of activeDocs) {
    // Defensive: the schema keeps one active version per type; the newest
    // wins if that invariant were ever violated.
    const existing = activeByType.get(doc.documentType);
    if (!existing || doc.version > existing.version) {
      activeByType.set(doc.documentType, doc);
    }
  }
  for (const documentType of REQUIRED_DOCUMENT_TYPES) {
    if (!activeByType.has(documentType)) {
      blockers.push({ code: "missing_document", documentType });
    }
  }

  // --- 2. Latest attempt per active document (max attempt, all statuses) ----
  const currentAttemptByDoc = new Map<
    string,
    (typeof attemptRows)[number]
  >();
  for (const row of attemptRows) {
    const current = currentAttemptByDoc.get(row.documentId);
    if (!current || row.attempt > current.attempt) {
      currentAttemptByDoc.set(row.documentId, row);
    }
  }
  const activeDocIds = new Set(activeDocs.map((doc) => doc.id));
  for (const [documentId, attempt] of currentAttemptByDoc) {
    if (!activeDocIds.has(documentId)) continue;
    if (attempt.status !== "COMPLETED") {
      const doc = activeDocs.find((entry) => entry.id === documentId);
      if (doc) {
        blockers.push({
          code: "attempt_not_completed",
          documentType: doc.documentType,
          attempt: attempt.attempt,
          extractionStatus: attempt.status,
        });
      }
    }
  }

  // --- 3. Required fields of the CURRENT attempt ACCEPTED or CORRECTED ------
  const currentExtractionIds = activeDocs
    .map((doc) => currentAttemptByDoc.get(doc.id))
    .filter(
      (attempt): attempt is NonNullable<typeof attempt> =>
        attempt !== undefined && attempt.status === "COMPLETED",
    )
    .map((attempt) => attempt.id);

  let fieldRows: Array<{
    extractionId: string;
    fieldKey: string;
    fieldLabel: string;
    reviewStatus: "PENDING_REVIEW" | "ACCEPTED" | "CORRECTED";
  }> = [];
  if (currentExtractionIds.length > 0) {
    try {
      fieldRows = await db
        .select({
          extractionId: extractedFields.extractionId,
          fieldKey: extractedFields.fieldKey,
          fieldLabel: extractedFields.fieldLabel,
          reviewStatus: extractedFields.reviewStatus,
        })
        .from(extractedFields)
        .where(inArray(extractedFields.extractionId, currentExtractionIds));
    } catch {
      console.error(
        `[approval-service] Failed to read reviewed fields (shipmentId=${id}).`,
      );
      return { status: "unavailable" };
    }
  }
  const fieldsByExtraction = new Map<string, Map<string, (typeof fieldRows)[number]>>();
  for (const row of fieldRows) {
    const byKey = fieldsByExtraction.get(row.extractionId) ?? new Map();
    byKey.set(row.fieldKey, row);
    fieldsByExtraction.set(row.extractionId, byKey);
  }

  for (const documentType of REQUIRED_DOCUMENT_TYPES) {
    const doc = activeByType.get(documentType);
    if (!doc) continue; // already reported as missing_document
    const current = currentAttemptByDoc.get(doc.id);
    if (!current || current.status !== "COMPLETED") {
      continue; // already reported as attempt_not_completed
    }
    const requiredKeys = getExtractionFieldCatalog(documentType).fields.filter(
      (definition) =>
        (definition as { required?: boolean }).required === true,
    );
    const byKey = fieldsByExtraction.get(current.id);
    for (const definition of requiredKeys) {
      const field = byKey?.get(definition.key);
      if (!field) {
        blockers.push({
          code: "required_field_missing",
          documentType,
          fieldKey: definition.key,
          fieldLabel: definition.label,
        });
        continue;
      }
      if (field.reviewStatus === "PENDING_REVIEW") {
        blockers.push({
          code: "required_field_pending",
          documentType,
          fieldKey: definition.key,
          fieldLabel: field.fieldLabel,
        });
      }
    }
  }

  // --- 4. Blocking discrepancies (OPEN / RECHECK_PENDING, any severity) ------
  for (const row of blockingRows) {
    blockers.push({
      code: "blocking_discrepancy",
      discrepancyType: row.type,
      status: row.status,
      severity: row.severity,
      scopeKey: row.scopeKey,
    });
  }

  // --- Snapshot (tamper evidence; only when complete) -----------------------
  let snapshot: ApprovalSnapshot | null = null;
  if (blockers.length === 0) {
    const orderedDocs = REQUIRED_DOCUMENT_TYPES.map((documentType) =>
      activeByType.get(documentType),
    ).filter((doc): doc is NonNullable<typeof doc> => doc !== undefined);

    snapshot = {
      documents: orderedDocs.map((doc) => ({
        documentId: doc.id,
        documentType: doc.documentType,
        version: doc.version,
        checksumSha256: doc.checksumSha256,
      })),
      extractions: orderedDocs.map((doc) => ({
        documentId: doc.id,
        extractionId: currentAttemptByDoc.get(doc.id)!.id,
      })),
      checkRunKey: CHECK_RUN_KEY,
      capturedAt: new Date().toISOString(),
    };
  }

  return {
    status: "success",
    shipmentStatus: shipmentRow.status,
    ready: blockers.length === 0,
    blockers,
    snapshot,
  };
}

// ---------------------------------------------------------------------------
// Shared decision helpers
// ---------------------------------------------------------------------------

/** Latest approval row for a shipment, or null when none exists yet. */
const loadLatestApproval = async (
  shipmentId: string,
): Promise<{
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "INVALIDATED";
} | null> => {
  const rows = await db
    .select({ id: approvals.id, status: approvals.status })
    .from(approvals)
    .where(eq(approvals.shipmentId, shipmentId))
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Compensation for a decision whose guarded shipment update did not apply:
 * the just-inserted live row is flipped to INVALIDATED (never deleted) so the
 * shipment is not left with a phantom decision. Returns true when the row was
 * invalidated.
 */
const compensateDecisionRow = async (
  approvalId: string,
  fromStatus: "APPROVED" | "REJECTED",
): Promise<boolean> => {
  try {
    const rows = await db
      .update(approvals)
      .set({ status: "INVALIDATED" })
      .where(
        and(eq(approvals.id, approvalId), eq(approvals.status, fromStatus)),
      )
      .returning({ id: approvals.id });
    return rows.length > 0;
  } catch {
    return false;
  }
};

/** DB failure while writing the guarded shipment status. */
const failShipmentUpdate = async (
  approvalId: string,
  fromStatus: "APPROVED" | "REJECTED",
  shipmentId: string,
): Promise<{ status: "unavailable" }> => {
  const compensated = await compensateDecisionRow(approvalId, fromStatus);
  console.error(
    `[approval-service] Guarded shipment update failed (shipmentId=${shipmentId}, ` +
      `approvalId=${approvalId}, compensated=${compensated}).`,
  );
  return { status: "unavailable" };
};

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

/**
 * Manager approval. The caller has already verified the manager role and the
 * actor id; this service records it and re-checks all readiness rules.
 */
export async function approveShipment(
  shipmentId: unknown,
  actorId: AuditActor,
): Promise<ApprovalDecisionOutcome> {
  const sid = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(sid)) {
    return { status: "not_found" };
  }
  if (typeof actorId !== "string" || actorId.trim().length === 0) {
    console.error("[approval-service] Approval requires a session actor.");
    return { status: "unavailable" };
  }

  // --- 1. Live decision? (Cheap early exit; race-safe via the unique index.) --
  let latest: Awaited<ReturnType<typeof loadLatestApproval>>;
  try {
    latest = await loadLatestApproval(sid);
  } catch {
    console.error(
      `[approval-service] Failed to read existing approvals (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }
  if (latest && (latest.status === "PENDING" || latest.status === "APPROVED")) {
    return { status: "already_decided", decidedStatus: latest.status };
  }

  // --- 2. Readiness ---------------------------------------------------------
  const readiness = await evaluateShipmentReadiness(sid);
  if (readiness.status !== "success") {
    return readiness;
  }
  if (readiness.shipmentStatus === "APPROVED") {
    return { status: "already_decided", decidedStatus: "APPROVED" };
  }
  if (
    !(APPROVABLE_FROM as readonly string[]).includes(readiness.shipmentStatus)
  ) {
    return {
      status: "invalid_status",
      shipmentStatus: readiness.shipmentStatus,
    };
  }
  if (!readiness.ready || readiness.snapshot === null) {
    return { status: "not_ready", blockers: readiness.blockers };
  }

  // --- 3. Insert the APPROVED row with its mandatory snapshot ---------------
  let approvalId: string;
  try {
    const inserted = await db
      .insert(approvals)
      .values({
        shipmentId: sid,
        status: "APPROVED",
        // Single-step manager decision: the decider is also the requester.
        requestedBy: actorId,
        decidedBy: actorId,
        decidedAt: new Date(),
        approvalSnapshot: readiness.snapshot,
        supersedesId: latest?.id ?? null,
      })
      .returning({ id: approvals.id });
    if (inserted.length === 0) {
      throw new Error("APPROVAL_INSERT_EMPTY");
    }
    approvalId = inserted[0].id;
  } catch {
    // Includes `approvals_live_uq`: a concurrent decision won the race.
    try {
      const live = await loadLatestApproval(sid);
      if (live && (live.status === "PENDING" || live.status === "APPROVED")) {
        return { status: "already_decided", decidedStatus: live.status };
      }
    } catch {
      // fall through
    }
    console.error(
      `[approval-service] Approval insert failed (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }

  // --- 4. Guarded shipment transition ---------------------------------------
  try {
    const updated = await db
      .update(shipments)
      .set({ status: "APPROVED" })
      .where(
        and(
          eq(shipments.id, sid),
          inArray(shipments.status, [...APPROVABLE_FROM]),
        ),
      )
      .returning({ id: shipments.id });
    if (updated.length === 0) {
      const compensated = await compensateDecisionRow(approvalId, "APPROVED");
      const live = await evaluateShipmentReadiness(sid).catch(() => null);
      console.error(
        `[approval-service] Shipment status changed concurrently ` +
          `(shipmentId=${sid}, compensated=${compensated}).`,
      );
      return {
        status: "invalid_status",
        shipmentStatus:
          live && live.status === "success" ? live.shipmentStatus : "APPROVED",
      };
    }
  } catch {
    return failShipmentUpdate(approvalId, "APPROVED", sid);
  }

  // --- 5. Audit (partial success reported, never silently swallowed) --------
  let auditWriteFailed = false;
  try {
    await appendAuditLog({
      action: AUDIT_ACTIONS.approvalApproved,
      entityType: AUDIT_ENTITY_TYPES.approval,
      entityId: approvalId,
      actorId,
      shipmentId: sid,
      details: {
        decision: "APPROVED",
        documentCount: readiness.snapshot.documents.length,
        extractionCount: readiness.snapshot.extractions.length,
        checkRunKey: readiness.snapshot.checkRunKey ?? null,
        capturedAt: readiness.snapshot.capturedAt,
        replacedPreviousDecision: latest !== null,
      },
    });
  } catch {
    auditWriteFailed = true;
    console.error(
      "[approval-service] APPROVAL_APPROVED audit write failed " +
        `(shipmentId=${sid}, approvalId=${approvalId}) — audit trail requires manual backfill.`,
    );
  }

  return {
    status: "approved",
    approvalId,
    shipmentStatus: "APPROVED",
    snapshot: readiness.snapshot,
    auditWriteFailed,
  };
}

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

/**
 * Manager rejection. Requires a documented note (1-500 chars); readiness is
 * deliberately NOT required — rejection is how an incomplete shipment is sent
 * back. A live APPROVED/PENDING row still blocks the decision.
 */
export async function rejectShipment(
  shipmentId: unknown,
  noteRaw: unknown,
  actorId: AuditActor,
): Promise<ApprovalDecisionOutcome> {
  const sid = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(sid)) {
    return { status: "not_found" };
  }
  if (typeof actorId !== "string" || actorId.trim().length === 0) {
    console.error("[approval-service] Rejection requires a session actor.");
    return { status: "unavailable" };
  }
  if (
    typeof noteRaw !== "string" ||
    noteRaw.trim().length === 0 ||
    noteRaw.trim().length > MAX_DECISION_NOTE_CHARS
  ) {
    return { status: "invalid_note" };
  }
  const note = noteRaw.trim();

  // --- 1. Shipment exists + current status ---------------------------------
  let shipmentRow: { status: ShipmentStatusValue } | null = null;
  try {
    const rows = await db
      .select({ status: shipments.status })
      .from(shipments)
      .where(eq(shipments.id, sid))
      .limit(1);
    shipmentRow = rows[0] ?? null;
  } catch {
    console.error(
      `[approval-service] Failed to read shipment for rejection (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }
  if (!shipmentRow) {
    return { status: "not_found" };
  }

  // --- 2. Live decision? ----------------------------------------------------
  let latest: Awaited<ReturnType<typeof loadLatestApproval>>;
  try {
    latest = await loadLatestApproval(sid);
  } catch {
    console.error(
      `[approval-service] Failed to read existing approvals (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }
  if (latest && (latest.status === "PENDING" || latest.status === "APPROVED")) {
    return { status: "already_decided", decidedStatus: latest.status };
  }
  if (
    !(REJECTABLE_FROM as readonly string[]).includes(shipmentRow.status)
  ) {
    return { status: "invalid_status", shipmentStatus: shipmentRow.status };
  }

  // --- 3. Insert the REJECTED row (snapshot not required) -------------------
  let approvalId: string;
  try {
    const inserted = await db
      .insert(approvals)
      .values({
        shipmentId: sid,
        status: "REJECTED",
        requestedBy: actorId,
        decidedBy: actorId,
        decidedAt: new Date(),
        decisionNote: note,
        supersedesId: latest?.id ?? null,
      })
      .returning({ id: approvals.id });
    if (inserted.length === 0) {
      throw new Error("APPROVAL_INSERT_EMPTY");
    }
    approvalId = inserted[0].id;
  } catch {
    try {
      const live = await loadLatestApproval(sid);
      if (live && (live.status === "PENDING" || live.status === "APPROVED")) {
        return { status: "already_decided", decidedStatus: live.status };
      }
    } catch {
      // fall through
    }
    console.error(
      `[approval-service] Rejection insert failed (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }

  // --- 4. Guarded shipment transition ---------------------------------------
  try {
    const updated = await db
      .update(shipments)
      .set({ status: "REJECTED" })
      .where(
        and(
          eq(shipments.id, sid),
          inArray(shipments.status, [...REJECTABLE_FROM]),
        ),
      )
      .returning({ id: shipments.id });
    if (updated.length === 0) {
      const compensated = await compensateDecisionRow(approvalId, "REJECTED");
      console.error(
        `[approval-service] Rejection status changed concurrently ` +
          `(shipmentId=${sid}, compensated=${compensated}).`,
      );
      return {
        status: "invalid_status",
        shipmentStatus: shipmentRow.status,
      };
    }
  } catch {
    return failShipmentUpdate(approvalId, "REJECTED", sid);
  }

  // --- 5. Audit (partial success reported) ---------------------------------
  let auditWriteFailed = false;
  try {
    await appendAuditLog({
      action: AUDIT_ACTIONS.approvalRejected,
      entityType: AUDIT_ENTITY_TYPES.approval,
      entityId: approvalId,
      actorId,
      shipmentId: sid,
      details: {
        decision: "REJECTED",
        note,
        replacedPreviousDecision: latest !== null,
      },
    });
  } catch {
    auditWriteFailed = true;
    console.error(
      "[approval-service] APPROVAL_REJECTED audit write failed " +
        `(shipmentId=${sid}, approvalId=${approvalId}) — audit trail requires manual backfill.`,
    );
  }

  return {
    status: "rejected",
    approvalId,
    shipmentStatus: "REJECTED",
    auditWriteFailed,
  };
}
