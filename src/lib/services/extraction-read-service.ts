import "server-only";

/**
 * Extraction READ service — the sanctioned read view of extraction attempt
 * history and extracted fields for one shipment (shipment-detail AI section).
 *
 * This is a strictly read-side sibling of `extraction-service.ts` (the ONLY
 * sanctioned writer of these tables). Together they express the same rule as
 * the document service: exactly one sanctioned writer per table, and reads
 * exposed ONLY through typed, client-safe projections.
 *
 * Client-safety contract (enforced here, not in the UI):
 * - Attempts expose: status, attempt number, engine model string, timestamps
 *   and the SANITIZED error code column (`extractions.error`) — never raw
 *   provider messages, prompts or model output.
 * - Fields expose: key, label, parsed value, unit, confidence (NUMERIC(4,3)
 *   as text), page number and review status — never `rawValue`'s OCR-space
 *   content beyond the parsed value already shown, no storage keys,
 *   checksums, engine run refs or secrets.
 * - Latest-attempt semantics (schema contract): the CURRENT attempt of a
 *   document is max(attempt) across ALL statuses. `latest` is exactly that
 *   row, and `hasCurrentCompleted` is true ONLY when the max-attempt row is
 *   COMPLETED. An older COMPLETED attempt is always delivered as non-current
 *   history — the UI can never mistake it for fresh data.
 *
 * Bounded by design: at most {@link MAX_ATTEMPTS_PER_DOCUMENT} newest attempt
 * rows per document (attempts grow with retries; older ones are audit tail),
 * and fields are loaded only for those displayed attempts. Ordering is
 * deterministic (document type order, then attempt descending, then field
 * key ascending). Read-only; no mutations; no transactions needed (neon-http
 * — two independent reads are consistent enough for a history view).
 */

import { desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  documents,
  extractedFields,
  extractions,
  extractionStatus,
} from "@/lib/db/schema";
import { shipments } from "@/lib/db/schema";
import type { DocumentEntryType } from "@/lib/services/document-service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pgEnum declaration order — same stable order the services use. */
const DOCUMENT_TYPE_ORDER = [
  "INVOICE",
  "PACKING_LIST",
  "BILL_OF_LADING",
] as const;

/** Newest attempt rows shown per document (bounded, deterministic). */
const MAX_ATTEMPTS_PER_DOCUMENT = 5;

/** The extraction status union straight from the pg enum. */
export type ExtractionAttemptStatus = (typeof extractionStatus.enumValues)[number];

export interface ExtractedFieldValueView {
  fieldKey: string;
  fieldLabel: string;
  /** Parsed canonical value as stored text (present values only). */
  parsedValue: string;
  unit: string | null;
  /** NUMERIC(4,3) as text, e.g. "0.950". */
  confidence: string;
  pageNumber: number | null;
  reviewStatus: "PENDING_REVIEW" | "ACCEPTED" | "CORRECTED";
}

export interface ExtractionAttemptView {
  id: string;
  attempt: number;
  status: ExtractionAttemptStatus;
  /** Sanitized error code (extractions.error) or null when none. */
  errorCode: string | null;
  /** Engine/model metadata string, e.g. the pinned Gemini model id. */
  engine: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  /** Ordered field values for this attempt (field key ascending). */
  fields: readonly ExtractedFieldValueView[];
}

export interface ExtractionDocumentView {
  documentId: string;
  documentType: DocumentEntryType;
  documentVersion: number;
  /** Provenance only (client-safe copy stored at upload). */
  documentFilename: string;
  /** Newest-first, bounded to {@link MAX_ATTEMPTS_PER_DOCUMENT}. */
  attempts: readonly ExtractionAttemptView[];
  /** The max-attempt row (the CURRENT attempt), or null when no attempts. */
  latest: ExtractionAttemptView | null;
  /** True ONLY when the max-attempt row is COMPLETED (freshness rule). */
  hasCurrentCompleted: boolean;
}

export type ShipmentExtractionHistoryResult =
  | { status: "success"; documents: readonly ExtractionDocumentView[] }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * Load the extraction attempt history and extracted fields of every document
 * of a shipment, grouped per document with explicit latest-attempt marking.
 * Bounded reads, deterministic ordering, strictly typed client-safe view.
 */
