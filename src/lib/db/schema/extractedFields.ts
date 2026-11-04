/**
 * extracted_fields — values produced by a specific extraction run.
 *
 * Value columns (rawValue, parsedValue, numericValue, unit) are IMMUTABLE by
 * application design: corrections live in field_corrections and never mutate
 * these rows. The only mutable column is reviewStatus (human review state),
 * and every transition is audited.
 */

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { fieldReviewStatus } from "./enums";
import { extractions } from "./extractions";

export const extractedFields = pgTable(
  "extracted_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extractionId: uuid("extraction_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(), // denormalized, FK-bound below

    fieldKey: text("field_key").notNull(), // normalized, e.g. "gross_weight_kg"
    fieldLabel: text("field_label").notNull(),

    // Original extraction values — preserved permanently.
    rawValue: text("raw_value"),
    parsedValue: text("parsed_value"),
    numericValue: numeric("numeric_value", { precision: 14, scale: 4 }),
    unit: text("unit"),

    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    pageNumber: integer("page_number"),
    bbox: integer("bbox").array(),

    // Human-review state: PENDING_REVIEW for required keys / low confidence;
    // ACCEPTED or CORRECTED once reviewed/corrected.
    reviewStatus: fieldReviewStatus("review_status").notNull().default("PENDING_REVIEW"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Composite FK: field belongs to this extraction AND same shipment.
    foreignKey({
      name: "extracted_fields_extraction_fk",
      columns: [t.extractionId, t.shipmentId],
      foreignColumns: [extractions.id, extractions.shipmentId],
    }),
    // Composite FK target for field_corrections (triple).
    unique("extracted_fields_id_extraction_shipment_uq").on(
      t.id,
      t.extractionId,
      t.shipmentId,
    ),
    unique("extracted_fields_run_key_uq").on(t.extractionId, t.fieldKey),

    // Fast "fields pending review" queries (export/review screens).
    index("extracted_fields_shipment_review_idx").on(
      t.shipmentId,
      t.reviewStatus,
      t.fieldKey,
    ),

    check(
      "extracted_fields_confidence_range",
      sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`,
    ),
  ],
);

export type ExtractedField = typeof extractedFields.$inferSelect;
export type NewExtractedField = typeof extractedFields.$inferInsert;
