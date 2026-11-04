/**
 * approvals — manager decisions with a built-in snapshot for tamper evidence.
 *
 * Exactly one LIVE row (PENDING or APPROVED) per shipment. Rows are never
 * deleted: invalidation flips status to INVALIDATED, preserving history.
 * approvalSnapshot captures the document IDs + checksums and the selected
 * extraction IDs at approval time — used to detect material drift between
 * approval and export (safeguard 1).
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { approvalStatus } from "./enums";
import { shipments } from "./shipments";

/** Shape of approvals.approvalSnapshot (service-produced, application-typed). */
export type ApprovalSnapshot = {
  documents: Array<{
    documentId: string;
    documentType: "INVOICE" | "PACKING_LIST" | "BILL_OF_LADING";
    version: number;
    checksumSha256: string;
  }>;
  /** Extraction paired with each approved active document version — the pair
   * proves which result belongs to which document at approval time. */
  extractions: Array<{
    documentId: string;
    extractionId: string;
  }>;
  checkRunKey?: string;
  capturedAt: string;
};

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),

    status: approvalStatus("status").notNull().default("PENDING"),

    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),

    // Must be a DOCUMENTATION_MANAGER — enforced in the service layer (D5).
    decidedBy: text("decided_by").references(() => user.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),

    // Frozen view of the approved data: active document IDs + checksums and
    // the extraction IDs whose (effective) values were approved.
    approvalSnapshot: jsonb("approval_snapshot").$type<ApprovalSnapshot>(),

    // Pointer to the live/invalidated approval row this one replaces (Q2:
    // resubmission is always an explicit executive action). Self-referencing
    // FK keeps the chain valid; onDelete set null keeps history if the
    // superseded row is ever removed.
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => approvals.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // At most one LIVE approval per shipment.
    uniqueIndex("approvals_live_uq")
      .on(t.shipmentId)
      .where(sql`${t.status} IN ('PENDING', 'APPROVED')`),

    index("approvals_shipment_time_idx").on(t.shipmentId, t.createdAt),
    index("approvals_decidedBy_idx").on(t.decidedBy),

    // Decision fields must agree with status.
    check(
      "approvals_decision_consistency",
      sql`( (${t.status} = 'PENDING' AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)
        OR (${t.status} IN ('APPROVED', 'REJECTED')
              AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)
        OR (${t.status} = 'INVALIDATED'))`,
    ),
    check(
      "approvals_decider_pair",
      sql`(${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    // An approval can never supersede itself.
    check(
      "approvals_not_self_superseding",
      sql`${t.supersedesId} IS DISTINCT FROM ${t.id}`,
    ),
    // The snapshot is the tamper-evidence for approval data (safeguard 1):
    // it is mandatory at decision time.
    check(
      "approvals_snapshot_required",
      sql`${t.status} <> 'APPROVED' OR ${t.approvalSnapshot} IS NOT NULL`,
    ),
  ],
);

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
