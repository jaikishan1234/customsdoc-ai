/**
 * discrepancies — results of cross-document checks.
 *
 * Rows are LIVE state: exactly one row per (shipment, type, scopeKey) can be
 * OPEN or RECHECK_PENDING at a time. Evidence snapshots of every in-place
 * update are written to audit_logs (DISCREPANCY_REEVALUATED, before/after
 * JSON) before the update — no separate history table.
 *
 * OPEN and RECHECK_PENDING both block export at ANY severity; CRITICAL rows
 * can never be WAIVED (CHECK below).
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import {
  discrepancyStatus,
  discrepancyType,
  severity,
} from "./enums";
import { extractedFields } from "./extractedFields";
import { documents } from "./documents";
import { shipments } from "./shipments";

export const discrepancies = pgTable(
  "discrepancies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),

    type: discrepancyType("type").notNull(),
    scopeKey: text("scope_key"), // e.g. "gross_weight_kg"; NULL for shipment-level checks
    severity: severity("severity").notNull().default("MEDIUM"),
    status: discrepancyStatus("status").notNull().default("OPEN"),

    title: text("title").notNull(),
    detail: text("detail"),

    expectedValue: numeric("expected_value", { precision: 14, scale: 4 }),
    actualValue: numeric("actual_value", { precision: 14, scale: 4 }),
    deltaValue: numeric("delta_value", { precision: 14, scale: 4 }),
    unit: text("unit"),

    // Evidence links — nullable; same-shipment consistency is validated in the
    // service layer (D5). Plain FKs: composite would force shipment_id NOT NULL.
    fieldAId: uuid("field_a_id").references(() => extractedFields.id, {
      onDelete: "set null",
    }),
    fieldBId: uuid("field_b_id").references(() => extractedFields.id, {
      onDelete: "set null",
    }),
    documentAId: uuid("document_a_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    documentBId: uuid("document_b_id").references(() => documents.id, {
      onDelete: "set null",
    }),

    // Provenance of the check run that produced/last updated this row.
    checkRunKey: text("check_run_key").notNull().default("crosscheck-v1"),

    resolvedBy: text("resolved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // One live row per (shipment, type, scopeField) — distinct field mismatches
    // coexist. Shipment-level types (scopeKey NULL) are exempt via SQL NULLs.
    // NULL keys are unified via coalesce() so a NULL scopeKey can never yield
    // duplicate live rows of the same (shipment, type). (drizzle-orm 0.45.x
    // has no uniqueIndex().nullsNotDistinct() — coalesce() is the equivalent.)
    uniqueIndex("discrepancies_live_uq")
      .on(t.shipmentId, t.type, sql`coalesce(${t.scopeKey}, '')`)
      .where(sql`${t.status} IN ('OPEN', 'RECHECK_PENDING')`),

    index("discrepancies_shipment_status_idx").on(t.shipmentId, t.status),
    index("discrepancies_severity_idx").on(t.severity),

    check(
      "discrepancies_evidence_consistency",
      sql`( (${t.expectedValue} IS NULL AND ${t.actualValue} IS NULL AND ${t.deltaValue} IS NULL)
        OR (${t.expectedValue} IS NOT NULL AND ${t.actualValue} IS NOT NULL
                                     AND ${t.deltaValue} IS NOT NULL))`,
    ),
    check(
      "discrepancies_critical_not_waived",
      sql`${t.status} <> 'WAIVED' OR ${t.severity} <> 'CRITICAL'`,
    ),
    check(
      "discrepancies_resolution_consistency",
      sql`((${t.status} IN ('RESOLVED', 'WAIVED'))
        = (${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL))`,
    ),
  ],
);

export type Discrepancy = typeof discrepancies.$inferSelect;
export type NewDiscrepancy = typeof discrepancies.$inferInsert;
