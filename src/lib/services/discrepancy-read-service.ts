import "server-only";

/**
 * Discrepancy READ service — the sanctioned client-safe read view of the
 * cross-document discrepancy rows of one shipment (shipment-detail
 * workspace + Overview counts).
 *
 * This is a strictly read-side sibling of `discrepancy-check-service.ts`
 * (the ONLY sanctioned writer of the `discrepancies` table). Same contract
 * as the other read services: exactly one sanctioned writer per table, and
 * reads exposed ONLY through typed, client-safe projections.
 *
 * Client-safety contract (enforced here, not in the UI):
 * - Rows expose: type, scope key, severity, status, the service-produced
 *   title/detail, the numeric evidence trio (NUMERIC(14,4) as text) + unit,
 *   the source documents' TYPE + VERSION, resolution timestamp/note and the
 *   row timestamps.
 * - Never exposed: `resolvedBy`/actor IDs (opaque internal identifiers — the
 *   activity timeline applies the same rule), `checkRunKey` (provenance
 *   detail, not user information), storage keys, checksums or anything from
 *   the extraction/storage layer.
 * - Freshness/lifecycle is untouched: rows are delivered as stored; the UI
 *   partitions OPEN/RECHECK_PENDING (still active) from RESOLVED/WAIVED/
 *   OBSOLETE (historical) — no status is rewritten here.
 *
 * Strictly read-only; no mutations, no transactions (neon-http — a single
 * read statement).
 */

import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/lib/db";
import { discrepancies, documents } from "@/lib/db/schema";
import type { DocumentEntryType } from "./document-service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The discrepancy pg enum unions, straight from the schema. */
export type DiscrepancyTypeView = (typeof discrepancies.type.enumValues)[number];
export type DiscrepancySeverityView = (typeof discrepancies.severity.enumValues)[number];
export type DiscrepancyStatusView = (typeof discrepancies.status.enumValues)[number];

/** The source document of one evidence side (type + version — no other data). */
export interface DiscrepancySourceDocument {
  documentType: DocumentEntryType;
  documentVersion: number;
}

/** One discrepancy row reduced to exactly what the workspace renders. */
export interface ShipmentDiscrepancyView {
  id: string;
  type: DiscrepancyTypeView;
  scopeKey: string | null;
  severity: DiscrepancySeverityView;
  status: DiscrepancyStatusView;
  /** Human-readable summary, pre-baked at write time by the check service. */
  title: string;
  /** Longer explanation, pre-baked at write time. */
  detail: string | null;
  expectedValue: string | null;
  actualValue: string | null;
  deltaValue: string | null;
  unit: string | null;
  documentA: DiscrepancySourceDocument | null;
  documentB: DiscrepancySourceDocument | null;
  /** Resolution — null for live rows; supplied together by the DB CHECK. */
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ShipmentDiscrepanciesResult =
  | { status: "success"; discrepancies: readonly ShipmentDiscrepancyView[] }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * Load every discrepancy row of one shipment (all statuses — the UI shows
 * the live set prominently and the RESOLVED/WAIVED/OBSOLETE history
 * collapsed), ordered: active first, then historical, newest-first within
 * each group. Strict UUID gate (no DB round-trip for malformed ids), civil
 * `unavailable` reporting on DB failure. Read-only; no mutations.
 */
export async function listDiscrepanciesForShipment(
  shipmentId: unknown,
): Promise<ShipmentDiscrepanciesResult> {
  const id = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(id)) {
    return { status: "not_found" };
  }

  // Proof-side document aliases (plain FKs, so a missing document yields
  // NULL — a deleted document must never drop the discrepancy row).
  const docA = alias(documents, "discrepancy_doc_a");
  const docB = alias(documents, "discrepancy_doc_b");

  let rows: Array<{
    id: string;
    type: DiscrepancyTypeView;
    scopeKey: string | null;
    severity: DiscrepancySeverityView;
    status: DiscrepancyStatusView;
    title: string;
    detail: string | null;
    expectedValue: string | null;
    actualValue: string | null;
    deltaValue: string | null;
    unit: string | null;
    documentAType: DocumentEntryType | null;
    documentAVersion: number | null;
    documentBType: DocumentEntryType | null;
    documentBVersion: number | null;
    resolvedAt: Date | null;
    resolutionNote: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  try {
    rows = await db
      .select({
        id: discrepancies.id,
        type: discrepancies.type,
        scopeKey: discrepancies.scopeKey,
        severity: discrepancies.severity,
        status: discrepancies.status,
        title: discrepancies.title,
        detail: discrepancies.detail,
        expectedValue: discrepancies.expectedValue,
        actualValue: discrepancies.actualValue,
        deltaValue: discrepancies.deltaValue,
        unit: discrepancies.unit,
        documentAType: docA.documentType,
        documentAVersion: docA.version,
        documentBType: docB.documentType,
        documentBVersion: docB.version,
        resolvedAt: discrepancies.resolvedAt,
        resolutionNote: discrepancies.resolutionNote,
        createdAt: discrepancies.createdAt,
        updatedAt: discrepancies.updatedAt,
      })
      .from(discrepancies)
      .leftJoin(docA, eq(discrepancies.documentAId, docA.id))
      .leftJoin(docB, eq(discrepancies.documentBId, docB.id))
      .where(eq(discrepancies.shipmentId, id))
      .orderBy(desc(discrepancies.createdAt));
  } catch {
    console.error(
      `[discrepancy-read-service] Failed to read discrepancies (shipmentId=${id}).`,
    );
    return { status: "unavailable" };
  }

  const statusRank: Record<DiscrepancyStatusView, number> = {
    OPEN: 0,
    RECHECK_PENDING: 1,
    RESOLVED: 2,
    WAIVED: 3,
    OBSOLETE: 4,
  };
  const view: ShipmentDiscrepancyView[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    scopeKey: row.scopeKey,
    severity: row.severity,
    status: row.status,
    title: row.title,
    detail: row.detail,
    expectedValue: row.expectedValue,
    actualValue: row.actualValue,
    deltaValue: row.deltaValue,
    unit: row.unit,
    documentA:
      row.documentAType !== null &&
      row.documentAVersion !== null &&
      // Defensive type-map: the joined FK guarantees consistency with the
      // document shipment, so this is belt-and-braces against drift only.
      (["INVOICE", "PACKING_LIST", "BILL_OF_LADING"] as readonly string[]).includes(
        row.documentAType,
      )
        ? { documentType: row.documentAType, documentVersion: row.documentAVersion }
        : null,
    documentB:
      row.documentBType !== null &&
      row.documentBVersion !== null &&
      (["INVOICE", "PACKING_LIST", "BILL_OF_LADING"] as readonly string[]).includes(
        row.documentBType,
      )
        ? { documentType: row.documentBType, documentVersion: row.documentBVersion }
        : null,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  // Deterministic delivery order: active rows first (OPEN above
  // RECHECK_PENDING), then historical; newest-first inside each group.
  view.sort((first, second) => {
    const rankDelta = statusRank[first.status] - statusRank[second.status];
    if (rankDelta !== 0) return rankDelta;
    return (
      second.updatedAt.getTime() - first.updatedAt.getTime() ||
      second.createdAt.getTime() - first.createdAt.getTime() ||
      first.id.localeCompare(second.id)
    );
  });

  return { status: "success", discrepancies: view };
}
