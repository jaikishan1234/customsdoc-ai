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
 *   2. shipment eligibility gate (explicit allow-list — see
 *      {@link ELIGIBLE_STATUSES}); active documents via
 *      `getActiveDocumentsForExtraction` (the sanctioned extraction reader)
 *   3. shipment lifecycle: DRAFT|REJECTED -> PROCESSING (single conditional
 *      UPDATE guarded by an inArray allow-list; REVIEW and beyond are never
 *      touched — transitions there belong to later milestones)
 *   4. per document: durable daily-count check -> attempt row (PROCESSING)
 *      -> storage `get` -> SHA-256 re-verification vs `checksum_sha256`
 *      -> Gemini adapter call -> strict catalog validation
 *      -> S1 supersede statement -> S2 fields+finalize statement
 *      -> EXTRACTION_RUN audit.
 *
 * Freshness rule (schema contract): the CURRENT attempt is max(attempt) across
 * ALL statuses. Previous COMPLETED attempts are flipped to SUPERSEDED only
 * when a NEW attempt completes (S1 of the completion sequence, before the new
 * attempt is finalized against `extractions_completed_uq`). A newer FAILED or
 * PROCESSING attempt therefore still blocks downstream use of an older
 * COMPLETED attempt — downstream consumers MUST read max(attempt), which is
 * exactly the rule the earlier milestones established.
 *
 * Atomicity (neon-http driver — NO transactions across statements):
 * - Completion is TWO SEQUENTIAL statements, not one CTE. PostgreSQL §7.8.4
 *   makes the execution order of sibling data-modifying CTEs UNPREDICTABLE,
 *   so the earlier single tombstone+finalize statement could violate the
 *   `extractions_completed_uq` partial unique index purely by scheduling.
 *   Order is now deterministic by construction:
 *     S1: UPDATE extractions SET status='SUPERSEDED'
 *           WHERE document_id AND status='COMPLETED' AND id<>attempt
 *         RETURNING id                                  (own transaction)
 *     S2: fields batch INSERT + finalize to COMPLETED in ONE statement —
 *         the partial unique index cannot conflict because S1 already
 *         released the prior COMPLETED entry. S2's `finalize` CTE also
 *         re-verifies `status='PROCESSING'`; a NULL finalize result means
 *         the attempt was moved out from under us and nothing is finalized.
 *   Partial-failure window (honest disclosure): if S1 committed but S2 then
 *   fails, the previous COMPLETED attempt is ALREADY SUPERSEDED (no longer
 *   current) while the new attempt is NOT COMPLETED — the document has no
 *   current completed extraction until a later attempt completes. This is
 *   reported as the distinct `supersede_incomplete` outcome (code
 *   SUPERSEDE_INCOMPLETE in the attempt's audit row); recovery is a plain
 *   retry (attempt N+1), and the max(attempt) rule keeps the stale rows
 *   harmless to every downstream consumer.
 * - The attempt insert, S1, S2, the FAILED flip and the audit insert are NOT
 *   atomic with each other. Each failure point maps to a typed outcome; no
 *   claim of cross-statement atomicity is made anywhere.
 *   Recovery semantics: a statement that aborts leaves its own writes rolled
 *   back (e.g. an aborted S2 leaves the attempt in PROCESSING with no
 *   fields); the NEXT run creates attempt N+1 and the max(attempt) rule
 *   freezes the stale row out of downstream use.
 * - Known residue: a crash between the attempt INSERT and a terminal write
 *   leaves a PROCESSING row with no explanation. max(attempt) keeps it out of
 *   downstream use, but NO reaping/recovery policy exists yet — one is still
 *   needed in a later pass (do not assume otherwise).
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
import { and, count, eq, gte, inArray, max, ne, sql } from "drizzle-orm";

import { USER_ROLES } from "@/lib/auth";
import { buildExtractionResponseSchema, getExtractionFieldCatalog } from "@/lib/ai/extraction-catalogs";
import { buildExtractionPrompt } from "@/lib/ai/extraction-prompt";
import { GEMINI_EXTRACTION_MODEL, extractStructured } from "@/lib/ai/provider";
import { EXTRACTION_DAILY_REQUEST_CEILING } from "@/lib/ai/request-ceiling";
import { parseStructuredExtractionResponse } from "@/lib/ai/response-validation";
import { db } from "@/lib/db";
import { extractions, shipmentStatus, shipments } from "@/lib/db/schema";
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

/**
 * Shipment statuses eligible for extraction — an explicit ALLOW-LIST, not a
 * block-list, so every new lifecycle status is blocked by default:
 * - DRAFT: normal start.
 * - PROCESSING: continuation of an in-flight extraction (or recovery of a
 *   crashed run — an earlier attempt may remain PROCESSING).
 * - REJECTED: rework — new documents may be uploaded to a REJECTED shipment
 *   (upload decision E), so re-extraction is symmetric; the shipment flips
 *   back to PROCESSING for the new round of work.
 * REVIEW / AWAITING_APPROVAL / APPROVED / EXPORTED are BLOCKED: extraction
 * output feeds human review, and replacing extracted values mid-review or
 * under an approved/exported snapshot would invalidate the frozen review
 * and approval data.
 */
const ELIGIBLE_STATUSES = ["DRAFT", "PROCESSING", "REJECTED"] as const;

/** Statuses the lifecycle flip may move to PROCESSING (guarded in UPDATE). */
const FLIP_TO_PROCESSING_FROM = ["DRAFT", "REJECTED"] as const;

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
  | "SUPERSEDE_INCOMPLETE"
  | "INTERNAL_ERROR";

/** A failed attempt — always paired with a sanitized error code. */
export interface FailedExtractionOutcome {
  status: "failed";
  documentId: string;
  documentType: DocumentEntryType;
  attempt: number;
  errorCode: ExtractionErrorCode;
}

/**
 * Superseded-but-not-finalized (distinct from an ordinary failure): S1 of the
 * completion sequence committed — the previous COMPLETED attempt is
 * SUPERSEDED and NO LONGER CURRENT — but the new attempt could not be
 * finalized to COMPLETED (S2 failed, or its finalize matched no PROCESSING
 * row). The document has NO current completed extraction until a later
 * attempt completes; recovery is a plain retry (attempt N+1). The attempt
 * row carries FAILED / SUPERSEDE_INCOMPLETE so the state is explainable.
 */
export interface SupersedeIncompleteOutcome {
  status: "supersede_incomplete";
  documentId: string;
  documentType: DocumentEntryType;
  attempt: number;
  /** How many prior COMPLETED rows S1 tombstoned before S2 failed. */
  supersededAttemptCount: number;
}

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
  | FailedExtractionOutcome
  | SupersedeIncompleteOutcome
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

/** The shipment-status union from the pg enum, for typed block reports. */
type ShipmentStatusValue = (typeof shipmentStatus.enumValues)[number];

export type RunExtractionResult =
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "shipment_not_found" }
  | {
      /** Shipment's live status is outside {@link ELIGIBLE_STATUSES}. */
      status: "status_blocked";
      currentStatus: ShipmentStatusValue;
    }
  | { status: "no_documents" }
  | { status: "unavailable" }
  | { status: "status_update_failed" }
  | {
      status: "started";
      /** Whether this run flipped the shipment (DRAFT or REJECTED) ->
       * PROCESSING. If a concurrent run already flipped it, this is false. */
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

  // --- 2. Eligibility gate (explicit allow-list) + active documents ---------
  let liveStatus: ShipmentStatusValue;
  try {
    const statusRows = await db
      .select({ status: shipments.status })
      .from(shipments)
      .where(eq(shipments.id, id))
      .limit(1);
    if (!statusRows[0]) {
      return { status: "shipment_not_found" };
    }
    liveStatus = statusRows[0].status;
  } catch {
    console.error(`[extraction-service] Failed to read shipment status (shipmentId=${id}).`);
    return { status: "unavailable" };
  }
  if (!(ELIGIBLE_STATUSES as readonly string[]).includes(liveStatus)) {
    return { status: "status_blocked", currentStatus: liveStatus };
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

  // --- 3. Lifecycle: DRAFT|REJECTED -> PROCESSING (single guarded UPDATE) ---
  // The inArray guard is the policy enforcement point: no shipment can reach
  // PROCESSING from REVIEW/AWAITING_APPROVAL/APPROVED/EXPORTED through this
  // code path even after a concurrent status change between the gate read
  // and this UPDATE — the UPDATE would match 0 rows and the re-read below
  // reports the live status instead.
  let flippedToProcessing = false;
  if (liveStatus !== "PROCESSING") {
    try {
      const flipped = await db
        .update(shipments)
        .set({ status: "PROCESSING" })
        .where(
          and(
            eq(shipments.id, id),
            inArray(shipments.status, [...FLIP_TO_PROCESSING_FROM]),
          ),
        )
        .returning({ id: shipments.id });
      flippedToProcessing = flipped.length > 0;
      if (!flippedToProcessing) {
        // A concurrent run transitioned the status after our gate read.
        // Re-read the LIVE status: only PROCESSING (another extraction run
        // already owns the state) may continue; anything else is blocked.
        const recheckRows = await db
          .select({ status: shipments.status })
          .from(shipments)
          .where(eq(shipments.id, id))
          .limit(1);
        const current = recheckRows[0]?.status;
        if (!current) {
          return { status: "shipment_not_found" };
        }
        if (current !== "PROCESSING") {
          return { status: "status_blocked", currentStatus: current };
        }
      }
    } catch {
      console.error(
        `[extraction-service] Shipment PROCESSING transition failed (shipmentId=${id}) — no documents processed.`,
      );
      return { status: "status_update_failed" };
    }
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

  // --- D7a. S1 — SUPERSEDE the previous COMPLETED attempt (first, committed
  // as its own transaction). Deterministic order: the prior COMPLETED row's
  // `extractions_completed_uq` index entry is released BEFORE S2 finalizes
  // the new COMPLETED row. (The former single CTE cannot guarantee this —
  // PostgreSQL §7.8.4: sibling data-modifying CTE execution order is
  // UNPREDICTABLE.) The `status='COMPLETED'` predicate excludes this attempt
  // itself (still PROCESSING); `id <> attemptId` is belt-and-braces.
  let supersededCount = 0;
  try {
    const supersededRows = await db
      .update(extractions)
      .set({ status: "SUPERSEDED" })
      .where(
        and(
          eq(extractions.documentId, document.id),
          eq(extractions.status, "COMPLETED"),
          ne(extractions.id, attemptId),
        ),
      )
      .returning({ id: extractions.id });
    supersededCount = supersededRows.length;
  } catch (error) {
    // S1 aborted in full — NOTHING was tombstoned, so no
    // supersede-incomplete window exists: an ordinary failure outcome.
    console.error(
      `[extraction-service] S1 supersede statement failed ` +
        `(documentId=${document.id}, attempt=${attempt}).`,
    );
    const constraint = findUniqueViolation(error);
    return failAttempt(
      shipmentId, document, attempt, attemptId, actorId,
      constraint !== null ? "PERSISTENCE_FAILED" : "INTERNAL_ERROR",
    );
  }

  // --- D7b. S2 — fields batch INSERT + finalize to COMPLETED in ONE statement
  // (fields and attempt live in different tables, so the two CTEs have no
  // ordering dependency; both are referenced by the main SELECT and therefore
  // both run to completion). The `finalize` CTE re-verifies the attempt is
  // STILL PROCESSING before the flip; a NULL `finalized_id` means the attempt
  // was moved out from under us (concurrency) or is already final — then
  // nothing is finalized and the inserted fields (if any) roll back with the
  // aborted statement.
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
        (SELECT f.id FROM finalize f LIMIT 1) AS finalized_id
    `
        : sql`
      WITH finalize AS (
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
        (SELECT f.id FROM finalize f LIMIT 1) AS finalized_id
    `;

    const result = await db.execute<{
      field_count: number;
      finalized_id: string | null;
    }>(finalizeSql);

    const summary = result.rows[0];
    if (!summary?.finalized_id) {
      // The finalize UPDATE matched no PROCESSING row. If S1 tombstoned a
      // prior COMPLETED attempt, this is the distinct partial-failure
      // window: the previous COMPLETED attempt is ALREADY SUPERSEDED (no
      // longer current) while this attempt is NOT COMPLETED.
      console.error(
        `[extraction-service] S2 finalize matched no PROCESSING row ` +
          `(documentId=${document.id}, attemptId=${attemptId}).`,
      );
      return await completeAfterSuperseded(
        shipmentId, document, attempt, attemptId, actorId, supersededCount,
      );
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
          supersededCount,
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
    // S2 aborted atomically (its own transaction): no fields, no finalize.
    // If S1 already committed, the prior COMPLETED attempt is tombstoned —
    // the supersede-incomplete window applies regardless of the S2 cause.
    const constraint = findUniqueViolation(error);
    if (constraint !== null) {
      console.error(
        `[extraction-service] S2 finalize statement aborted (${constraint}) ` +
          `(documentId=${document.id}, attempt=${attempt}).`,
      );
    } else {
      console.error(
        `[extraction-service] S2 finalize statement failed ` +
          `(documentId=${document.id}, attempt=${attempt}).`,
      );
    }
    return await completeAfterSuperseded(
      shipmentId, document, attempt, attemptId, actorId, supersededCount,
    );
  }
};

/**
 * Handle S2 failure AFTER S1 committed: when the prior COMPLETED attempt was
 * tombstoned, return the distinct `supersede_incomplete` outcome (the attempt
 * row carries FAILED / SUPERSEDE_INCOMPLETE with the supersede detail in its
 * audit row) instead of an ordinary failure. When nothing was tombstoned,
 * this is an ordinary persistence failure.
 */
const completeAfterSuperseded = async (
  shipmentId: string,
  document: ActiveExtractionDocument,
  attempt: number,
  attemptId: string,
  actorId: string,
  supersededCount: number,
): Promise<DocumentExtractionOutcome> => {
  if (supersededCount > 0) {
    const failed = await failAttempt(
      shipmentId, document, attempt, attemptId, actorId, "SUPERSEDE_INCOMPLETE",
      { priorCompletedSuperseded: true, supersededCount },
    );
    return {
      status: "supersede_incomplete",
      documentId: failed.documentId,
      documentType: failed.documentType,
      attempt: failed.attempt,
      supersededAttemptCount: supersededCount,
    };
  }
  return failAttempt(shipmentId, document, attempt, attemptId, actorId, "PERSISTENCE_FAILED");
};

// ---------------------------------------------------------------------------

/**
 * Flip an in-flight attempt to FAILED with a sanitized error code, then audit
 * the failure. Sub-statements are independent (neon-http): a FAILED flip that
 * cannot execute leaves the row as PROCESSING residue (the typed outcome
 * still reports the failure); an audit failure after a FAILED flip is logged
 * for backfill — it never retries or revives the extraction.
 *
 * `extraDetails` merges sanitized, JSON-safe context (ids/counts/flags only)
 * into the audit payload — used e.g. to record that a prior COMPLETED attempt
 * was already SUPERSEDED when the code is SUPERSEDE_INCOMPLETE.
 */
const failAttempt = async (
  shipmentId: string,
  document: ActiveExtractionDocument,
  attempt: number,
  attemptId: string,
  actorId: string,
  errorCode: ExtractionErrorCode,
  extraDetails: Record<string, unknown> = {},
): Promise<FailedExtractionOutcome> => {
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
        ...extraDetails,
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
