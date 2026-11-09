import "server-only";

/**
 * Approval INVALIDATION service — the sanctioned writer of the event-driven
 * `approvals` transitions to INVALIDATED (safeguard: approvals survive as
 * history; nothing is ever deleted).
 *
 * The `INVALIDATED` flip already exists in two narrow places owned by
 * approval-service.ts (`compensateDecisionRow` after a failed guarded
 * shipment update). This service owns the OTHER side of the same safeguard:
 * the approval row's frozen snapshot (`approvalSnapshot`) must always
 * describe the evidence the shipment would still export. Any evidence event
 * — a document replacement, a new extraction attempt, a human correction, or
 * a discrepancy becoming OPEN / RECHECK_PENDING — makes a live approval
 * decision (PENDING or APPROVED) stale, and this service retires it:
 *
 *   1. the live row (at most ONE exists; `approvals_live_uq`) flips
 *      PENDING|APPROVED -> INVALIDATED (guarded UPDATE, never deleted);
 *   2. a shipment standing in APPROVED transitions back to REVIEW (guarded
 *      UPDATE re-verifying the live status) so it can be re-approved once
 *      the evidence converges again (REVIEW is inside APPROVABLE_FROM);
 *   3. an APPROVAL_INVALIDATED audit event records the reason, the
 *      decision/shipment status before and after and the snapshot drift
 *      codes — never checksums, storage keys or actor ids (the writer is
 *      the row's own actorId column);
 *   4. a DEFENSIVE recovery: a shipment in APPROVED with NO live approval
 *      row (approved_state_missing) is flipped to REVIEW and audited with a
 *      null entity id — an approved shipment must never exist without a
 *      live decision behind it.
 *
 * Write-then-audit order (partial-success pattern, as correction-service):
 * the guarded writes apply first; a failed audit write is reported with
 * `auditWriteFailed: true` (manual backfill) and NEVER rolled back or
 * retried — the neon-http driver cannot re-safely retry a statement.
 * Another evidence event retries the whole invalidation naturally: with no
 * live row left it is a pure no-op.
 *
 * Snapshot freshness (`evaluateApprovalSnapshotFreshness`, also used by the
 * approval tab) is a DEFENSIVE read-only comparison of the frozen snapshot
 * against the CURRENT database state: active documents (ids, versions,
 * checksums — compared, never emitted) and the CURRENT extraction attempt
 * per document (max(attempt) across ALL statuses, the same freshness law
 * the check/read services use). A live row invalidates for its EVENT reason
 * regardless of the freshness outcome — the trigger itself is the evidence
 * change — the drift codes are reported for the audit trail and UI.
 *
 * Privacy contract: console messages carry ids, reason codes and failure
 * type names only. Values compared stay server-side; no checksum, storage
 * key or actor id is ever logged or returned.
 */

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  approvals,
  documents,
  extractions,
  shipmentStatus,
  shipments,
} from "@/lib/db/schema";
import type { ApprovalSnapshot } from "@/lib/db/schema";
import {
  appendAuditLog,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  tryAppendAuditLog,
  type AuditActor,
} from "./audit-service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ShipmentStatusValue = (typeof shipmentStatus.enumValues)[number];

/** Live decision statuses that invalidation retires. */
const LIVE_APPROVAL_STATUSES = ["PENDING", "APPROVED"] as const;

/** Runtime narrowing of an approval row to the live statuses the SQL filters
 * on (Drizzle types the column with the full enum union). */
const isLiveApprovalStatus = (
  status: "PENDING" | "APPROVED" | "REJECTED" | "INVALIDATED",
): status is "PENDING" | "APPROVED" =>
  status === "PENDING" || status === "APPROVED";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** Why an invalidation ran (the evidence event that triggered it). */
export type ApprovalInvalidationReason =
  /** A document was uploaded/replaced (or its active version vanished). */
  | "document_replaced"
  /** A new extraction attempt row changed the documents' current evidence. */
  | "evidence_re_extracted"
  /** A human field correction was applied. */
  | "field_corrected"
  /** A discrepancy was created or (re-)confirmed into OPEN. */
  | "discrepancy_open"
  /** A live discrepancy moved OPEN -> RECHECK_PENDING. */
  | "discrepancy_recheck_pending";

