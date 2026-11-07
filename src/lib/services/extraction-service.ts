import "server-only";

/**
 * Extraction service — the ONLY sanctioned writer of the extractions and
 * extracted_fields tables, and the orchestrator of the per-document
 * extraction lifecycle: attempt rows, sequential provider calls, validation,
 * field persistence, supersede/finalize and the EXTRACTION_RUN audit trail.
 *
 * Data flow (per shipment run, documents processed SEQUENTIALLY):
 *   1. session + roles (server-verified; roles mirror the upload decision —
 *      DOCUMENTATION_EXECUTIVE / DOCUMENTATION_MANAGER — pending a dedicated
 *      extraction-role decision)
 *   2. shipment EXPORTED gate; active documents via
 *      `getActiveDocumentsForExtraction` (the sanctioned extraction reader)
 *   3. shipment lifecycle: DRAFT -> PROCESSING (conditional single UPDATE;
 *      other statuses are left untouched — transitions into REVIEW and
 *      beyond belong to later milestones)
 *   4. per document: durable daily-count check -> attempt row (PROCESSING)
 *      -> storage `get` -> SHA-256 re-verification vs `checksum_sha256`
 *      -> Gemini adapter call -> strict catalog validation
 *      -> completion statement (fields batch + COMPLETED supersede + finalize)
 *      -> EXTRACTION_RUN audit.
 *
 * Freshness rule (schema contract): the CURRENT attempt is max(attempt) across
 * ALL statuses. Previous COMPLETED attempts are flipped to SUPERSEDED only
 * when a NEW attempt completes (inside the completing statement, respecting
 * the `extractions_completed_uq` partial unique index). A newer FAILED or
 * PROCESSING attempt therefore still blocks downstream use of an older
 * COMPLETED attempt — downstream consumers MUST read max(attempt), which is
 * exactly the rule the earlier milestones established.
 *
 * Atomicity (neon-http driver — NO transactions across statements):
 * - Every write below is a single statement. The completion statement is ONE
 *   PostgreSQL statement (fields INSERT + previous-COMPLETED flip to
 *   SUPERSEDED + finalize to COMPLETED) — atomic like the upload CTE, with
 *   the partial unique index checked against the live index; CTE order
 *   dependency is the same documented reasoning as the upload statement.
 * - The attempt insert, the completion statement, the FAILED flip and the
 *   audit insert are NOT atomic with each other. Each failure point maps to a
 *   typed outcome; no claim of cross-statement atomicity is made anywhere.
 *   Recovery semantics: a statement that aborts leaves its own writes rolled
 *   back (e.g. an aborted completion leaves the attempt in PROCESSING with no
 *   fields); the NEXT run creates attempt N+1 and the max(attempt) rule
 *   freezes the stale row out of downstream use. Stale PROCESSING rows are
 *   residue by design and need no migration to become harmless.
 *
 * Daily ceiling (NOT a global quota — honest race disclosure):
 * - Before each attempt row, the service counts `extractions` rows created
 *   since 00:00 UTC and skips documents once the shared
 *   `EXTRACTION_DAILY_REQUEST_CEILING` is reached.
 * - Count-then-insert is inherently racy (neon-http has no transactions):
 *   two concurrent runs can both observe `count < ceiling` and both proceed,
 *   so concurrent runs can overshoot. Together with the separate per-instance
 *   counter in `request-ceiling.ts` this is layered best-effort limiting —
 *   never an absolute global cap, and provider-side 429s remain the final
 *   hard boundary (mapped to a typed FAILED outcome).
 *
 * Security/logging: document bytes, model prompts, raw model output,
 * credentials and extracted VALUES are never logged. Logs carry ids, counts,
 * document types and sanitized error codes only.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, gte, max, sql } from "drizzle-orm";

import { USER_ROLES } from "@/lib/auth";
import { buildExtractionResponseSchema, getExtractionFieldCatalog } from "@/lib/ai/extraction-catalogs";
import { buildExtractionPrompt } from "@/lib/ai/extraction-prompt";
import { GEMINI_EXTRACTION_MODEL, extractStructured } from "@/lib/ai/provider";
import { EXTRACTION_DAILY_REQUEST_CEILING } from "@/lib/ai/request-ceiling";
import { parseStructuredExtractionResponse } from "@/lib/ai/response-validation";
import { db } from "@/lib/db";
import { extractions, shipments } from "@/lib/db/schema";
import { getSession, hasRole } from "@/lib/server/auth";
import { cloudinaryStorage } from "@/lib/storage/cloudinary";
import type { StorageGetResult } from "@/lib/storage/types";
import {
  getActiveDocumentsForExtraction,
  type ActiveExtractionDocument,
  type DocumentEntryType,
} from "./document-service";
import {
  appendAuditLog,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
} from "./audit-service";

/** Postgres unique-violation SQLSTATE (walks Drizzle/driver cause chains). */
const PG_UNIQUE_VIOLATION = "23505";

