/**
 * audit_logs — append-only audit trail (safeguard 2).
 *
 * The audit service is the ONLY writer and never updates or deletes rows;
 * this is enforced in the service layer (D5) — no DB triggers. Rows capture
 * actor (null = system), a generic entity reference, an optional denormalized
 * shipment reference (ON DELETE SET NULL so the trail survives shipment
 * cleanup — D8) and a JSON payload (before/after snapshots, diff summaries).
 */

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth";
import { shipments } from "./shipments";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    performedAt: timestamp("performed_at", { withTimezone: true }).defaultNow().notNull(),

    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }), // null = system
    action: text("action").notNull(), // e.g. "SHIPMENT_CREATE", "DISCREPANCY_REEVALUATED"

    entityType: text("entity_type").notNull(), // "shipment" | "document" | "approval" | …
    entityId: uuid("entity_id"),

    // Denormalized context for cheap per-shipment filtering.
    shipmentId: uuid("shipment_id").references(() => shipments.id, {
      onDelete: "set null",
    }), // D8

    details: jsonb("details"),
  },
  (t) => [
    index("audit_logs_shipment_time_idx").on(t.shipmentId, t.performedAt),
    index("audit_logs_actor_time_idx").on(t.actorId, t.performedAt),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_action_idx").on(t.action),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
