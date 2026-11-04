/**
 * extractions — one row per extraction attempt; full history preserved.
 *
 * The composite FK (document_id, shipment_id) -> documents(id, shipment_id)
 * proves that the extraction's shipment matches the document's shipment
 * without triggers (D5).
 *
 * FRESHNESS RULE (service-level, D5 — no services implemented yet):
 * The CURRENT attempt of a document is max(attempt) across ALL statuses.
 * Data is fresh only if that latest attempt has status COMPLETED. A newer
 * PROCESSING/PENDING attempt means extraction is in progress; a newer FAILED
 * attempt surfaces an error. In both cases cross-checks and export must be
 * blocked — an older COMPLETED attempt must NEVER be treated as current.
 */

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { extractionStatus } from "./enums";
import { documents } from "./documents";

export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(), // denormalized, FK-bound below

    attempt: integer("attempt").notNull().default(1),
    status: extractionStatus("status").notNull().default("PENDING"),
    engine: text("engine").notNull(),
    engineRunRef: text("engine_run_ref"),
    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    triggeredBy: text("triggered_by").references(() => user.id, {
      onDelete: "set null",
    }), // null = system
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Composite FK: extraction must belong to the document's own shipment.
    foreignKey({
      name: "extractions_document_shipment_fk",
      columns: [t.documentId, t.shipmentId],
      foreignColumns: [documents.id, documents.shipmentId],
    }),
    // Composite FK target for extracted_fields.
    unique("extractions_id_shipment_uq").on(t.id, t.shipmentId),

    unique("extractions_doc_attempt_uq").on(t.documentId, t.attempt),
    // At most one COMPLETED attempt per document — the completed result is
    // unambiguous. When a new attempt completes, the service must flip the
    // previous COMPLETED row to SUPERSEDED in the same transaction.
    uniqueIndex("extractions_completed_uq")
      .on(t.documentId)
      .where(sql`${t.status} = 'COMPLETED'`),
    index("extractions_document_created_idx").on(t.documentId, t.createdAt),
    index("extractions_status_idx").on(t.status),

    check("extractions_attempt_positive", sql`${t.attempt} >= 1`),
    check(
      "extractions_completion",
      sql`((${t.status} = 'COMPLETED') = (${t.completedAt} IS NOT NULL))`,
    ),
  ],
);

export type Extraction = typeof extractions.$inferSelect;
export type NewExtraction = typeof extractions.$inferInsert;