const UNIQUE_VIOLATION_CONSTRAINTS = {
  attempt: "extractions_doc_attempt_uq",
  completed: "extractions_completed_uq",
  fieldKey: "extracted_fields_run_key_uq",
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Auto-accept policy: only NON-required fields with confidence >= 0.90 may
 * land as ACCEPTED; required keys and anything below the threshold stay
 * PENDING_REVIEW (explicitly supported by the schema's reviewStatus column
 * and its PENDING_REVIEW default).
 */
const AUTO_ACCEPT_MIN_CONFIDENCE = 0.9;

/** Extracting from an EXPORTED shipment is blocked (upload decision E analog). */
const BLOCKED_STATUSES = ["EXPORTED"] as const;

/** Sanitized error codes — the ONLY text persisted into extractions.error. */
export type ExtractionErrorCode =
  | "STORAGE_NOT_FOUND"
  | "STORAGE_KEY_INVALID"
  | "STORAGE_UNAVAILABLE"
  | "CHECKSUM_MISMATCH"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_REJECTED"
  | "PROVIDER_INVALID_OUTPUT"
  | "DAILY_CEILING"
  | "PERSISTENCE_FAILED"
  | "INTERNAL_ERROR";

export type DocumentExtractionOutcome =
  | {
      status: "completed" | "completed_audit_failed";
      documentId: string;
      documentType: DocumentEntryType;
      attempt: number;
      fieldCount: number;
      /** Required catalog keys with no extracted value (key names only). */
      missingRequiredKeys: readonly string[];
    }
  | {
      status: "failed";
      documentId: string;
      documentType: DocumentEntryType;
      attempt: number;
      /** 0 means no attempt row exists for this failure. */
      errorCode: ExtractionErrorCode;
    }
  | {
      /** A concurrent run already owns the next attempt number. */
      status: "conflict";
      documentId: string;
      documentType: DocumentEntryType;
    }
  | {
      /** Document skipped before any attempt row was created. */
      status: "skipped";
      documentId: string;
      documentType: DocumentEntryType;
      reason: "daily_ceiling" | "daily_count_unavailable";
    };

export type RunExtractionResult =
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "shipment_not_found" }
  | { status: "shipment_exported" }
  | { status: "no_documents" }
  | { status: "unavailable" }
  | { status: "status_update_failed" }
  | {
      status: "started";
      /** Whether this run transitioned DRAFT -> PROCESSING (other
       * non-DRAFT statuses are left to their existing milestone flow). */
      flippedToProcessing: boolean;
      outcomes: readonly DocumentExtractionOutcome[];
    };

/** Walk Drizzle/driver error `cause` chains for a unique violation. */
const findUniqueViolation = (error: unknown): string | null => {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return (current as { constraint?: unknown }).constraint as string | null;
    }
    current = current.cause;
  }
  return null;
};

/** Start of the current UTC day (day-boundary policy mirrors the ceilings). */
const startOfUtcDay = (): Date => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
};

/** SHA-256 over the EXACT retrieved bytes (same digest stage as upload). */
const computeSha256 = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** One field row as it will be written (value columns immutable by design). */
interface FieldRowValues {
  key: string;
  label: string;
  /** Canonical model value as text — raw == parsed (no OCR text fidelity). */
  raw: string;
  parsed: string;
  numeric: string | null;
  unit: string | null;
  /** Rounded to the confidence column's precision: NUMERIC(4,3). */
  confidence: string;
  pageNumber: number | null;
  review: "PENDING_REVIEW" | "ACCEPTED";
}

// ---------------------------------------------------------------------------

/**
 * Run the extraction lifecycle for every active document of a shipment,
 * sequentially. The caller owns life after the typed result: routes (later
 * step) map outcomes to HTTP/UI states; nothing here touches routes or page
 * state.
 */
