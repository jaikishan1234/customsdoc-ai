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
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];

/** Canonical audit action strings. Callers must use these constants. */
export const AUDIT_ACTIONS = {
  shipmentCreate: "SHIPMENT_CREATE",
  documentUpload: "DOCUMENT_UPLOAD",
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
