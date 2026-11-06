import "server-only";

/**
 * Document upload service — the ONLY sanctioned writer of the documents
 * table (uploads / active-version replacement).
 *
 * Approved decision flow (milestone: document upload API):
 * - A: a document type left with zero active rows (previous session's crash
 *   window) is recovered inline by the next upload — the replacement
 *   statement needs no prior active row (0-row tombstone CTE) and preserves
 *   full version history (version = max(version) + 1).
 * - B: an active duplicate (same shipment + type + SHA-256) is rejected.
 * - C: superseded Cloudinary assets are retained — no deletion.
 * - D: no storage-delete API exists; orphaned assets (storage put succeeded,
 *   DB replace failed) are logged with key + checksum for reconciliation.
 * - E: uploads to EXPORTED shipments are blocked (REJECTED is allowed).
 * - F: DOCUMENT_UPLOAD audit details carry reference, documentType, version,
 *   checksumSha256, storageKey and replacedVersionId (when replacing).
 *
 * Concurrency — atomic replacement in ONE PostgreSQL statement:
 *   WITH superseded AS (UPDATE ... WHERE is_active RETURNING id)
 *   INSERT ... VALUES (..., <new_version>) RETURNING id;
 * Safety analysis (PostgreSQL READ COMMITTED, neon-http single-statement
 * execution — one implicit transaction per request):
 * - The tombstone UPDATE and the active INSERT commit together or not at all;
 *   a crash between them is not possible mid-statement.
 * - The partial unique index `documents_active_type_uq` is checked against
 *   the LIVE index at insert time (not the statement snapshot), so a
 *   concurrent duplicate of the same shipment/type always ends with exactly
 *   one active row: the later committer's INSERT blocks on the winner's
 *   uncommitted index entry, then fails with SQLSTATE 23505 (either on
 *   `documents_active_type_uq` or `documents_version_uq` when both requests
 *   race to the same version) — its whole statement aborts, including the
 *   tombstone (EPQ re-check makes the concurrent UPDATE skip the already-
 *   superseded row; the CTE's effect is rolled back with the failed insert).
 *   A failed upload therefore leaves ZERO partial state and can be retried
 *   after recomputing the version.
 * - Because of this the "insert-then-tombstone" two-step variant is unusable
 *   (it would violate the partial unique index), and the plain two-statement
 *   tombstone/insert sequence is only used conceptually — replaced entirely
 *   by the atomic CTE. No schema change and no driver change are required.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, max, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { documents, shipments, type ShipmentDocument } from "@/lib/db/schema";
import { getSession, hasRole } from "@/lib/server/auth";
import { USER_ROLES } from "@/lib/auth";
import {
  appendAuditLog,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
} from "@/lib/services/audit-service";
import { cloudinaryStorage } from "@/lib/storage/cloudinary";
import {
  validateDocumentTypeInput,
  validatePdfDocument,
  type DocumentTypeValue,
  type DocumentValidationError,
} from "@/lib/validation/document";

/** Postgres unique-violation SQLSTATE + the constraints it maps to here. */
const PG_UNIQUE_VIOLATION = "23505";
const DOCUMENT_ACTIVE_UNIQUE = "documents_active_type_uq";
const DOCUMENT_VERSION_UNIQUE = "documents_version_uq";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Both documentation roles may upload (role owned by the server session). */
const UPLOAD_ROLES = [USER_ROLES.DOCUMENTATION_EXECUTIVE, USER_ROLES.DOCUMENTATION_MANAGER] as const;

export type UploadDocumentResult =
  | {
      status: "uploaded";
      document: ShipmentDocument;
      replacedVersionId: string | null;
    }
  | {
      /** Document persisted but the audit row could not be written. */
      status: "uploaded_audit_failed";
      document: ShipmentDocument;
      replacedVersionId: string | null;
    }
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "shipment_not_found" }
  | { status: "shipment_exported" }
  | { status: "invalid_input"; error: DocumentValidationError }
  | { status: "duplicate_checksum" }
  | { status: "upload_conflict" }
  | { status: "storage_error" }
  | {
      /** Insert succeeded but the typed read-back failed (rare). */
      status: "readback_failed";
      documentId: string;
      replacedVersionId: string | null;
    }
  | { status: "unexpected_error" };

