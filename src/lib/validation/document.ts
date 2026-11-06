/**
 * Shipment document validation (PDF uploads).
 *
 * Pure, dependency-free validators — no Zod, no SDK imports, safe to use on
 * the server (Route Handlers / services). The browser's declared MIME type
 * and file size are NEVER trusted:
 * - size is taken from the actual received bytes (byteLength),
 * - MIME is derived from PDF magic-byte sniffing.
 *
 * Constants mirror the upload policy approved for this milestone
 * (application/pdf only, 25 MB cap) — the documents DB schema itself imposes
 * `sizeBytes > 0` and the hex-64 SHA-256 shape (checked by the service).
 */

/** Declared MIME type for all shipment documents (allow-list of one). */
export const DOCUMENT_MIME_TYPE = "application/pdf";

/** Hard upload ceiling: 25 MiB (26,214,400 bytes), checked against the
 * ACTUAL byte count — request-level Content-Length is only a pre-screen. */
export const DOCUMENT_MAX_SIZE_BYTES = 25 * 1024 * 1024;

/** Document types accepted by the upload API (mirrors the `document_type`
 * pgEnum; defined locally so this module stays schema-agnostic). */
export const DOCUMENT_TYPES = [
  "INVOICE",
  "PACKING_LIST",
  "BILL_OF_LADING",
] as const;

export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];

export interface DocumentTypeError {
  field: "documentType";
  message: string;
}

/** Validate a client-supplied document type (e.g. FormData value). */
export function validateDocumentTypeInput(
  raw: unknown,
): DocumentTypeValue | DocumentTypeError {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if ((DOCUMENT_TYPES as readonly string[]).includes(value)) {
    return value as DocumentTypeValue;
  }
  return {
    field: "documentType",
    message:
      "Choose a valid document type: INVOICE, PACKING_LIST or BILL_OF_LADING.",
  };
}

export interface ValidatedDocument {
  /** Sniffed-from-bytes MIME type (only ever DOCUMENT_MIME_TYPE here). */
  mimeType: typeof DOCUMENT_MIME_TYPE;
  /** Sanitized original filename (provenance only; never used in keys). */
  filename: string;
  /** Zero-copy reference to the exact received bytes. */
  data: Uint8Array;
}

export type DocumentValidationError = {
  field: "size" | "mimeType" | "filename";
  message: string;
};

export type PdfValidationResult =
  | { success: true; document: ValidatedDocument }
  | { success: false; error: DocumentValidationError };

/** `%PDF-` as bytes (0x25 0x50 0x44 0x46 0x2D). */
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** Per ISO 32000, junk may precede the header in PDF ≥1.5 — scan the first
 * 1 KiB before declaring an invalid signature. Bounded scan; no unbounded
 * reads. */
const PDF_HEADER_SCAN_BYTES = 1024;

function hasPdfMagicBytes(data: Uint8Array): boolean {
  if (data.length < PDF_HEADER.length) return false;
  const scanEnd = Math.min(data.length, PDF_HEADER_SCAN_BYTES);
  const lastStart = scanEnd - PDF_HEADER.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < PDF_HEADER.length; offset += 1) {
      if (data[start + offset] !== PDF_HEADER[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Sanitize the client-supplied filename: trim, strip any path components
 * (Windows/Unix separators), remove control characters, and cap the length.
 * The result is provenance metadata only — storage keys are server-generated.
 */
export function sanitizeDocumentFilename(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("-") // rejoined path segments become part of the name, never a path
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 255)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Validate an uploaded document:
 * - actual byte count within (0, DOCUMENT_MAX_SIZE_BYTES];
 * - PDF magic bytes within the first KiB (sniffed type stored in the DB);
 * - sanitized, present original filename.
 *
 * The `data` reference returned is the same buffer instance passed in — no
 * copies, no conversions; checksums (SHA-256) are computed by the service.
 */
export function validatePdfDocument(input: {
  filename: unknown;
  data: Uint8Array | null | undefined;
}): PdfValidationResult {
  // Size — measured on real bytes, before any parsing or hashing.
  if (!input.data || !(input.data instanceof Uint8Array)) {
    return {
      success: false,
      error: {
        field: "size",
        message: "No document data was received. Please try again.",
      },
    };
  }
  const { data } = input;
  if (data.byteLength === 0) {
    return {
      success: false,
      error: {
        field: "size",
        message: "The selected file is empty.",
      },
    };
  }
  if (data.byteLength > DOCUMENT_MAX_SIZE_BYTES) {
    return {
      success: false,
      error: {
        field: "size",
        message: `Files must be 25 MB or smaller (received more than ${DOCUMENT_MAX_SIZE_BYTES} bytes).`,
      },
    };
  }

  // Signature — sniffed from bytes, not the browser's declared type.
  if (!hasPdfMagicBytes(data)) {
    return {
      success: false,
      error: {
        field: "mimeType",
        message: "This file is not a valid PDF document.",
      },
    };
  }

  // Filename — sanitized provenance, never a storage key or path.
  const filename = sanitizeDocumentFilename(input.filename);
  if (filename === null) {
    return {
      success: false,
      error: {
        field: "filename",
        message: "Provide the document as a named file.",
      },
    };
  }

  return {
    success: true,
    document: {
      mimeType: DOCUMENT_MIME_TYPE,
      filename,
      data,
    },
  };
}
