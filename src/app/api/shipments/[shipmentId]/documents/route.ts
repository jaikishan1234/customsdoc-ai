/**
 * POST /api/shipments/[shipmentId]/documents — document upload Route Handler.
 *
 * Thin, client-safe boundary over `uploadDocument()` (src/lib/services):
 * it does NOT duplicate any validation, checksum, storage or database logic;
 * it only parses the multipart frame and maps the service's typed results to
 * HTTP statuses.
 *
 * Runtime: this deployment enables `cacheComponents`, which uses the Node.js
 * runtime by default and disallows the `runtime` segment export — so no
 * `export const runtime` is present (an `edge` handler is impossible here).
 * `crypto`, `Blob` and streams used below are all Node-provided.
 *
 * Request-size enforcement (defense in depth — Content-Length alone is NOT
 * trusted, since it can be omitted or lie):
 *   1. Content-Length header pre-screen: an over-cap declared body is
 *      rejected with 413 BEFORE a single byte is read.
 *   2. The body is then streamed and accumulated with a HARD byte cap
 *      regardless of what the headers claimed — the moment the cap would be
 *      exceeded, reading stops (stream cancelled) and 413 is returned. The
 *      process never buffers an unbounded body.
 *   3. Only a body that passed the cap is handed to multipart parsing, so
 *      the parse itself is bounded.
 * The cap = DOCUMENT_MAX_SIZE_BYTES (25 MiB, the per-file limit enforced on
 * actual file bytes by the validation module/service) + 1 MiB slack for the
 * multipart framing (boundaries, part headers, text fields). Anything larger
 * cannot contain a valid upload, whatever number Content-Length declared.
 *
 * Status mapping (client-safe JSON only; storage keys, credentials, raw DB
 * errors and provider details never leave the server — internal failures are
 * logged server-side only):
 *   201 uploaded (incl. partial-success cases, with a non-sensitive warning)
 *   400 malformed multipart / missing fields / wrong field counts / non-PDF
 *   401 unauthenticated
 *   403 role not permitted
 *   404 shipment not found (including non-UUID shipment ids)
 *   409 duplicate checksum | concurrent upload conflict | EXPORTED shipment
 *   413 request or file over the size cap
 *   500 unexpected server failure (incl. replacement_incomplete — the client
 *       is asked to re-upload; the service never reports that state as a
 *       successful upload)
 *   502 storage provider unavailable
 */

import { USER_ROLES } from "@/lib/auth";
import { getSession, hasRole } from "@/lib/server/auth";
import { uploadDocument } from "@/lib/services/document-service";
import { DOCUMENT_MAX_SIZE_BYTES } from "@/lib/validation/document";

/** Multipart framing slack on top of the per-file limit (see header). */
const MULTIPART_FRAMING_SLACK_BYTES = 1024 * 1024;

/** Hard request-body cap: 25 MiB file limit + multipart framing overhead. */
const REQUEST_BODY_MAX_BYTES =
  DOCUMENT_MAX_SIZE_BYTES + MULTIPART_FRAMING_SLACK_BYTES;

const UPLOAD_ROLES = [
  USER_ROLES.DOCUMENTATION_EXECUTIVE,
  USER_ROLES.DOCUMENTATION_MANAGER,
] as const;

/** Uniform client-safe JSON error responses. */
const jsonError = (status: number, error: string): Response =>
  Response.json({ error }, { status });

/** Structural File detection (independent of runtime globals/versions). */
const isFileLike = (value: FormDataEntryValue): value is File =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof (value as File).name === "string" &&
  typeof (value as File).arrayBuffer === "function" &&
  typeof (value as File).size === "number";

/**
 * Stream-read the request body with an absolute byte cap. Returns
 * `{ ok: false }` when the body exceeds the cap (reading stops immediately
 * — nothing beyond the cap is ever buffered) and `{ ok: true, data }` with
 * the complete body otherwise. Content-Length is deliberately not used here;
 * this works identically with or without it.
 */
