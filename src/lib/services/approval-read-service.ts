import "server-only";

/**
 * Read-only approval presentation service.
 *
 * The approvals table has exactly one sanctioned writer (approval-service.ts);
 * this module only reads the latest decision for the shipment page. It is the
 * client-safe projection: status, timestamps, decider name, decision note and
 * snapshot COUNTS/capture time. Document ids, extraction ids, checksums,
 * actor ids and the raw JSONB snapshot never leave the server.
 *
 * Non-throwing by contract: DB failures map to `unavailable` so the panel can
 * say the decision could not be loaded instead of rendering a fake "none".
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { approvals, shipments, user } from "@/lib/db/schema";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Client-safe snapshot provenance (no ids, no checksums). */
export interface ApprovalSnapshotView {
  documentCount: number;
  extractionCount: number;
  capturedAt: string | null;
}

/** One shipment's latest approval decision, safe to render. */
export interface ShipmentApprovalView {
  status: "PENDING" | "APPROVED" | "REJECTED" | "INVALIDATED";
  requestedAt: Date;
  decidedAt: Date | null;
  /** Resolved display name of the deciding manager (never the id). */
  decidedByName: string | null;
  decisionNote: string | null;
  snapshot: ApprovalSnapshotView | null;
}

export type ShipmentApprovalReadResult =
  | { status: "success"; approval: ShipmentApprovalView | null }
  | { status: "not_found" }
  | { status: "unavailable" };

/** Defensive JSONB projection: malformed/legacy snapshots degrade to counts 0. */
const summarizeSnapshot = (
  snapshot: unknown,
): ApprovalSnapshotView | null => {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return null;
  }
  const record = snapshot as Record<string, unknown>;
  const documents = Array.isArray(record.documents) ? record.documents : [];
  const extractions = Array.isArray(record.extractions) ? record.extractions : [];
  return {
    documentCount: documents.length,
    extractionCount: extractions.length,
    capturedAt:
      typeof record.capturedAt === "string" ? record.capturedAt : null,
  };
};

/**
 * Latest approval/rejection row for one shipment (newest first), or null when
 * no decision has ever been recorded. Read-only; never mutates.
 */
export async function getShipmentApproval(
  shipmentId: unknown,
): Promise<ShipmentApprovalReadResult> {
  const id = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(id)) {
    return { status: "not_found" };
  }

  try {
    const [shipmentRows, rows] = await Promise.all([
      db
        .select({ id: shipments.id })
        .from(shipments)
        .where(eq(shipments.id, id))
        .limit(1),
      db
        .select({
          status: approvals.status,
          requestedAt: approvals.requestedAt,
          decidedAt: approvals.decidedAt,
          decisionNote: approvals.decisionNote,
          approvalSnapshot: approvals.approvalSnapshot,
          decidedByName: user.name,
        })
        .from(approvals)
        .leftJoin(user, eq(approvals.decidedBy, user.id))
        .where(eq(approvals.shipmentId, id))
        .orderBy(desc(approvals.createdAt))
        .limit(1),
    ]);

    if (!shipmentRows[0]) {
      return { status: "not_found" };
    }

    const row = rows[0];
    if (!row) {
      return { status: "success", approval: null };
    }

    return {
      status: "success",
      approval: {
        status: row.status,
        requestedAt: row.requestedAt,
        decidedAt: row.decidedAt,
        decidedByName: row.decidedByName ?? null,
        decisionNote: row.decisionNote,
        snapshot: summarizeSnapshot(row.approvalSnapshot),
      },
    };
  } catch {
    console.error(
      `[approval-read-service] Failed to read approval (shipmentId=${id}).`,
    );
    return { status: "unavailable" };
  }
}