/** Walk Drizzle/Driver error `cause` chains for a Postgres unique violation. */
const findUniqueViolationConstraint = (error: unknown): string | null => {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return (current as { constraint?: unknown }).constraint as string | null;
    }
    current = current.cause;
  }
  return null;
};

/** Compute SHA-256 over the validated bytes (server-side, single pass). */
const computeSha256 = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex"); // lowercase hex-64

export async function uploadDocument(input: {
  shipmentId: unknown;
  documentType: unknown;
  filename: unknown;
  data: Uint8Array | null | undefined;
}): Promise<UploadDocumentResult> {
  // --- 1. Server-side session & role (never client-supplied identity) ------
  const session = await getSession();
  if (!session) {
    return { status: "unauthenticated" };
  }
  if (!hasRole(session, UPLOAD_ROLES)) {
    return { status: "forbidden" };
  }
  const uploaderId = session.user.id;

  // --- 2. Shipment: strict UUID validation + existence + EXPORTED block -----
  const shipmentId = typeof input.shipmentId === "string" ? input.shipmentId.trim() : "";
  if (!UUID_PATTERN.test(shipmentId)) {
    return { status: "shipment_not_found" };
  }

  const typeValidated = validateDocumentTypeInput(input.documentType);
  if (typeof typeValidated !== "string") {
    return { status: "invalid_input", error: typeValidated };
  }
  const documentType = typeValidated;

  const shipmentRows = await db
    .select({
      id: shipments.id,
      status: shipments.status,
      reference: shipments.reference,
    })
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  const shipment = shipmentRows[0];
  if (!shipment) {
    return { status: "shipment_not_found" };
  }
  if (shipment.status === "EXPORTED") {
    return { status: "shipment_exported" };
  }

  // --- 3. PDF policy validation (size capped at the ACTUAL byte count) ------
  const validation = validatePdfDocument({ filename: input.filename, data: input.data });
  if (!validation.success) {
    return { status: "invalid_input", error: validation.error };
  }
  const { mimeType, filename, data } = validation.document;

  // --- 4. Checksum + duplicate (B) + version + canonical key ----------------
  const checksumSha256 = computeSha256(data);

  const duplicateRows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.shipmentId, shipmentId),
        eq(documents.documentType, documentType),
        eq(documents.isActive, true),
        eq(documents.checksumSha256, checksumSha256),
      ),
    )
    .limit(1);
  if (duplicateRows[0]) {
    return { status: "duplicate_checksum" };
  }

  // Next version: max(version) + 1 under the (shipment, type, version)
  // unique — a concurrent race to the same number is resolved safely by the
  // atomic statement's unique indexes (mapped to `upload_conflict`).
  const versionRows = await db
    .select({ lastVersion: max(documents.version) })
    .from(documents)
    .where(
      and(
        eq(documents.shipmentId, shipmentId),
        eq(documents.documentType, documentType),
      ),
    );
  const version = (versionRows[0]?.lastVersion ?? 0) + 1;

  const documentId = randomUUID();
  // Canonical server-generated immutable key (client input plays no part).
  const canonicalKey =
    `shipments/${shipmentId}/${documentType}/v${version}/${documentId}`;

  // --- 5. Storage first; DB untouched until the object exists ---------------
  let assetKey: string;
  let sizeBytes: number;
  try {
    const stored = await cloudinaryStorage.put({
      key: canonicalKey,
      data,
      contentType: mimeType,
    });
    assetKey = stored.key;
    sizeBytes = stored.sizeBytes;
  } catch {
    console.error(
      `[document-service] Storage put failed (shipmentId=${shipmentId}, ` +
        `documentType=${documentType}, version=${version}) — no database changes.`,
    );
    return { status: "storage_error" };
  }

  // --- 6. Atomic replacement: tombstone + insert in ONE statement ------------
  try {
    // One PostgreSQL statement (one implicit transaction):
    // 1. `superseded` — tombstones the current active row (or no rows when
    //    the type has none — decision A recovery), RETURNING its id.
    // 2. `inserted` — inserts the new active version, RETURNING its id.
    // 3. Final SELECT over `inserted` exposes exactly one row carrying the
    //    inserted id plus `(SELECT id FROM superseded LIMIT 1)` — NULL when
    //    nothing was superseded — so `replacedVersionId` is exact, taken
    //    from the statement itself (no post-read inference).
    // Concurrency semantics unchanged (see module header): unique checks run
    // against the live index; any conflict aborts the WHOLE statement,
    // including the tombstone, and is mapped to `upload_conflict`.
    const replaced = await db.execute<{
      inserted_id: string;
      replaced_version_id: string | null;
    }>(sql`
      WITH superseded AS (
        UPDATE documents
        SET is_active = false,
            superseded_at = now()
        WHERE shipment_id = ${shipmentId}
          AND document_type = ${documentType}
          AND is_active = true
        RETURNING id
      ),
      inserted AS (
        INSERT INTO documents (
          id,
          shipment_id,
          document_type,
          original_filename,
          mime_type,
          size_bytes,
          storage_key,
          checksum_sha256,
          version,
          is_active,
          superseded_at,
          uploaded_by
        ) VALUES (
          ${documentId},
          ${shipmentId},
          ${documentType},
          ${filename},
          ${mimeType},
          ${sizeBytes},
          ${assetKey},
          ${checksumSha256},
          ${version},
          true,
          NULL,
          ${uploaderId}
        )
        RETURNING id
      )
      SELECT inserted.id AS inserted_id,
             (SELECT s.id FROM superseded s LIMIT 1) AS replaced_version_id
      FROM inserted
      LIMIT 1
    `);

    // `replacedVersionId` comes straight from the statement: the id of the
    // row tombstoned by the `superseded` CTE (NULL when the type had no
    // active row — decision A recovery), with no post-read inference.
    const replacedVersionId = replaced.rows[0]?.replaced_version_id ?? null;

    // --- 7. Read back through the typed query builder ------------------------
    const persistedRows = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    const document = persistedRows[0];
    if (!document) {
      // The insert committed (its own transaction — replacing active rows);
      // only the read-back failed. Nothing is safe to undo from here — log
      // precisely, leave a trail, and let the caller treat it as a retryable
      // listing/read issue rather than a failed upload.
      console.error(
        `[document-service] Document ${documentId} was inserted but the ` +
          `typed read-back failed (shipmentId=${shipmentId}, version=${version}).`,
      );
      return { status: "readback_failed", documentId, replacedVersionId };
    }

    // --- 8. Append-only audit (decision F) ----------------------------------
    try {
      await appendAuditLog({
        action: AUDIT_ACTIONS.documentUpload,
        entityType: AUDIT_ENTITY_TYPES.document,
        entityId: documentId,
        actorId: uploaderId,
        shipmentId,
        details: {
          reference: shipment.reference,
          documentType,
          version,
          checksumSha256,
          storageKey: assetKey,
          replacedVersionId,
        },
      });
    } catch {
      console.error(
        `[document-service] DOCUMENT_UPLOAD audit write failed for ` +
          `document id=${documentId} (shipmentId=${shipmentId}, ` +
          `version=${version}) — audit trail requires manual backfill.`,
      );
      return { status: "uploaded_audit_failed", document, replacedVersionId };
    }

    return { status: "uploaded", document, replacedVersionId };
  } catch (error) {
    const constraint = findUniqueViolationConstraint(error);
    if (
      constraint === DOCUMENT_ACTIVE_UNIQUE ||
      constraint === DOCUMENT_VERSION_UNIQUE
    ) {
      // Concurrent duplicate upload — statement aborted atomically (tombstone
      // included); a retry with a freshly computed version is safe.
      console.error(
        `[document-service] Concurrent upload conflict ` +
          `(constraint=${constraint}, shipmentId=${shipmentId}, ` +
          `documentType=${documentType}).`,
      );
      logOrphanedAsset(shipmentId, documentType, version, assetKey, checksumSha256);
      return { status: "upload_conflict" };
    }

    console.error(
      `[document-service] Unexpected database failure replacing active ` +
        `document (shipmentId=${shipmentId}, documentType=${documentType}, ` +
        `version=${version}).`,
    );
    logOrphanedAsset(shipmentId, documentType, version, assetKey, checksumSha256);
    return { status: "unexpected_error" };
  }
}

/** Decision D: log-only orphan marker for a future reconciliation sweep. */
const logOrphanedAsset = (
  shipmentId: string,
  documentType: DocumentTypeValue,
  version: number,
  assetKey: string,
  checksumSha256: string,
): void => {
  console.error(
    `[document-service] ORPHANED ASSET (no database row): storageKey=` +
      `${assetKey} checksumSha256=${checksumSha256} shipmentId=${shipmentId} ` +
      `documentType=${documentType} version=${version} — retained for later ` +
      `reconciliation.`,
  );
};