async function readCappedBody(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ ok: true; data: Uint8Array<ArrayBuffer> } | { ok: false }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > cap) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Allocated here with an exact byte count — the buffer is a plain
  // ArrayBuffer (no SharedArrayBuffer path is possible in this runtime).
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, data };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ shipmentId: string }> },
): Promise<Response> {
  // --- 1. Server-side session & role (explicit 40x; no redirects) ----------
  const session = await getSession();
  if (!session) {
    return jsonError(401, "You must be signed in to upload documents.");
  }
  if (!hasRole(session, UPLOAD_ROLES)) {
    return jsonError(
      403,
      "You do not have permission to upload documents to this shipment.",
    );
  }

  // --- 2. Request framing --------------------------------------------------
  // Only multipart can carry a file + document type; anything else is a
  // client framing error (rejected before any body is read).
  const contentType = request.headers.get("content-type");
  if (!contentType || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    return jsonError(400, "The document must be sent as multipart form data.");
  }
  if (!request.body) {
    return jsonError(400, "No form data was received.");
  }

  // Pre-screen: an over-cap declared body is rejected before reading bytes.
  const contentLengthRaw = request.headers.get("content-length");
  if (contentLengthRaw) {
    const length = Number(contentLengthRaw);
    if (Number.isFinite(length) && length > REQUEST_BODY_MAX_BYTES) {
      return jsonError(
        413,
        "The upload is too large. Files must be 25 MB or smaller.",
      );
    }
  }

  // --- 3. Capped body read (authoritative size enforcement) ----------------
  const body = await readCappedBody(request.body, REQUEST_BODY_MAX_BYTES);
  if (!body.ok) {
    // Stream already cancelled inside readCappedBody — free the leftovers.
    return jsonError(
      413,
      "The upload is too large. Files must be 25 MB or smaller.",
    );
  }
  if (body.data.byteLength === 0) {
    return jsonError(400, "No form data was received.");
  }

  // --- 4. Bounded multipart parse ------------------------------------------
  // The body is guaranteed <= the cap, so formData() parses at most that
  // much. A malformed frame (bad boundary, truncated part) fails here with
  // a client-safe 400.
  let formData: FormData;
  try {
    const reparsed = new Request("http://localhost/documents/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Blob([body.data]),
    });
    formData = await reparsed.formData();
  } catch (error) {
    console.error(
      "[document-upload-route] Multipart parse failed " +
        `(length=${body.data.byteLength}):`,
      error instanceof Error ? error.name : "unknown error type",
    );
    return jsonError(400, "The form data is malformed. Please try again.");
  }

  // --- 5. Field extraction: exactly one file + one document type -----------
  let file: File | null = null;
  let fileCount = 0;
  let documentType: FormDataEntryValue | null = null;
  let documentTypeCount = 0;
  for (const [key, value] of formData.entries()) {
    if (isFileLike(value)) {
      fileCount += 1;
      if (fileCount === 1) {
        file = value;
      }
    } else if (key === "documentType") {
      documentTypeCount += 1;
      if (documentTypeCount === 1) {
        documentType = value;
      }
    }
  }

  if (fileCount === 0) {
    return jsonError(400, "Attach one PDF document to upload.");
  }
  if (fileCount > 1) {
    return jsonError(400, "Upload one document at a time.");
  }
  if (documentTypeCount > 1) {
    return jsonError(400, "Choose exactly one document type.");
  }
  if (typeof documentType !== "string" || !file) {
    return jsonError(400, "Choose a document type for the upload.");
  }

  const { shipmentId } = await params;

  // --- 6. Delegate ALL validation/persistence to the service ---------------
  // Note: out-of-policy PDFs and invalid document type values surface via the
  // service's `invalid_input` result (mapped below). While a file is open
  // here, its bytes stay within the capped buffer — no unbounded copies.
  const fileBuffer = await file.arrayBuffer();
  try {
    const result = await uploadDocument({
      shipmentId,
      documentType,
      filename: file.name,
      data: new Uint8Array(fileBuffer),
    });

    switch (result.status) {
      case "uploaded":
        return Response.json(
          {
            status: "uploaded",
            documentId: result.document.id,
            auditMissing: false,
            warnings: [],
          },
          { status: 201 },
        );
      case "uploaded_audit_failed":
        return Response.json(
          {
            status: "uploaded",
            documentId: result.document.id,
            auditMissing: true,
            warnings: [
              "The document was saved, but its audit entry could not be written and needs backfilling.",
            ],
            warning:
              "The document was saved, but its audit entry needs backfilling.",
          },
          { status: 201 },
        );
      case "replacement_incomplete": {
        // The previous version was deactivated but the replacement insert
        // failed — this shipment's document type temporarily has NO active
        // document. The upload did not happen; a fresh upload recovers it
        // (the service tolerates a type with zero active rows). Internal
        // details stay server-side.
        console.error(
          `[document-upload-route] Replacement incomplete for shipment ` +
            `${shipmentId} — client asked to re-upload.`,
        );
        return jsonError(
          500,
          "The document could not be saved. Please try uploading it again.",
        );
      }
      case "invalid_input":
        // Size errors are a request-content problem → 413; all remaining
        // field messages (document type / MIME / filename) are 400s. The
        // messages come from the validation module's client-safe copy.
        return jsonError(
          result.error.field === "size" ? 413 : 400,
          result.error.message,
        );
      case "duplicate_checksum":
        return jsonError(
          409,
          "An identical document of this type is already active for this shipment.",
        );
      case "upload_conflict":
        return jsonError(
          409,
          "Another upload for this document type is in progress. Please retry in a moment.",
        );
      case "shipment_exported":
        return jsonError(
          409,
          "This shipment has been exported; documents can no longer be uploaded.",
        );
      case "shipment_not_found":
        return jsonError(404, "Shipment not found.");
      case "storage_error":
        console.error(
          `[document-upload-route] Storage failed for shipment ${shipmentId}.`,
        );
        return jsonError(
          502,
          "Document storage is temporarily unavailable. Please try again.",
        );
      case "unexpected_error":
        console.error(
          `[document-upload-route] Unexpected service failure for shipment ${shipmentId}.`,
        );
        return jsonError(
          500,
          "Something went wrong while saving the document. Please try again.",
        );
      case "unauthenticated":
        // Session ended mid-request — treat exactly like the entry check.
        return jsonError(401, "You must be signed in to upload documents.");
      case "forbidden":
        return jsonError(
          403,
          "You do not have permission to upload documents to this shipment.",
        );
    }
  } catch (error) {
    // The service is typed not to throw, but a defensive boundary keeps any
    // unexpected runtime failure from leaking internals to the client.
    console.error(
      "[document-upload-route] Unhandled failure while processing upload:",
      error instanceof Error ? error.name : "unknown error type",
    );
    return jsonError(
      500,
      "Something went wrong while saving the document. Please try again.",
    );
  }
}