/**
 * Coarse, client-safe snapshot drift codes (comparison results only — never
 * the values themselves).
 */
export const SNAPSHOT_DRIFT_CODES = [
  /** A snapshot document is no longer active and no active version of its
   * document type remains. */
  "document_missing",
  /** A snapshot document is no longer active (it was replaced) or an active
   * document of the shipment is absent from the snapshot. */
  "document_version_changed",
  /** The active document still exists but its content digest differs from
   * the snapshot's record (compared server-side; never emitted). */
  "document_checksum_changed",
  /** The document's CURRENT attempt (max across ALL statuses) is no longer
   * the attempt the snapshot paired with it. */
  "attempt_superseded",
  /** The snapshot's paired attempt is still current but no longer COMPLETED. */
  "attempt_not_completed",
  /** The stored snapshot is absent (live PENDING row) or structurally
   * unusable — it cannot prove anything, so it counts as drift. */
  "snapshot_malformed",
  /** Defensive state check: the shipment stands APPROVED with no live
   * approval row behind it. */
  "approved_state_missing",
] as const;

export type SnapshotDriftCode = (typeof SNAPSHOT_DRIFT_CODES)[number];

/** Read-only defensive freshness result (also used by the approval tab). */
export type SnapshotFreshnessResult =
  | {
      status: "evaluated";
      fresh: boolean;
      driftCodes: readonly SnapshotDriftCode[];
    }
  /** Shipment UUID malformed or not found (no row was read). */
  | { status: "not_found" }
  /** No live (PENDING|APPROVED) approval row exists for the shipment. */
  | { status: "no_live_approval" }
  | { status: "unavailable" };

export type ApprovalInvalidationOutcome =
  | {
      /** A live approval row was retired as INVALIDATED (history kept). */
      status: "invalidated";
      reason: ApprovalInvalidationReason;
      approvalId: string;
      approvalStatusBefore: "PENDING" | "APPROVED";
      shipmentStatusBefore: ShipmentStatusValue;
      /** Shipment status AFTER the (attempted) transition. */
      shipmentStatusAfter: ShipmentStatusValue;
      /** True only when the guarded APPROVED -> REVIEW flip actually applied. */
      shipmentTransitionApplied: boolean;
      driftCodes: readonly SnapshotDriftCode[];
      /** True when the freshness comparison itself could not be evaluated. */
      freshnessUnavailable: boolean;
      /** True only when the audit write FAILED — manual backfill needed and
       * the state change above still applied (partial success). */
      auditWriteFailed: boolean;
    }
  | {
      /** Defensive recovery: shipment APPROVED with no live decision row —
       * flipped back to REVIEW (or already changed) and audited with a null
       * approval entity id. */
      status: "shipment_state_recovered";
      reason: "snapshot_drift";
      shipmentStatusBefore: "APPROVED";
      shipmentStatusAfter: ShipmentStatusValue;
      driftCodes: readonly SnapshotDriftCode[];
      auditWriteFailed: boolean;
    }
  | {
      /** Nothing live existed (and the shipment was not unjustifiably
       * APPROVED) — a pure no-op, so repeated hooks converge. */
      status: "no_live_approval";
      shipmentStatus: ShipmentStatusValue;
    }
  | {
      /** A live decision existed at read time but was retired (or the live
       * row changed) by a concurrent flow before this guarded write. */
      status: "concurrent_no_op";
    }
  | {
      /** The triggering run wrote no evidence change (used by callers that
       * always report an outcome; nothing was checked or invalidated). */
      status: "no_evidence_change";
    }
  | { status: "not_found" }
  | { status: "unavailable" };

// ---------------------------------------------------------------------------
// Snapshot freshness (defensive, read-only)
// ---------------------------------------------------------------------------

