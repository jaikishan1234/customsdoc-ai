/**
 * Opt-in, authenticated, READ-ONLY audit-gap report.
 *
 * Purpose: make a failed audit write findable AFTER the fact instead of only
 * in server logs. It checks the four append-only contracts and reports
 * business rows whose expected audit event is absent — the same gaps that
 * would otherwise need manual backfilling.
 *
 * Safety:
 * - Inert by default (`AUDIT_DIAGNOSTIC_ENABLED !== "true"` answers 404).
 * - GET only; session + role gated (existing diagnostic pattern).
 * - Strictly read-only: no inserts, no updates, no automatic backfill.
 * - Responses carry aggregate counts and safe references only (shipment
 *   reference, document type/version, catalog field key, discrepancy
 *   type/status, timestamps). Never actor ids, UUIDs, storage keys,
 *   checksums or document contents.
 */

import { sql, type SQL } from "drizzle-orm";
import { headers } from "next/headers";

import { USER_ROLES } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSession, hasRole } from "@/lib/server/auth";

const DIAGNOSTIC_ROLES = [
  USER_ROLES.DOCUMENTATION_EXECUTIVE,
  USER_ROLES.DOCUMENTATION_MANAGER,
] as const;

/** Per-category row cap. Counts always report the full total. */
const MAX_ROWS_PER_CATEGORY = 50;

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

interface RawGapRow {
  /** Index signature required by the driver's generic row constraint. */
  [key: string]: unknown;
  shipment_reference: string;
  subject: string;
  missing_since: string;
}

interface AuditGapCategory {
  /** Total gaps in this category (may exceed `rows.length`). */
  count: number;
  /** Up to MAX_ROWS_PER_CATEGORY safe references for investigation. */
  rows: ReadonlyArray<{
    shipmentReference: string;
    subject: string;
    missingSince: string;
  }>;
}

interface AuditGapReport {
  generatedAt: string;
  maxRowsPerCategory: number;
  totalGaps: number;
  categories: {
    corrections: AuditGapCategory;
    documents: AuditGapCategory;
    extractions: AuditGapCategory;
    discrepancies: AuditGapCategory;
  };
}

const readRows = async <T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> => {
  const result = await db.execute<T>(query);
  return result.rows;
};

const toCategory = (count: number, rows: RawGapRow[]): AuditGapCategory => ({
  count,
  rows: rows.map((row) => ({
    shipmentReference: row.shipment_reference,
    subject: row.subject,
    missingSince: row.missing_since,
  })),
});

