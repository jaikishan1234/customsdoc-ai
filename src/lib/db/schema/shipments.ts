/**
 * shipments — customs shipment aggregate root.
 *
 * Status transitions are enforced in the service layer (D5): the DB stores
 * state; CHECK constraints below only guard reference format and export
 * stamping consistency.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { shipmentStatus } from "./enums";

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull(), // e.g. SHP-24811
    status: shipmentStatus("status").notNull().default("DRAFT"),
    description: text("description"),
    notes: text("notes"),

    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    assignedTo: text("assigned_to").references(() => user.id, {
      onDelete: "set null",
    }),

    // Stamped only when a CSV export is actually performed.
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    exportedBy: text("exported_by").references(() => user.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("shipments_reference_key").on(t.reference),
    index("shipments_status_idx").on(t.status),
    index("shipments_createdBy_idx").on(t.createdBy),

    check(
      "shipments_reference_fmt",
      sql`${t.reference} ~ '^SHP-[0-9]{4,10}$'`,
    ),
    check(
      "shipments_export_consistency",
      sql`((${t.status} = 'EXPORTED')
        = ((${t.exportedAt} IS NOT NULL) AND (${t.exportedBy} IS NOT NULL)))`,
    ),
  ],
);

export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;