/** Runtime validation of the snapshot JSONB (schema-typed, read defensively). */
const parseSnapshot = (raw: unknown): ApprovalSnapshot | null => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<ApprovalSnapshot>;
  if (!Array.isArray(candidate.documents) || !Array.isArray(candidate.extractions)) {
    return null;
  }
  for (const doc of candidate.documents) {
    if (
      doc === null ||
      typeof doc !== "object" ||
      typeof doc.documentId !== "string" ||
      typeof doc.documentType !== "string" ||
      typeof doc.version !== "number" ||
      !Number.isFinite(doc.version) ||
      typeof doc.checksumSha256 !== "string"
    ) {
      return null;
    }
  }
  for (const pair of candidate.extractions) {
    if (
      pair === null ||
      typeof pair !== "object" ||
      typeof pair.documentId !== "string" ||
      typeof pair.extractionId !== "string"
    ) {
      return null;
    }
  }
  return candidate as ApprovalSnapshot;
};

/**
 * Compare ONE live row's snapshot against the current database state.
 * Returns the drift codes (empty = fresh) or null when the comparison
 * itself could not run (DB failure — the caller reports that separately).
 */
const computeSnapshotDrift = async (
  shipmentId: string,
  snapshotRaw: unknown,
): Promise<{
  driftCodes: SnapshotDriftCode[];
  evaluated: boolean;
} | null> => {
  const snapshot = parseSnapshot(snapshotRaw);
  if (!snapshot) {
    return { driftCodes: ["snapshot_malformed"], evaluated: true };
  }

  let activeDocs: Array<{
    id: string;
    documentType: string;
    version: number;
    checksumSha256: string;
  }>;
  let attemptRows: Array<{
    id: string;
    documentId: string;
    attempt: number;
    status: string;
  }>;
  try {
    activeDocs = await db
      .select({
        id: documents.id,
        documentType: documents.documentType,
        version: documents.version,
        checksumSha256: documents.checksumSha256,
      })
      .from(documents)
      .where(
        and(
          eq(documents.shipmentId, shipmentId),
          eq(documents.isActive, true),
        ),
      );
    attemptRows = await db
      .select({
        id: extractions.id,
        documentId: extractions.documentId,
        attempt: extractions.attempt,
        status: extractions.status,
      })
      .from(extractions)
      .where(eq(extractions.shipmentId, shipmentId));
  } catch {
    return null; // freshness comparison unavailable, not drift
  }

  const activeById = new Map(activeDocs.map((doc) => [doc.id, doc]));
  const snapshotDocIds = new Set(
    snapshot.documents.map((doc) => doc.documentId),
  );
  const drift = new Set<SnapshotDriftCode>();

  // Snapshot documents must still be the active versions with the same
  // content. Checksums are compared but never emitted.
  for (const doc of snapshot.documents) {
    const current = activeById.get(doc.documentId);
    if (!current) {
      const anyActiveOfType = activeDocs.some(
        (entry) => entry.documentType === doc.documentType,
      );
      drift.add(anyActiveOfType ? "document_version_changed" : "document_missing");
      continue;
    }
    if (current.version !== doc.version) {
      drift.add("document_version_changed");
    }
    if (current.checksumSha256 !== doc.checksumSha256) {
      drift.add("document_checksum_changed");
    }
  }

  // Reverse check: an active document absent from the snapshot means
  // evidence appeared or was replaced after the snapshot was captured.
  for (const active of activeDocs) {
    if (!snapshotDocIds.has(active.id)) {
      drift.add("document_version_changed");
    }
  }

  // CURRENT attempt per document: max(attempt) across ALL statuses — the
  // status law, never a fallback to an older COMPLETED attempt.
  const currentAttemptByDoc = new Map<
    string,
    { id: string; status: string; attempt: number }
  >();
  for (const row of attemptRows) {
    const existing = currentAttemptByDoc.get(row.documentId);
    if (!existing || row.attempt > existing.attempt) {
      currentAttemptByDoc.set(row.documentId, {
        id: row.id,
        status: row.status,
        attempt: row.attempt,
      });
    }
  }

  for (const pair of snapshot.extractions) {
    const current = currentAttemptByDoc.get(pair.documentId);
    if (!current || current.id !== pair.extractionId) {
      drift.add("attempt_superseded");
    } else if (current.status !== "COMPLETED") {
      drift.add("attempt_not_completed");
    }
  }

  return { driftCodes: [...drift], evaluated: true };
};

/**
 * Defensive read-only freshness check for one shipment's live approval row.
 * Non-throwing; DB failures map to `unavailable` WITHOUT claiming drift.
 */
