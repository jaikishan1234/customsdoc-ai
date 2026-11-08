import "server-only";

/**
 * Append-only audit log writer (safeguard 2 in the schema design).
 *
 * This service is the ONLY sanctioned writer of audit_logs. It exposes no
 * update or delete operations — audit rows are immutable by contract; the
 * table also carries no mutation helpers. Columns follow src/lib/db/schema/
 * auditLogs.ts exactly (actorId, action, entityType, entityId, shipmentId,
 * details).
 *
 * `details` payloads must already be JSON-safe — no Dates, functions or class
 * instances — and must never contain credentials, tokens or secrets.
 */

import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";

export const AUDIT_ENTITY_TYPES = {
  shipment: "shipment",
  document: "document",
  approval: "approval",
  /** The live discrepancy row touched by a cross-check re-evaluation. */
  discrepancy: "discrepancy",
  /** A field_corrections row (human field correction; append-only). */
  fieldCorrection: "fieldCorrection",
  /** An extracted_fields row whose reviewStatus was human-accepted. */
  extractedField: "extractedField",
  /** A recovered (backfilled) audit row, referenced by its audit_logs id. */
  auditEntry: "auditEntry",
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];

/** Canonical audit action strings. Callers must use these constants. */
export const AUDIT_ACTIONS = {
  shipmentCreate: "SHIPMENT_CREATE",
  documentUpload: "DOCUMENT_UPLOAD",
  extractionRun: "EXTRACTION_RUN",
  /** Additive (schema-documented): cross-check evidence snapshot on the live
   * discrepancy row it touches — before/after JSON for create, in-place
   * update and automatic OBSOLETE closure. */
  discrepancyReevaluated: "DISCREPANCY_REEVALUATED",
  /** Additive (user-approved 2026-11): one human field correction — snapshots
   * the original/corrected values and the mandatory correction reason. It
   * never replaces the downstream DISCREPANCY_REEVALUATED evidence snapshots
   * written by the cross-check that re-evaluates the affected discrepancies. */
  fieldCorrected: "FIELD_CORRECTED",
  /** Additive (stage 1 of the approval workflow): one human acceptance of a
   * PENDING_REVIEW extracted field. It records the reviewed snapshot only —
   * the original value/confidence are never modified. */
  fieldAccepted: "FIELD_ACCEPTED",
  /** Additive (stage 2): a manager approved a shipment with a frozen evidence
   * snapshot. The snapshot itself lives on the approvals row; this event
   * records the decision and provenance counts. */
  approvalApproved: "APPROVAL_APPROVED",
  /** Additive (stage 2): a manager rejected a shipment. The mandatory note is
   * snapshotted in the event so the reason survives independently. */
  approvalRejected: "APPROVAL_REJECTED",
  /** Provenance marker for a recovered (backfilled) audit row. It references
   * the reconstructed row by id and never replaces, mutates or re-audits it;
   * the marker is itself an ordinary append-only row with a null (system)
   * actor. Written only by an explicit operator-driven recovery. */
  auditRecovered: "AUDIT_RECOVERED",
} as const;

export type AuditActor = string | null; // null = system

export interface AuditLogEntry {
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: AuditActor;
  /** Denormalized per-shipment context for cheap filtering (optional). */
  shipmentId: string | null;
  /** JSON-safe details payload (before/after snapshots, diffs). */
  details?: Record<string, unknown> | null;
}

/**
 * Append one audit row. Fire-and-forget is NOT allowed: the caller must await
 * this and own the failure policy (see shipment-service for the partial-
 * success pattern). The insert is a single statement — no transaction is
 * needed on the neon-http driver.
 */
export async function appendAuditLog(entry: AuditLogEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    shipmentId: entry.shipmentId,
    details: entry.details ?? null,
  });
}

/** Outcome of a non-throwing audit write. */
export interface AuditWriteResult {
  /** True only when the row was accepted by the database. */
  ok: boolean;
}

/**
 * Non-throwing audit write for partial-success paths: business state is
 * already persisted and the caller must report the gap instead of failing.
 *
 * Deliberately NO automatic retry: the neon-http driver can fail AFTER the
 * statement committed, so a blind retry could duplicate an event. Recovery is
 * explicit and must first check for an existing matching event (see
 * AUDIT_RECOVERED / the audit-gap diagnostic).
 */
export async function tryAppendAuditLog(
  entry: AuditLogEntry,
): Promise<AuditWriteResult> {
  try {
    await appendAuditLog(entry);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