export async function listExtractionHistoryForShipment(
  shipmentId: unknown,
): Promise<ShipmentExtractionHistoryResult> {
  const id = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(id)) {
    return { status: "not_found" };
  }

  let attemptRows: Array<{
    id: string;
    attempt: number;
    status: ExtractionAttemptStatus;
    error: string | null;
    engine: string;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    documentId: string;
    documentType: DocumentEntryType;
    documentVersion: number;
    documentFilename: string;
  }>;
  try {
    const [shipmentRows, rows] = await Promise.all([
      db
        .select({ id: shipments.id })
        .from(shipments)
        .where(eq(shipments.id, id))
        .limit(1),
      db
        .select({
          id: extractions.id,
          attempt: extractions.attempt,
          status: extractions.status,
          error: extractions.error,
          engine: extractions.engine,
          startedAt: extractions.startedAt,
          completedAt: extractions.completedAt,
          createdAt: extractions.createdAt,
          documentId: extractions.documentId,
          documentType: documents.documentType,
          documentVersion: documents.version,
          documentFilename: documents.originalFilename,
        })
        .from(extractions)
        .innerJoin(documents, eq(extractions.documentId, documents.id))
        .where(eq(extractions.shipmentId, id))
        .orderBy(desc(extractions.attempt)),
    ]);

    if (!shipmentRows[0]) {
      return { status: "not_found" };
    }
    attemptRows = rows;
  } catch {
    console.error(
      `[extraction-read-service] Failed to read extraction history ` +
        `(shipmentId=${id}).`,
    );
    return { status: "unavailable" };
  }

  // --- Bounded, deterministic grouping (document type order, newest first) --
  const groups = new Map<string, typeof attemptRows>();
  for (const row of attemptRows) {
    const list = groups.get(row.documentId) ?? [];
    list.push(row);
    groups.set(row.documentId, list);
  }

  const cropped: Array<typeof attemptRows> = [];
  for (const list of groups.values()) {
    // Rows already arrive attempt-descending; keep the newest N.
    cropped.push(
      [...list]
        .sort((first, second) => second.attempt - first.attempt)
        .slice(0, MAX_ATTEMPTS_PER_DOCUMENT),
    );
  }

  // --- Fields for the DISPLAYED attempts only (bounded read) ---------------
  const displayedIds = cropped.flatMap((list) => list.map((row) => row.id));
  let fieldRows: Array<{
    extractionId: string;
    fieldKey: string;
    fieldLabel: string;
    parsedValue: string | null;
    rawValue: string | null;
    unit: string | null;
    confidence: string;
    pageNumber: number | null;
    reviewStatus: "PENDING_REVIEW" | "ACCEPTED" | "CORRECTED";
  }> = [];
  if (displayedIds.length > 0) {
    try {
      fieldRows = await db
        .select({
          extractionId: extractedFields.extractionId,
          fieldKey: extractedFields.fieldKey,
          fieldLabel: extractedFields.fieldLabel,
          parsedValue: extractedFields.parsedValue,
          rawValue: extractedFields.rawValue,
          unit: extractedFields.unit,
          confidence: extractedFields.confidence,
          pageNumber: extractedFields.pageNumber,
          reviewStatus: extractedFields.reviewStatus,
        })
        .from(extractedFields)
        .where(inArray(extractedFields.extractionId, displayedIds))
        .orderBy(extractedFields.fieldKey);
    } catch {
      console.error(
        `[extraction-read-service] Failed to read extracted fields ` +
          `(shipmentId=${id}).`,
      );
      return { status: "unavailable" };
    }
  }
  const fieldsByExtraction = new Map<string, ExtractedFieldValueView[]>();
  for (const row of fieldRows) {
    fieldsByExtraction.set(row.extractionId, [
      ...(fieldsByExtraction.get(row.extractionId) ?? []),
      {
        fieldKey: row.fieldKey,
        fieldLabel: row.fieldLabel,
        // parsedValue is always written for persisted rows; rawValue is the
        // same canonical text in today's design — defensive fallback only.
        parsedValue: row.parsedValue ?? row.rawValue ?? "",
        unit: row.unit,
        confidence: row.confidence,
        pageNumber: row.pageNumber,
        reviewStatus: row.reviewStatus,
      },
    ]);
  }

  // Documents appear once per attempt-owning document row (a replaced
  // document version keeps the attempts of its historical rows), in
  // deterministic order: document type order, then version descending.
  const documentsView = [...groups.entries()]
    .map<ExtractionDocumentView>(([documentId, list]) => {
      // Rows arrive attempt-descending; keep the newest N for the view.
      const bounded = [...list]
        .sort((first, second) => second.attempt - first.attempt)
        .slice(0, MAX_ATTEMPTS_PER_DOCUMENT);
      const anchor = bounded[0];
      const attempts = bounded.map<ExtractionAttemptView>((row) => ({
        id: row.id,
        attempt: row.attempt,
        status: row.status,
        errorCode: row.error,
        engine: row.engine,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        // At most one catalog of fields per attempt — bounded.
        fields: fieldsByExtraction.get(row.id) ?? [],
      }));
      return {
        documentId,
        documentType: anchor.documentType,
        documentVersion: anchor.documentVersion,
        documentFilename: anchor.documentFilename,
        attempts,
        latest: attempts[0] ?? null,
        // Freshness rule: current data exists ONLY if the max-attempt row
        // (the newest row IS max(attempt) of the unbounded set) is COMPLETED.
        hasCurrentCompleted: (attempts[0]?.status ?? null) === "COMPLETED",
      };
    })
    .sort((first, second) => {
      const typeDelta =
        DOCUMENT_TYPE_ORDER.indexOf(first.documentType) -
        DOCUMENT_TYPE_ORDER.indexOf(second.documentType);
      if (typeDelta !== 0) return typeDelta;
      return second.documentVersion - first.documentVersion;
    });

  return { status: "success", documents: documentsView };
}