export async function evaluateApprovalSnapshotFreshness(
  shipmentId: unknown,
): Promise<SnapshotFreshnessResult> {
  const sid = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(sid)) {
    return { status: "not_found" };
  }

  let liveRow: { id: string; approvalSnapshot: ApprovalSnapshot | null } | null;
  try {
    const rows = await db
      .select({ id: approvals.id, approvalSnapshot: approvals.approvalSnapshot })
      .from(approvals)
      .where(
        and(
          eq(approvals.shipmentId, sid),
          inArray(approvals.status, [...LIVE_APPROVAL_STATUSES]),
        ),
      )
      .limit(1);
    liveRow = rows[0] ?? null;
  } catch {
    console.error(
      `[approval-invalidation-service] Freshness read failed (shipmentId=${sid}).`,
    );
    return { status: "unavailable" };
  }
  if (!liveRow) {
    return { status: "no_live_approval" };
  }

  const drift = await computeSnapshotDrift(sid, liveRow.approvalSnapshot);
  if (drift === null) {
    return { status: "unavailable" };
  }
  return {
    status: "evaluated",
    fresh: drift.driftCodes.length === 0,
    driftCodes: drift.driftCodes,
  };
}

// ---------------------------------------------------------------------------
// Invalidation entry point
// ---------------------------------------------------------------------------

/**
 * Retire every live approval decision of one shipment after an evidence
 * event. Non-throwing by contract; every failure maps to a typed outcome so
 * triggering services report it without demoting their own completed work.
 * The actor is the triggering request's server-verified actor id (or a null
 * system actor from a recover path — recorded on the audit row itself).
 */