export async function GET(): Promise<Response> {
  // The opt-in flag, the session and the rows are all request-time inputs.
  // Touching a request API guarantees per-request execution: segment config
  // `dynamic` is rejected while Cache Components are enabled, and without this
  // the build-time (disabled) branch would be prerendered and keep answering
  // 404 after the flag is enabled.
  await headers();

  // 1. Opt-in gate — behaves as a non-existent route when disabled.
  if (process.env.AUDIT_DIAGNOSTIC_ENABLED !== "true") {
    return json({ error: "Not found." }, 404);
  }

  // 2. Authenticated + role-gated (server-side only).
  const session = await getSession();
  if (!session) {
    return json({ error: "You must be signed in to run this check." }, 401);
  }
  if (!hasRole(session, DIAGNOSTIC_ROLES)) {
    return json({ error: "You do not have permission to run this check." }, 403);
  }

  try {
    // 3. Counts (exact) + capped safe references, all in one read-only batch.
    const [
      correctionCountRows,
      correctionRows,
      documentCountRows,
      documentRows,
      extractionCountRows,
      extractionRows,
      discrepancyCountRows,
      discrepancyRows,
    ] = await Promise.all([
      readRows<{ n: number }>(sql`
        select count(*)::int as n
        from field_corrections fc
        where not exists (
          select 1 from audit_logs a
          where a.action = 'FIELD_CORRECTED'
            and a.entity_type = 'fieldCorrection'
            and a.entity_id = fc.id
        )
      `),
      readRows<RawGapRow>(sql`
        select s.reference as shipment_reference,
               f.field_key as subject,
               to_char(fc.corrected_at at time zone 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS"Z"') as missing_since
        from field_corrections fc
        join shipments s on s.id = fc.shipment_id
        join extracted_fields f on f.id = fc.field_id
        where not exists (
          select 1 from audit_logs a
          where a.action = 'FIELD_CORRECTED'
            and a.entity_type = 'fieldCorrection'
            and a.entity_id = fc.id
        )
        order by fc.corrected_at desc
        limit ${MAX_ROWS_PER_CATEGORY}
      `),
      readRows<{ n: number }>(sql`
        select count(*)::int as n
        from documents d
        where not exists (
          select 1 from audit_logs a
          where a.action = 'DOCUMENT_UPLOAD'
            and a.entity_type = 'document'
            and a.entity_id = d.id
        )
      `),
      readRows<RawGapRow>(sql`
        select s.reference as shipment_reference,
               d.document_type::text || ' v' || d.version::text as subject,
               to_char(d.created_at at time zone 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS"Z"') as missing_since
        from documents d
        join shipments s on s.id = d.shipment_id
        where not exists (
          select 1 from audit_logs a
          where a.action = 'DOCUMENT_UPLOAD'
            and a.entity_type = 'document'
            and a.entity_id = d.id
        )
        order by d.created_at desc
        limit ${MAX_ROWS_PER_CATEGORY}
      `),
      readRows<{ n: number }>(sql`
        select count(*)::int as n
        from extractions e
        where e.status in ('COMPLETED', 'FAILED')
          and not exists (
            select 1 from audit_logs a
            where a.action = 'EXTRACTION_RUN'
              and a.entity_type = 'document'
              and a.entity_id = e.document_id
              and a.details->>'attempt' = e.attempt::text
          )
      `),
      readRows<RawGapRow>(sql`
        select s.reference as shipment_reference,
               d.document_type::text || ' v' || d.version::text ||
                 ' attempt ' || e.attempt::text as subject,
               to_char(e.created_at at time zone 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS"Z"') as missing_since
        from extractions e
        join documents d on d.id = e.document_id
        join shipments s on s.id = e.shipment_id
        where e.status in ('COMPLETED', 'FAILED')
          and not exists (
            select 1 from audit_logs a
            where a.action = 'EXTRACTION_RUN'
              and a.entity_type = 'document'
              and a.entity_id = e.document_id
              and a.details->>'attempt' = e.attempt::text
          )
        order by e.created_at desc
        limit ${MAX_ROWS_PER_CATEGORY}
      `),
      readRows<{ n: number }>(sql`
        select count(*)::int as n
        from discrepancies dc
        where not exists (
          select 1 from audit_logs a
          where a.action = 'DISCREPANCY_REEVALUATED'
            and a.entity_type = 'discrepancy'
            and a.entity_id = dc.id
        )
      `),
      readRows<RawGapRow>(sql`
        select s.reference as shipment_reference,
               dc.type::text || ' / ' || dc.status::text as subject,
               to_char(dc.created_at at time zone 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS"Z"') as missing_since
        from discrepancies dc
        join shipments s on s.id = dc.shipment_id
        where not exists (
          select 1 from audit_logs a
          where a.action = 'DISCREPANCY_REEVALUATED'
            and a.entity_type = 'discrepancy'
            and a.entity_id = dc.id
        )
        order by dc.created_at desc
        limit ${MAX_ROWS_PER_CATEGORY}
      `),
    ]);

    const correctionCount = correctionCountRows[0]?.n ?? 0;
    const documentCount = documentCountRows[0]?.n ?? 0;
    const extractionCount = extractionCountRows[0]?.n ?? 0;
    const discrepancyCount = discrepancyCountRows[0]?.n ?? 0;

    const report: AuditGapReport = {
      generatedAt: new Date().toISOString(),
      maxRowsPerCategory: MAX_ROWS_PER_CATEGORY,
      totalGaps:
        correctionCount + documentCount + extractionCount + discrepancyCount,
      categories: {
        corrections: toCategory(correctionCount, correctionRows),
        documents: toCategory(documentCount, documentRows),
        extractions: toCategory(extractionCount, extractionRows),
        discrepancies: toCategory(discrepancyCount, discrepancyRows),
      },
    };

    console.info(
      `[audit-gap-diagnostic] totalGaps=${report.totalGaps} ` +
        `corrections=${correctionCount} documents=${documentCount} ` +
        `extractions=${extractionCount} discrepancies=${discrepancyCount}`,
    );

    return json(report, 200);
  } catch {
    // Never leak SQL/driver details; the report simply could not be produced.
    console.error("[audit-gap-diagnostic] Read-only audit-gap query failed.");
    return json({ error: "The audit gap report could not be produced." }, 503);
  }
}