export async function runExtractionForShipment(
  shipmentId: unknown,
): Promise<RunExtractionResult> {
  // --- 1. Server-side session & role (never client-supplied identity) ------
  const session = await getSession();
  if (!session) {
    return { status: "unauthenticated" };
  }
  if (!hasRole(session, [USER_ROLES.DOCUMENTATION_EXECUTIVE, USER_ROLES.DOCUMENTATION_MANAGER])) {
    return { status: "forbidden" };
  }
  const actorId = session.user.id;

  const id = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(id)) {
    return { status: "shipment_not_found" };
  }

  // --- 2. Shipment export gate + active documents --------------------------
  let shipmentStatus: string;
  try {
    const statusRows = await db
      .select({ status: shipments.status })
      .from(shipments)
      .where(eq(shipments.id, id))
      .limit(1);
    if (!statusRows[0]) {
      return { status: "shipment_not_found" };
    }
    shipmentStatus = statusRows[0].status;
  } catch {
    console.error(`[extraction-service] Failed to read shipment status (shipmentId=${id}).`);
    return { status: "unavailable" };
  }
  if ((BLOCKED_STATUSES as readonly string[]).includes(shipmentStatus)) {
    return { status: "shipment_exported" };
  }

  const docsResult = await getActiveDocumentsForExtraction(id);
  if (docsResult.status === "not_found") {
    return { status: "shipment_not_found" };
  }
  if (docsResult.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (docsResult.documents.length === 0) {
    return { status: "no_documents" };
  }

  // --- 3. Lifecycle: DRAFT -> PROCESSING (single conditional statement) -----
  let flippedToProcessing = false;
  try {
    const flipped = await db
      .update(shipments)
      .set({ status: "PROCESSING" })
      .where(and(eq(shipments.id, id), eq(shipments.status, "DRAFT")))
      .returning({ id: shipments.id });
    flippedToProcessing = flipped.length > 0;
  } catch {
    console.error(
      `[extraction-service] Shipment PROCESSING transition failed (shipmentId=${id}) — no documents processed.`,
    );
    return { status: "status_update_failed" };
  }

  // --- 4. Sequential per-document extraction -------------------------------
  const outcomes: DocumentExtractionOutcome[] = [];
  for (const document of docsResult.documents) {
    outcomes.push(await extractOneDocument(id, document, actorId));
  }

  return { status: "started", flippedToProcessing, outcomes };
}

// ---------------------------------------------------------------------------
// Per-document lifecycle
// ---------------------------------------------------------------------------