export async function invalidateApprovalsForShipment(
  shipmentId: unknown,
  reason: ApprovalInvalidationReason,
  actorId: AuditActor,
): Promise<ApprovalInvalidationOutcome> {
  const sid = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(sid)) {
    return { status: "not_found" };
  }

  // --- 1. Shipment + live approval row (two cheap reads) ---------------------
  let shipmentStatus: ShipmentStatusValue;
  try {
    const rows = await db
      .select({ status: shipments.status })
      .from(shipments)
      .where(eq(shipments.id, sid))
      .limit(1);
    if (!rows[0]) {
      return { status: "not_found" };
    }
    shipmentStatus = rows[0].status;
  } catch {
    console.error(
      `[approval-invalidation-service] Shipment read failed (shipmentId=${sid}, reason=${reason}).`,
    );
    return { status: "unavailable" };
  }

  let liveRow: {
    id: string;
    status: "PENDING" | "APPROVED";
    approvalSnapshot: ApprovalSnapshot | null;
  } | null = null;
  try {
    const rows = await db
      .select({
        id: approvals.id,
        status: approvals.status,
        approvalSnapshot: approvals.approvalSnapshot,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.shipmentId, sid),
          inArray(approvals.status, [...LIVE_APPROVAL_STATUSES]),
        ),
      )
      .limit(1);
    const row = rows[0];
    liveRow =
      row && isLiveApprovalStatus(row.status)
        ? {
            id: row.id,
            status: row.status,
            approvalSnapshot: row.approvalSnapshot,
          }
        : null;
  } catch {
    console.error(
      `[approval-invalidation-service] Live-approval read failed (shipmentId=${sid}, reason=${reason}).`,
    );
    return { status: "unavailable" };
  }

  // --- 2. Defensive freshness comparison (read-only, non-blocking) ----------
  // The event reason is authoritative; drift codes enrich the audit record
  // and the UI. A failed comparison never aborts the invalidation.
  let driftCodes: readonly SnapshotDriftCode[] = [];
  let freshnessUnavailable = false;
  if (liveRow) {
    const drift = await computeSnapshotDrift(sid, liveRow.approvalSnapshot);
    if (drift === null) {
      freshnessUnavailable = true;
    } else {
      driftCodes = drift.driftCodes;
    }
  }

  // --- 3. Defensive recovery: APPROVED shipment with NO live decision -------
  if (!liveRow) {
    if (shipmentStatus !== "APPROVED") {
      return { status: "no_live_approval", shipmentStatus };
    }
    // approved_state_missing: flip APPROVED -> REVIEW and audit honestly
    // (entityId null — there is no approval row to point at).
    let recovered: Array<{ status: ShipmentStatusValue }>;
    try {
      recovered = await db
        .update(shipments)
        .set({ status: "REVIEW" })
        .where(
          and(eq(shipments.id, sid), eq(shipments.status, "APPROVED")),
        )
        .returning({ status: shipments.status });
    } catch {
      console.error(
        `[approval-invalidation-service] approved_state_missing recovery ` +
          `write failed (shipmentId=${sid}) — the shipment stands APPROVED ` +
          "without a live approval row.",
      );
      return { status: "unavailable" };
    }
    const shipmentStatusAfter = recovered[0]?.status ?? shipmentStatus;
    console.error(
      `[approval-invalidation-service] approved_state_missing recovered ` +
        `(shipmentId=${sid}, applied=${recovered.length > 0}).`,
    );
    const { ok: auditOk } = await tryAppendAuditLog({
      action: AUDIT_ACTIONS.approvalInvalidated,
      entityType: AUDIT_ENTITY_TYPES.approval,
      entityId: null,
      actorId,
      shipmentId: sid,
      details: {
        reason: "snapshot_drift",
        driftCodes: ["approved_state_missing"],
        shipmentStatusBefore: shipmentStatus,
        shipmentStatusAfter,
        stateChangeNotApplied: recovered.length > 0 ? undefined : "shipment_update_not_applied",
      },
    });
    return {
      status: "shipment_state_recovered",
      reason: "snapshot_drift",
      shipmentStatusBefore: "APPROVED",
      shipmentStatusAfter,
      driftCodes: ["approved_state_missing"],
      auditWriteFailed: !auditOk,
    };
  }

  // --- 4. Guarded write 1: retire the live row (history preserved) ----------
  let invalidatedRows: Array<{ id: string }>;
  try {
    invalidatedRows = await db
      .update(approvals)
      .set({ status: "INVALIDATED" })
      .where(
        and(
          eq(approvals.id, liveRow.id),
          inArray(approvals.status, [...LIVE_APPROVAL_STATUSES]),
        ),
      )
      .returning({ id: approvals.id });
  } catch {
    console.error(
      `[approval-invalidation-service] Approval retirement write failed ` +
        `(shipmentId=${sid}, approvalId=${liveRow.id}, reason=${reason}).`,
    );
    return { status: "unavailable" };
  }

  if (invalidatedRows.length === 0) {
    // A concurrent flow already retired/finished the row (approvals_live_uq
    // guarantees at most one). Nothing was written here; the winner owns the
    // audit and the shipment transition. The next evidence event re-checks.
    console.error(
      `[approval-invalidation-service] Concurrent retirement detected — ` +
        `guarded flip matched no live row (shipmentId=${sid}, approvalId=${liveRow.id}, reason=${reason}).`,
    );
    return { status: "concurrent_no_op" };
  }

  // --- 5. Guarded write 2: APPROVED -> REVIEW (only when standing APPROVED).
  // REVIEW is in APPROVABLE_FROM, so re-approval stays possible; DRAFT/
  // PROCESSING/REJECTED/etc. shipments need no transition at all.
  let shipmentStatusAfter: ShipmentStatusValue = shipmentStatus;
  let shipmentTransitionApplied = false;
  if (shipmentStatus === "APPROVED") {
    let flipped: Array<{ status: ShipmentStatusValue }>;
    try {
      flipped = await db
        .update(shipments)
        .set({ status: "REVIEW" })
        .where(and(eq(shipments.id, sid), eq(shipments.status, "APPROVED")))
        .returning({ status: shipments.status });
    } catch {
      // The approval row IS retired; only the shipment transition failed.
      // The next evidence event retries — but this gap is surfaced loudly.
      console.error(
        `[approval-invalidation-service] APPROVED -> REVIEW transition ` +
          `write failed (shipmentId=${sid}, approvalId=${liveRow.id}) — the ` +
          "approval stands INVALIDATED while the shipment may still be APPROVED.",
      );
      return {
        status: "invalidated",
        reason,
        approvalId: liveRow.id,
        approvalStatusBefore: liveRow.status,
        shipmentStatusBefore: shipmentStatus,
        shipmentStatusAfter: shipmentStatus,
        shipmentTransitionApplied: false,
        driftCodes,
        freshnessUnavailable,
        auditWriteFailed: false,
      };
    }
    if (flipped[0]) {
      shipmentStatusAfter = flipped[0].status;
      shipmentTransitionApplied = true;
    }
  }

  // --- 6. Audit (partial-success pattern: state is persisted; a failed
  // write is reported, never rolled back or retried) --------------------------
  let auditWriteFailed = false;
  try {
    await appendAuditLog({
      action: AUDIT_ACTIONS.approvalInvalidated,
      entityType: AUDIT_ENTITY_TYPES.approval,
      entityId: liveRow.id,
      actorId,
      shipmentId: sid,
      details: {
        reason,
        approvalStatusBefore: liveRow.status,
        approvalStatusAfter: "INVALIDATED",
        shipmentStatusBefore: shipmentStatus,
        shipmentStatusAfter,
        shipmentTransitionApplied,
        driftCodes: [...driftCodes],
        freshnessUnavailable: freshnessUnavailable || undefined,
      },
    });
  } catch {
    auditWriteFailed = true;
    console.error(
      `[approval-invalidation-service] APPROVAL_INVALIDATED audit write failed ` +
        `(shipmentId=${sid}, approvalId=${liveRow.id}, reason=${reason}) — ` +
        "audit trail requires manual backfill.",
    );
  }

  return {
    status: "invalidated",
    reason,
    approvalId: liveRow.id,
    approvalStatusBefore: liveRow.status,
    shipmentStatusBefore: shipmentStatus,
    shipmentStatusAfter,
    shipmentTransitionApplied,
    driftCodes,
    freshnessUnavailable,
    auditWriteFailed,
  };
}

