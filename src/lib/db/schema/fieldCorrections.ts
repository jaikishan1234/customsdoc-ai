/**
 * field_corrections — append-only history of human corrections.
 *
 * Rows are inserted, never updated or deleted. The triple composite FK
 * guarantees the correction points at a real (field, extraction, shipment)
 * combination — a correction cannot leak into another shipment or another
 * extraction run. Inserting a correction:
 *   1. sets the field's reviewStatus = 'CORRECTED',
 *   2. moves related live discrepancies to RECHECK_PENDING,
 *   3. invalidates a live APPROVED approval (service, D5).
 * Corrections never resolve discrepancies directly — only a successful
 * cross-check run can (via effective values).
 */

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { extractedFields } from "./extractedFields";

export const fieldCorrections = pgTable(
  "field_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fieldId: uuid("field_id").notNull(),
    extractionId: uuid("extraction_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(), // D9: retained, FK-bound

    // Immutable snapshots of what was corrected.
    originalValue: text("original_value").notNull(),
    originalNumeric: numeric("original_numeric", { precision: 14, scale: 4 }),
    correctedValue: text("corrected_value").notNull(),
    correctedNumeric: numeric("corrected_numeric", { precision: 14, scale: 4 }),
    unit: text("unit"),
    reason: text("reason").notNull(),
    confidenceBefore: numeric("confidence_before", { precision: 4, scale: 3 }),

    correctedBy: text("corrected_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    correctedAt: timestamp("corrected_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Triple integrity: (field, extraction, shipment) must all be real and
    // mutually consistent — enforced by the DB, no triggers needed.
    foreignKey({
      name: "field_corrections_field_triple_fk",
      columns: [t.fieldId, t.extractionId, t.shipmentId],
      foreignColumns: [
        extractedFields.id,
        extractedFields.extractionId,
        extractedFields.shipmentId,
      ],
    }),

    // Latest correction per field = max correctedAt (ties -> max id).
    index("field_corrections_field_time_idx").on(t.fieldId, t.correctedAt),
    index("field_corrections_shipment_idx").on(t.shipmentId),

    // No-op corrections are meaningless for audit trails.
    check(
      "field_corrections_changes_value",
      sql`${t.correctedValue} IS DISTINCT FROM ${t.originalValue}`,
    ),
  ],
);

export type FieldCorrection = typeof fieldCorrections.$inferSelect;
export type NewFieldCorrection = typeof fieldCorrections.$inferInsert;