const extractOneDocument = async (
  shipmentId: string,
  document: ActiveExtractionDocument,
  actorId: string,
): Promise<DocumentExtractionOutcome> => {
  // --- D1. Durable daily-row pre-check (best-effort; racy by nature) -------
  let rowsToday: number;
  try {
    const countRows = await db
      .select({ total: count() })
      .from(extractions)
      .where(gte(extractions.createdAt, startOfUtcDay()));
    rowsToday = countRows[0]?.total ?? 0;
  } catch {
    console.error(
      `[extraction-service] Daily-count query failed (shipmentId=${shipmentId}, ` +
        `documentId=${document.id}) — skipping the document this run.`,
    );
    return {
      status: "skipped",
      documentId: document.id,
      documentType: document.documentType,
      reason: "daily_count_unavailable",
    };
  }
  if (rowsToday >= EXTRACTION_DAILY_REQUEST_CEILING) {
    console.error(
      `[extraction-service] Daily ceiling reached (rows=${rowsToday}) — ` +
        `skipping documentId=${document.id}.`,
    );
    return {
      status: "skipped",
      documentId: document.id,
      documentType: document.documentType,
      reason: "daily_ceiling",
    };
  }

  // --- D2. Attempt row: server-generated id, attempt = max(attempt) + 1 ----
  // The (documentId, attempt) unique index fences concurrent runs: a race
  // aborts the loser's insert with 23505 and NO state is created.
  const attemptId = randomUUID();
  let attempt: number;
  try {
    const lastRows = await db
      .select({ last: max(extractions.attempt) })
      .from(extractions)
      .where(eq(extractions.documentId, document.id));
    attempt = (lastRows[0]?.last ?? 0) + 1;
    await db.insert(extractions).values({
      // Server-owned: exact id/attempt/status/engine/timestamps; completedAt
      // must be NULL until COMPLETED (check constraint). engineRunRef is
      // null — provider interactions are store:false (no server-side ref).
      id: attemptId,
      documentId: document.id,
      shipmentId: document.shipmentId,
      attempt,
      status: "PROCESSING",
      engine: GEMINI_EXTRACTION_MODEL,
      engineRunRef: null,
      startedAt: new Date(),
      triggeredBy: actorId,
    });
  } catch (error) {
    if (
      findUniqueViolation(error) === UNIQUE_VIOLATION_CONSTRAINTS.attempt
    ) {
      console.error(
        `[extraction-service] Concurrent attempt conflict (documentId=${document.id}).`,
      );
      return {
        status: "conflict",
        documentId: document.id,
        documentType: document.documentType,
      };
    }
    console.error(
      `[extraction-service] Attempt insert failed (shipmentId=${shipmentId}, ` +
        `documentId=${document.id}) — no attempt row exists.`,
    );
    return {
      status: "failed",
      documentId: document.id,
      documentType: document.documentType,
      attempt: 0,
      errorCode: "INTERNAL_ERROR",
    };
  }

  // --- D3. Retrieve the ORIGINAL bytes server-side -------------------------
  let stored: StorageGetResult;
  try {
    stored = await cloudinaryStorage.get({ key: document.storageKey });
  } catch {
    return failAttempt(shipmentId, document, attempt, attemptId, actorId, "STORAGE_UNAVAILABLE");
  }
  if (stored.status === "not_found") {
    return failAttempt(shipmentId, document, attempt, attemptId, actorId, "STORAGE_NOT_FOUND");
  }
  if (stored.status === "invalid_key") {
    return failAttempt(shipmentId, document, attempt, attemptId, actorId, "STORAGE_KEY_INVALID");
  }
  if (stored.status !== "found") {
    return failAttempt(shipmentId, document, attempt, attemptId, actorId, "STORAGE_UNAVAILABLE");
  }

  // --- D4. Integrity: recompute SHA-256 vs the stored checksum -------------
  // Mismatch = tampering/corruption: the bytes NEVER reach the provider.
  if (computeSha256(stored.data) !== document.checksumSha256) {
    console.error(
      `[extraction-service] Checksum mismatch (documentId=${document.id}, ` +
        `attempt=${attempt}) — bytes not forwarded.`,
    );
    return failAttempt(shipmentId, document, attempt, attemptId, actorId, "CHECKSUM_MISMATCH");
  }

  // --- D5. Provider call via the pinned adapter ----------------------------
  // The instance-local counter inside the adapter reserves a slot too; a
  // race past the durable check can still surface `daily_ceiling_reached`.
  const providerResult = await extractStructured({
    prompt: buildExtractionPrompt(document.documentType),
    schema: buildExtractionResponseSchema(document.documentType),
    document: stored.data,
  });

  if (providerResult.status !== "success") {
    const errorCode: ExtractionErrorCode = (() => {
      switch (providerResult.status) {
        case "rate_limited":
          return "PROVIDER_RATE_LIMITED";
        case "rejected":
          return "PROVIDER_REJECTED";
        case "unavailable":
          return "PROVIDER_UNAVAILABLE";
        case "invalid_response":
          return "PROVIDER_INVALID_OUTPUT";
        case "daily_ceiling_reached":
          return "DAILY_CEILING";
      }
    })();
    return failAttempt(shipmentId, document, attempt, attemptId, actorId, errorCode);
  }

  // --- D6. Strict validation against the generating catalog ---------------
  const parseResult = parseStructuredExtractionResponse(
    providerResult.data,
    document.documentType,
  );
  if (parseResult.status === "invalid") {
    console.error(
      `[extraction-service] Model output rejected (documentId=${document.id}, ` +
        `attempt=${attempt}, reason=${parseResult.reason}).`,
    );
    return failAttempt(shipmentId, document, attempt, attemptId, actorId, "PROVIDER_INVALID_OUTPUT");
  }

  const catalog = getExtractionFieldCatalog(document.documentType);
  const requiredByKey = new Map(catalog.fields.map((f) => [f.key, f.required]));
  const missingRequiredKeys = parseResult.fields
    .filter((field) => field.value === null && (requiredByKey.get(field.key) ?? false))
    .map((field) => field.key);

  // Only PRESENT values are persisted (absent fields get no row; missing
  // required keys are surfaced in the outcome/audit instead. Fabricated
  // confidences for absent values would violate the confidence contract).
  const rows = parseResult.fields
    .filter((field) => field.value !== null)
    .map<FieldRowValues>((field) => {
      // Value is not null here — narrowed by the filter; coercions below.
      const value = field.value as string | number;
      const isNumeric = field.kind === "numeric" || field.kind === "integer";
      const accepted =
        !(requiredByKey.get(field.key) ?? false) && field.confidence !== null &&
        field.confidence >= AUTO_ACCEPT_MIN_CONFIDENCE;
      return {
        key: field.key,
        label: field.label,
        raw: String(value),
        parsed: String(value),
        numeric: isNumeric ? String(value) : null,
        unit: field.unit,
        // NUMERIC(4,3): exact 3-decimal string; validator guarantees [0,1].
        confidence: (field.confidence as number).toFixed(3),
        pageNumber: parseResult.pageNumber,
        review: accepted ? "ACCEPTED" : "PENDING_REVIEW",
      };
    });

  // --- D7. Completion in ONE statement: fields + SUPERSEDED + COMPLETED ----
  // CTE order mirrors the upload statement: the previous COMPLETED row's
  // partial-unique-index entry is released by the `supersede` UPDATE before
  // `finalize` introduces the new COMPLETED row. Any constraint abort rolls
  // the WHOLE statement back (attempt stays PROCESSING, no orphan fields).
  try {
    const finalizeSql =
      rows.length > 0
        ? sql`
      WITH inserted_fields AS (
        INSERT INTO extracted_fields (
          extraction_id,
          shipment_id,
          field_key,
          field_label,
          raw_value,
          parsed_value,
          numeric_value,
          unit,
          confidence,
          page_number,
          review_status
        ) VALUES ${sql.join(
          rows.map(
            (row) => sql`(
              ${attemptId},
              ${shipmentId},
              ${row.key},
              ${row.label},
              ${row.raw},
              ${row.parsed},
              ${row.numeric},
              ${row.unit},
              ${row.confidence},
              ${row.pageNumber},
              ${row.review}
            )`,
          ),
          sql.raw(", "),
        )}
        RETURNING id
      ),
      supersede AS (
        UPDATE extractions
        SET status = 'SUPERSEDED'
        WHERE document_id = ${document.id}
          AND status = 'COMPLETED'
          AND id <> ${attemptId}
        RETURNING id
      ),
      finalize AS (
        UPDATE extractions
        SET status = 'COMPLETED',
            completed_at = now(),
            error = NULL
        WHERE id = ${attemptId}
          AND status = 'PROCESSING'
        RETURNING id
      )
      SELECT
        (SELECT count(*)::int FROM inserted_fields) AS field_count,
        (SELECT count(*)::int FROM supersede) AS superseded_count,
        (SELECT f.id FROM finalize f LIMIT 1) AS finalized_id
    `
        : sql`
      WITH supersede AS (
        UPDATE extractions
        SET status = 'SUPERSEDED'
        WHERE document_id = ${document.id}
          AND status = 'COMPLETED'
          AND id <> ${attemptId}
        RETURNING id
      ),
      finalize AS (
        UPDATE extractions
        SET status = 'COMPLETED',
            completed_at = now(),
            error = NULL
        WHERE id = ${attemptId}
          AND status = 'PROCESSING'
        RETURNING id
      )
      SELECT
        0::int AS field_count,
        (SELECT count(*)::int FROM supersede) AS superseded_count,
        (SELECT f.id FROM finalize f LIMIT 1) AS finalized_id
    `;

    const result = await db.execute<{
      field_count: number;
      superseded_count: number;
      finalized_id: string | null;
    }>(finalizeSql);

    const summary = result.rows[0];
    if (!summary?.finalized_id) {
      // The finalize UPDATE matched no PROCESSING row — the attempt was moved
      // out from under us (concurrency) or is already final. Fields were
      // rolled back with the aborted statement.
      console.error(
        `[extraction-service] Completion finalize matched no PROCESSING row ` +
          `(documentId=${document.id}, attemptId=${attemptId}).`,
      );
      return failAttempt(shipmentId, document, attempt, attemptId, actorId, "PERSISTENCE_FAILED");
    }

    // --- D8. EXTRACTION_RUN audit (explicit failure policy) ----------------
    // Mirrors the upload partial-success pattern: a failed audit write NEVER
    // invalidates or silently retries the already-completed attempt — it is
    // surfaced as `completed_audit_failed` for manual backfill.
    try {
      await appendAuditLog({
        action: AUDIT_ACTIONS.extractionRun,
        entityType: AUDIT_ENTITY_TYPES.document,
        entityId: document.id,
        actorId,
        shipmentId,
        details: {
          documentType: document.documentType,
          version: document.version,
          attempt,
          engine: GEMINI_EXTRACTION_MODEL,
          status: "COMPLETED",
          fieldCount: summary.field_count,
          supersededCount: summary.superseded_count,
          missingRequiredKeys,
        },
      });
    } catch {
      console.error(
        `[extraction-service] EXTRACTION_RUN audit write failed for completed ` +
          `attempt id=${attemptId} (shipmentId=${shipmentId}, documentId=${document.id}) ` +
          `— audit trail requires manual backfill.`,
      );
      return {
        status: "completed_audit_failed",
        documentId: document.id,
        documentType: document.documentType,
        attempt,
        fieldCount: summary.field_count,
        missingRequiredKeys,
      };
    }

    return {
      status: "completed",
      documentId: document.id,
      documentType: document.documentType,
      attempt,
      fieldCount: summary.field_count,
      missingRequiredKeys,
    };
  } catch (error) {
    const constraint = findUniqueViolation(error);
    if (constraint !== null) {
      // Statement aborted atomically: no fields, no status change. The
      // attempt row is PROCESSING residue; the next run creates attempt N+1.
      console.error(
        `[extraction-service] Completion statement aborted (${constraint}) ` +
          `(documentId=${document.id}, attempt=${attempt}).`,
      );
      return failAttempt(shipmentId, document, attempt, attemptId, actorId, "PERSISTENCE_FAILED");
    }
    console.error(
      `[extraction-service] Completion statement failed (documentId=${document.id}, ` +
        `attempt=${attempt}).`,
    );
    return failAttempt(shipmentId, document, attempt, attemptId, actorId, "INTERNAL_ERROR");
  }
};