/** Compact client-safe projection helper for route bodies. */
export const countInvalidations = (
  outcome: ApprovalInvalidationOutcome,
): number =>
  outcome.status === "invalidated" || outcome.status === "shipment_state_recovered"
    ? 1
    : 0;

/** True when the invalidation's own audit entry needs manual backfill. */
export const invalidationAuditFailed = (
  outcome: ApprovalInvalidationOutcome,
): boolean => "auditWriteFailed" in outcome && outcome.auditWriteFailed;

// ---------------------------------------------------------------------------
// Client-safe projection (for Route Handler bodies — server-side only)
// ---------------------------------------------------------------------------

/** The wire-safe shape routes report: coarse statuses, reason and drift
 * codes are service-vocabulary constants; no approval ids, no checksums. */
export interface ApprovalInvalidationSummary {
  status:
    | "invalidated"
    | "shipment_state_recovered"
    | "no_live_approval"
    | "concurrent_no_op"
    | "no_evidence_change"
    | "not_found"
    | "unavailable";
  /** Trigger reason for `invalidated`; the recovery marker otherwise. */
  reason: string | null;
  driftCodes: readonly SnapshotDriftCode[];
  /** True only when the retirement applied but its audit write failed. */
  auditWriteFailed: boolean;
  /** Shipment status after the (attempted) transition; null when unknown. */
  shipmentStatusAfter: string | null;
}

export const summarizeApprovalInvalidation = (
  outcome: ApprovalInvalidationOutcome,
): ApprovalInvalidationSummary => {
  switch (outcome.status) {
    case "invalidated":
      return {
        status: "invalidated",
        reason: outcome.reason,
        driftCodes: outcome.driftCodes,
        auditWriteFailed: outcome.auditWriteFailed,
        shipmentStatusAfter: outcome.shipmentStatusAfter,
      };
    case "shipment_state_recovered":
      return {
        status: "shipment_state_recovered",
        reason: "snapshot_drift",
        driftCodes: outcome.driftCodes,
        auditWriteFailed: outcome.auditWriteFailed,
        shipmentStatusAfter: outcome.shipmentStatusAfter,
      };
    case "no_live_approval":
      return {
        status: "no_live_approval",
        reason: null,
        driftCodes: [],
        auditWriteFailed: false,
        shipmentStatusAfter: outcome.shipmentStatus,
      };
    case "concurrent_no_op":
    case "no_evidence_change":
    case "not_found":
    case "unavailable":
      return {
        status: outcome.status,
        reason: null,
        driftCodes: [],
        auditWriteFailed: false,
        shipmentStatusAfter: null,
      };
  }
};
