import "server-only";

/**
 * Document service — the ONLY sanctioned writer of the documents table
 * (uploads / active-version replacement), and the sanctioned reader for
 * document listings on the shipment detail page.
 *
 * Approved decision flow (milestone: document upload API):
 * - A: a document type left with zero active rows (previous session's crash
 *   window) is recovered inline by the next upload — the tombstone statement
 *   may match 0 rows and the insert needs no prior active row; full version
 *   history is preserved (version = max(version) + 1).
 * - B: an active duplicate (same shipment + type + SHA-256) is rejected.
 * - C: superseded Cloudinary assets are retained — no deletion.
 * - D: no storage-delete API exists; orphaned assets (storage put succeeded,
 *   DB write failed) are logged with key + checksum for reconciliation.
 * - E: uploads to EXPORTED shipments are blocked (REJECTED is allowed).
 * - F: DOCUMENT_UPLOAD audit details carry reference, documentType, version,
 *   checksumSha256, storageKey and replacedVersionId (when replacing).
 *
 * Concurrency — deterministic replacement in TWO sequential statements
 * (neon-http: each statement is its own implicit transaction; there are no
 * multi-statement transactions and no cross-statement read-modify-write
 * atomicity):
 *   S1: UPDATE documents SET is_active=false, superseded_at=now()
 *         WHERE shipment_id AND document_type AND is_active
 *         RETURNING id                     -> replacedVersionId (the ONLY source)
 *   S2: INSERT INTO documents ... RETURNING (the full typed row via drizzle)
 * PostgreSQL §7.8.4: the execution order of sibling data-modifying CTEs is
 * UNPREDICTABLE, so the earlier single tombstone+insert CTE could violate
 * `documents_active_type_uq` purely by scheduling. Two statements make
 * tombstone-before-insert deterministic by construction.
 * - S2's unique checks (`documents_active_type_uq`, `documents_version_uq`)
 *   run against the LIVE index: a concurrent duplicate of the same
 *   shipment/type blocks on the winner's uncommitted entry and fails with
 *   SQLSTATE 23505.
 * - Partial-failure window (honest disclosure): once S1 has committed, its
 *   effect is NOT undone by an S2 failure. If S1 tombstoned ≥1 row and S2
 *   then fails, the type is left with NO active document until the next
 *   successful upload (whose S1 tolerates 0 active rows — decision A).
 *   History, versions and audit are immutable/append-only, so nothing is
 *   corrupted — but the replacement has NOT happened and must not be
 *   reported as if it had: the distinct `replacement_incomplete` outcome is
 *   returned and the stored asset is logged for reconciliation (decision D).
 * - When S1 tombstoned 0 rows, an S2 failure leaves the pre-existing state
 *   untouched: a unique violation maps to `upload_conflict` (retry-safe —
 *   the next attempt recomputes version), anything else to
 *   `unexpected_error`. No schema or driver change is required.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  documents,
  documentType,
  shipments,
  user,
  type ShipmentDocument,
} from "@/lib/db/schema";
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
      /** S1 deactivated the previous version but the replacement INSERT (S2)
       * failed — the type has NO active document until the next successful
       * upload. NOT a successful upload; the asset is logged for
       * reconciliation (decision D) and recovery is a fresh upload. */
      status: "replacement_incomplete";
      replacedVersionId: string;
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

  // --- 6. Deterministic replacement in TWO sequential statements ------------
  let replacedVersionId: string | null = null;
  try {
    // S1 — deactivate the current active version (or match 0 rows when the
    // type has none — decision A recovery). Committed in its own implicit
    // transaction; `replacedVersionId` comes from its RETURNING and is the
    // ONLY source for that id. Its effect is NOT rolled back by an S2
    // failure (documented in the module header).
    const superseded = await db
      .update(documents)
      .set({ isActive: false, supersededAt: new Date() })
      .where(
        and(
          eq(documents.shipmentId, shipmentId),
          eq(documents.documentType, documentType),
          eq(documents.isActive, true),
        ),
      )
      .returning({ id: documents.id });
    replacedVersionId = superseded[0]?.id ?? null;

    // S2 — insert the new active version via the typed query builder;
    // `.returning()` IS the typed read-back (no second read needed). The
    // unique checks (`documents_active_type_uq`, `documents_version_uq`) run
    // against the live index: a concurrent duplicate fails here with 23505.
    const insertedRows = await db
      .insert(documents)
      .values({
        id: documentId,
        shipmentId,
        documentType,
        originalFilename: filename,
        mimeType,
        sizeBytes,
        storageKey: assetKey,
        checksumSha256,
        version,
        isActive: true,
        supersededAt: null,
        uploadedBy: uploaderId,
      })
      .returning();
    const document = insertedRows[0];
    if (!document) {
      // INSERT ... RETURNING returning zero rows should not happen for a
      // plain insert; escalate so S2's failure policy below applies.
      throw new Error("documents insert returned no row");
    }

    // --- 7. Append-only audit (decision F) ----------------------------------
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

    if (replacedVersionId === null) {
      // S1 tombstoned NOTHING (matched 0 rows, or S1 itself failed before
      // committing) — S2's failure leaves the pre-existing state untouched.
      if (
        constraint === DOCUMENT_ACTIVE_UNIQUE ||
        constraint === DOCUMENT_VERSION_UNIQUE
      ) {
        // Concurrent duplicate upload — S2 aborted atomically; a retry with
        // a freshly computed version is safe.
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

    // S1 COMMITTED (≥1 row tombstoned) and S2 failed: the previous version is
    // permanently deactivated while the replacement was NOT written. This is
    // never surfaced as a successful upload — distinct recovery outcome, with
    // the constraint name (if any) logged server-side only.
    console.error(
      `[document-service] Replacement incomplete: previous version ` +
        `${replacedVersionId} was deactivated but the new insert failed ` +
        `(constraint=${constraint ?? "none"}, shipmentId=${shipmentId}, ` +
        `documentType=${documentType}, version=${version}) — the type has ` +
        `no active document until the next successful upload.`,
    );
    logOrphanedAsset(shipmentId, documentType, version, assetKey, checksumSha256);
    return { status: "replacement_incomplete", replacedVersionId };
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

// ---------------------------------------------------------------------------
// Read-only listing (shipment detail page)
// ---------------------------------------------------------------------------

/** All document types, in pgEnum declaration order (the validation module's
 * DOCUMENT_TYPES allow-list mirrors this — keep them aligned). */
const DOCUMENT_TYPE_ORDER = documentType.enumValues;

export type DocumentEntryType = (typeof documentType.enumValues)[number];

/**
 * One document version as shown on the detail page — metadata ONLY.
 * Deliberately excludes `storageKey`, `checksumSha256` and anything provider
 * related; those are server-side facts and never leave the server.
 */
export interface ShipmentDocumentEntry {
  id: string;
  documentType: DocumentEntryType;
  /** Sniffed MIME type stored at upload (always application/pdf today). */
  mimeType: string;
  /** Sanitized client-provided filename (provenance only). */
  originalFilename: string;
  sizeBytes: number;
  version: number;
  /** Active = the current version of its type; false = superseded history. */
  isActive: boolean;
  /** Set when superseded (never null on inactive rows — DB CHECK). */
  supersededAt: Date | null;
  /** Upload time (`documents.created_at`). */
  uploadedAt: Date;
  /** Uploader identity resolved from the auth user table (FK restrict). */
  uploadedBy: { id: string; name: string };
}

export type DocumentListResult =
  | { status: "success"; entries: ShipmentDocumentEntry[] }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * List every document version of a shipment, ordered by document type (pgEnum
 * declaration order) then descending version, so each type forms a newest-
 * first history block with its active version at the top.
 *
 * - Strict UUID validation first; malformed ids short-circuit to `not_found`
 *   without spending a DB round-trip (same pattern as `getShipmentById`).
 * - Shipment existence is verified in the same Promise.all: a missing or
 *   deleted shipment returns `not_found` rather than a silent empty list.
 * - The join to `user` cannot fan out (uploaded_by is a restrict FK to a
 *   unique primary key), so one row per document is guaranteed.
 * - No pagination: rows per shipment are bounded by the three required
 *   document types and their version counts.
 * - Reads are independent queries (neon-http; no transaction needed) and the
 *   service NEVER mutates anything. DB failures are logged server-side
 *   (shipment id only, no SQL/driver details) and reported as `unavailable`.
 */
export async function listDocumentsForShipment(
  shipmentId: unknown,
): Promise<DocumentListResult> {
  const id = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(id)) {
    return { status: "not_found" };
  }

  try {
    const [shipmentRows, rows] = await Promise.all([
      db
        .select({ id: shipments.id })
        .from(shipments)
        .where(eq(shipments.id, id))
        .limit(1),
      db
        .select({
          id: documents.id,
          documentType: documents.documentType,
          originalFilename: documents.originalFilename,
          mimeType: documents.mimeType,
          sizeBytes: documents.sizeBytes,
          version: documents.version,
          isActive: documents.isActive,
          supersededAt: documents.supersededAt,
          uploadedAt: documents.createdAt,
          uploaderId: user.id,
          uploaderName: user.name,
        })
        .from(documents)
        .innerJoin(user, eq(documents.uploadedBy, user.id))
        .where(eq(documents.shipmentId, id)),
    ]);

    if (!shipmentRows[0]) {
      return { status: "not_found" };
    }

    const entries = rows
      .map<ShipmentDocumentEntry>((row) => ({
        id: row.id,
        documentType: row.documentType,
        mimeType: row.mimeType,
        originalFilename: row.originalFilename,
        sizeBytes: row.sizeBytes,
        version: row.version,
        isActive: row.isActive,
        supersededAt: row.supersededAt,
        uploadedAt: row.uploadedAt,
        uploadedBy: { id: row.uploaderId, name: row.uploaderName },
      }))
      .sort((first, second) => {
        // Document types in schema-declared order, then version descending
        // (deterministic: versions are unique per shipment + type).
        const typeDelta =
          DOCUMENT_TYPE_ORDER.indexOf(first.documentType) -
          DOCUMENT_TYPE_ORDER.indexOf(second.documentType);
        if (typeDelta !== 0) return typeDelta;
        return second.version - first.version;
      });

    return { status: "success", entries };
  } catch {
    console.error(
      `[document-service] Failed to list documents (shipmentId=${id}).`,
    );
    return { status: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Extraction-scoped read (server-side ONLY)
// ---------------------------------------------------------------------------

/**
 * One active document resolved for extraction. Unlike `ShipmentDocumentEntry`
 * (the privacy-scoped detail-page listing), this intentionally includes the
 * opaque `storageKey` and `checksumSha256` — both are consumed server-side
 * only (storage `get` input, integrity verification). Neither this type's
 * instances nor any aggregate containing them may ever be serialized to a
 * client route/response.
 */
export interface ActiveExtractionDocument {
  id: string;
  shipmentId: string;
  documentType: DocumentEntryType;
  version: number;
  /** Opaque stored-asset key (e.g. `cloudinary:raw:{publicId}`) — never a URL. */
  storageKey: string;
  /** Hex-64 SHA-256 recorded at upload — re-verification at retrieval time. */
  checksumSha256: string;
  mimeType: string;
  sizeBytes: number;
}

export type ActiveExtractionDocumentsResult =
  | { status: "success"; documents: ActiveExtractionDocument[] }
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * The active document rows of a shipment in pgEnum type order — the full set
 * extraction operates on (exactly one active version per required type).
 * Deliberately NOT built on `listDocumentsForShipment`'s privacy-scoped
 * listing: this is a distinct server-side contract whose output is allowed to
 * carries storage references. Same failure taxonomy as `getShipmentById`:
 * strict UUID gate (`not_found` without a DB round-trip), shipment existence
 * verified in the same Promise.all, DB failures logged with the shipment id
 * only and reported as `unavailable`. Read-only; no mutations.
 */
export async function getActiveDocumentsForExtraction(
  shipmentId: unknown,
): Promise<ActiveExtractionDocumentsResult> {
  const id = typeof shipmentId === "string" ? shipmentId.trim() : "";
  if (!UUID_PATTERN.test(id)) {
    return { status: "not_found" };
  }

  try {
    const [shipmentRows, rows] = await Promise.all([
      db
        .select({ id: shipments.id })
        .from(shipments)
        .where(eq(shipments.id, id))
        .limit(1),
      db
        .select({
          id: documents.id,
          shipmentId: documents.shipmentId,
          documentType: documents.documentType,
          version: documents.version,
          storageKey: documents.storageKey,
          checksumSha256: documents.checksumSha256,
          mimeType: documents.mimeType,
          sizeBytes: documents.sizeBytes,
        })
        .from(documents)
        .where(and(eq(documents.shipmentId, id), eq(documents.isActive, true))),
    ]);

    if (!shipmentRows[0]) {
      return { status: "not_found" };
    }

    return { status: "success", documents: rows };
  } catch {
    console.error(
      `[document-service] Failed to load active documents for extraction (shipmentId=${id}).`,
    );
    return { status: "unavailable" };
  }
}