// ---------------------------------------------------------------------------

/**
 * Flip an in-flight attempt to FAILED with a sanitized error code, then audit
 * the failure. Sub-statements are independent (neon-http): a FAILED flip that
 * cannot execute leaves the row as PROCESSING residue (typed {@link DocumentExtractionOutcome} still reports the
 * failure); an audit failure after a FAILED flip is logged for backfill — it
 * never retries or revives the extraction.
 */
const failAttempt = async (
  shipmentId: string,
  document: ActiveExtractionDocument,
  attempt: number,
  attemptId: string,
  actorId: string,
  errorCode: ExtractionErrorCode,
): Promise<DocumentExtractionOutcome> => {
  try {
    const updated = await db
      .update(extractions)
      .set({ status: "FAILED", error: errorCode })
      .where(and(eq(extractions.id, attemptId), eq(extractions.status, "PROCESSING")))
      .returning({ id: extractions.id });
    if (updated.length === 0) {
      console.error(
        `[extraction-service] FAILED flip matched no PROCESSING row ` +
          `(attemptId=${attemptId}) — row may already be final.`,
      );
    }
  } catch {
    console.error(
      `[extraction-service] FAILED flip write failed (attemptId=${attemptId}, ` +
        `errorCode=${errorCode}) — row remains PROCESSING.`,
    );
  }

  try {
    await appendAuditLog({
      action: AUDIT_ACTIONS.extractionRun,
      entityType: AUDIT_ENTITY_TYPES.document,
      entityId: document.id,
      actorId,
      shipmentId,
      details: {
        documentType: document.documentType,
        version: document.version,
        attempt,
        engine: GEMINI_EXTRACTION_MODEL,
        status: "FAILED",
        errorCode,
      },
    });
  } catch {
    console.error(
      `[extraction-service] EXTRACTION_RUN audit write failed for FAILED attempt ` +
        `id=${attemptId} (shipmentId=${shipmentId}) — audit trail requires manual backfill.`,
    );
  }

  return {
    status: "failed",
    documentId: document.id,
    documentType: document.documentType,
    attempt,
    errorCode,
  };
};
