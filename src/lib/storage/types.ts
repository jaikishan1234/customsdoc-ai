/**
 * Provider-agnostic object storage interface for shipment documents.
 *
 * Providers (Cloudinary today; R2/Supabase later) implement this surface.
 * Keys handed to implementations are ALWAYS server-generated (validated uuid
 * paths, never client input) — implementations may additionally enforce their
 * own key-shape validation as defense-in-depth.
 *
 * The returned `key` is the opaque asset reference persisted as the documents
 * table's `storageKey` (schema: src/lib/db/schema/documents.ts) — it is never
 * a public or CDN URL.
 */

/** Metadata accompanying a binary upload. Server-validated before calling. */
export interface PutObjectRequest {
  /**
   * Canonical, server-generated storage-key path, e.g.
   * `shipments/{shipmentId}/{documentType}/v{version}/{uuid}`.
   * Providers may map this internally (e.g. Cloudinary public_id).
   */
  key: string;
  /** Policy-validated document bytes (e.g. magic-byte-checked PDF). */
  data: Uint8Array;
  /** MIME type validated by the caller; retained authoritatively in the DB. */
  contentType: string;
}

/** Result of a successful put, including the opaque asset key for the DB. */
export interface PutObjectResult {
  /**
   * Opaque stored-asset key bound to the documents row's `storageKey`.
   * Provider-scoped (e.g. `cloudinary:raw:{public_id}`); NOT a URL.
   */
  key: string;
  /** Authoritative stored size in bytes (from the provider when available). */
  sizeBytes: number;
}

/**
 * Minimal storage surface for the first milestone (uploads only). Reads,
 * deletion and signed/private-download access extend this interface in later
 * steps and never widen it to expose public delivery URLs.
 */
export interface ObjectStorage {
  put(request: PutObjectRequest): Promise<PutObjectResult>;
}
