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
 * - Fields expose: key, label, parsed value, the stored numeric value
 *   (NUMERIC(14,4) as text), unit, confidence (NUMERIC(4,3) as text), page
 *   number, review status, the field row id (the correction workflow's data
 *   reference — not an actor/storage identifier) and the append-only
 *   correction history (values, unit, reason, timestamp — never the
 *   correcting actor). rawValue's OCR-space content beyond the parsed value
 *   already shown is not exposed, and neither are storage keys, checksums,
 *   engine run refs or secrets.
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

import { asc, desc, eq, inArray } from "drizzle-orm";
import { getExtractionFieldCatalog } from "@/lib/ai/extraction-catalogs";

import { db } from "@/lib/db";
import {
  documents,
  extractedFields,
  extractions,
  extractionStatus,
  fieldCorrections,
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

/**
 * One append-only field correction of an extracted field (read view).
 * The applying actor is deliberately NOT exposed — actor IDs never reach
 * clients anywhere in this workspace.
 */
export interface FieldCorrectionView {
  /** Normalized corrected text (e.g. "3120"). */
  correctedValue: string;
  /** NUMERIC(14,4) as text when the correction stated a number. */
  correctedNumeric: string | null;
  /** Catalog unit snapshot (weights: "KG"); null otherwise. */
  unit: string | null;
  /** The mandatory human reason recorded with the correction. */
  reason: string;
  correctedAt: Date;
}

export interface ExtractedFieldValueView {
  /** extracted_fields.id — the correction workflow's FK target (a data
   * reference, NOT an actor/storage identifier; eligible correction
   * targets need it client-side to address the correction API). */
  fieldId: string;
  fieldKey: string;
  fieldLabel: string;
  /** Parsed canonical value as stored text (present values only). */
  parsedValue: string;
  /** ORIGINAL extraction numeric value (NUMERIC(14,4) as text) — never
   * mutated by corrections; null for text/date fields. */
  numericValue: string | null;
  unit: string | null;
  /** NUMERIC(4,3) as text, e.g. "0.950". */
  confidence: string;
  pageNumber: number | null;
  reviewStatus: "PENDING_REVIEW" | "ACCEPTED" | "CORRECTED";
  /** True when the catalog kind is numeric/integer (value entry must be a
   * validated decimal within NUMERIC(14,4) precision). */
  isNumeric: boolean;
  /** Append-only correction history for this field row, oldest first. The
   * LAST entry is the effective value actually checked downstream. */
  corrections: readonly FieldCorrectionView[];
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
    id: string;
    extractionId: string;
    fieldKey: string;
    fieldLabel: string;
    parsedValue: string | null;
    rawValue: string | null;
    numericValue: string | null;
    unit: string | null;
    confidence: string;
    pageNumber: number | null;
    reviewStatus: "PENDING_REVIEW" | "ACCEPTED" | "CORRECTED";
  }> = [];
  if (displayedIds.length > 0) {
    try {
      fieldRows = await db
        .select({
          id: extractedFields.id,
          extractionId: extractedFields.extractionId,
          fieldKey: extractedFields.fieldKey,
          fieldLabel: extractedFields.fieldLabel,
          parsedValue: extractedFields.parsedValue,
          rawValue: extractedFields.rawValue,
          numericValue: extractedFields.numericValue,
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
  // --- Append-only correction history for the displayed field rows ---------
  // Oldest first so the LAST entry per field is the effective value the
  // discrepancy engine checks (max(correctedAt, id) by the same rule the
  // check service uses). correctedBy (an actor ID) is never selected.
  const correctionsByField = new Map<string, FieldCorrectionView[]>();
  if (fieldRows.length > 0) {
    try {
      const correctionRows = await db
        .select({
          fieldId: fieldCorrections.fieldId,
          correctedValue: fieldCorrections.correctedValue,
          correctedNumeric: fieldCorrections.correctedNumeric,
          unit: fieldCorrections.unit,
          reason: fieldCorrections.reason,
          correctedAt: fieldCorrections.correctedAt,
        })
        .from(fieldCorrections)
        .where(
          inArray(
            fieldCorrections.fieldId,
            fieldRows.map((row) => row.id),
          ),
        )
        .orderBy(asc(fieldCorrections.correctedAt), asc(fieldCorrections.id));
      for (const row of correctionRows) {
        const list = correctionsByField.get(row.fieldId) ?? [];
        list.push({
          correctedValue: row.correctedValue,
          correctedNumeric: row.correctedNumeric,
          unit: row.unit,
          reason: row.reason,
          correctedAt: row.correctedAt,
        });
        correctionsByField.set(row.fieldId, list);
      }
    } catch {
      console.error(
        `[extraction-read-service] Failed to read field corrections ` +
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
        fieldId: row.id,
        fieldKey: row.fieldKey,
        fieldLabel: row.fieldLabel,
        // parsedValue is always written for persisted rows; rawValue is the
        // same canonical text in today's design — defensive fallback only.
        parsedValue: row.parsedValue ?? row.rawValue ?? "",
        numericValue: row.numericValue,
        unit: row.unit,
        confidence: row.confidence,
        pageNumber: row.pageNumber,
        reviewStatus: row.reviewStatus,
        // isNumeric + corrections are enriched per document below (they
        // need the document's catalog / the field-id-keyed map).
        isNumeric: false,
        corrections: [],
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
      // Catalog kinds come from the same catalog the extraction validated
      // against (single source of truth for field types). The lookup is per
      // document type; an unknown key (drift only) falls back to the stored
      // numeric column.
      const kindByKey = new Map(
        getExtractionFieldCatalog(anchor.documentType).fields.map(
          (definition) => [definition.key, definition.kind],
        ),
      );
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
        fields: (fieldsByExtraction.get(row.id) ?? []).map((field) => {
          const kind = kindByKey.get(field.fieldKey);
          return {
            ...field,
            isNumeric:
              kind === "numeric" ||
              kind === "integer" ||
              (kind === undefined && field.numericValue !== null),
            corrections: correctionsByField.get(field.fieldId) ?? [],
          };
        }),
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
