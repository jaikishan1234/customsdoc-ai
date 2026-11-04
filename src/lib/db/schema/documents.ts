/**
 * documents — immutable per-version rows of each required document type.
 *
 * A re-upload inserts a NEW row (version incremented); the previous row is
 * tombstoned (isActive=false) by the service within the same transaction.
 * Original metadata, storage reference and content checksum are never mutated.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { documentType } from "./enums";
import { shipments } from "./shipments";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    documentType: documentType("document_type").notNull(),

    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),

    version: integer("version").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),

    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Exactly one ACTIVE version per required type per shipment.
    uniqueIndex("documents_active_type_uq")
      .on(t.shipmentId, t.documentType)
      .where(sql`${t.isActive} = true`),
    // Version numbering is unique per (shipment, type).
    unique("documents_version_uq").on(t.shipmentId, t.documentType, t.version),
    // Composite FK target for extractions.
    unique("documents_id_shipment_uq").on(t.id, t.shipmentId),

    index("documents_shipment_idx").on(t.shipmentId),

    check("documents_size_positive", sql`${t.sizeBytes} > 0`),
    check("documents_version_positive", sql`${t.version} >= 1`),
    check(
      "documents_superseded_consistency",
      sql`(( ${t.isActive} = true  AND ${t.supersededAt} IS NULL)
        OR ( ${t.isActive} = false AND ${t.supersededAt} IS NOT NULL))`,
    ),
    check(
      "documents_checksum_sha256",
      sql`${t.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export type ShipmentDocument = typeof documents.$inferSelect;
export type NewShipmentDocument = typeof documents.$inferInsert;
