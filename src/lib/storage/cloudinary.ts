import "server-only";

/**
 * Server-only Cloudinary storage adapter (Cloudinary Free, private raw PDFs).
 *
 * Security model:
 * - Credentials come exclusively from server-side environment variables,
 *   validated once at module load with the same fail-fast pattern as
 *   src/lib/auth.ts. Failures are descriptive but NEVER echo the secret
 *   values; nothing is logged that could expose them.
 * - No NEXT_PUBLIC variables — this module must never be imported in client
 *   bundles (the "server-only" import buys that at bundle time).
 * - Assets are uploaded as `resource_type: "raw"` PRIVATE PDFs: both
 *   `access_mode: "authenticated"` and `type: "authenticated"` are set
 *   explicitly because access_mode alone is NOT a guarantee of private
 *   delivery (raw/PDF CDN delivery can differ per account config). Delivery
 *   decisions happen in the download step, always through server-side signed
 *   access — no public or persisted URLs, ever.
 * - Object keys are provided by the caller (server-generated); as
 *   defense-in-depth the adapter re-validates the key shape and rejects
 *   anything that could smuggle traversal or provider-specific metadata.
 */

import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

import type {
  ObjectStorage,
  PutObjectRequest,
  PutObjectResult,
} from "./types";

// ---------------------------------------------------------------------------
// Fail-fast environment validation (never logs or exposes secret values).
// ---------------------------------------------------------------------------

interface CloudinaryEnvironment {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

const readEnv = (name: string): string | null => {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value;
};

const validateCloudinaryEnvironment = (): CloudinaryEnvironment => {
  const cloudName = readEnv("CLOUDINARY_CLOUD_NAME");
  if (cloudName === null) {
    throw new Error(
      "CLOUDINARY_CLOUD_NAME is not set. Configure the Cloudinary cloud name " +
        "in .env.local or the runtime environment.",
    );
  }

  const apiKey = readEnv("CLOUDINARY_API_KEY");
  if (apiKey === null) {
    throw new Error(
      "CLOUDINARY_API_KEY is not set. Configure the Cloudinary API key in " +
        ".env.local or the runtime environment.",
    );
  }

  const apiSecret = readEnv("CLOUDINARY_API_SECRET");
  if (apiSecret === null) {
    throw new Error(
      "CLOUDINARY_API_SECRET is not set. Configure a valid secret (never " +
        "exposed to the client) in .env.local or the runtime environment.",
    );
  }

  return { cloudName, apiKey, apiSecret };
};

const cloudinaryEnv = validateCloudinaryEnvironment();

// Configure the official SDK once, server-side, over HTTPS.
cloudinary.config({
  cloud_name: cloudinaryEnv.cloudName,
  api_key: cloudinaryEnv.apiKey,
  api_secret: cloudinaryEnv.apiSecret,
  secure: true,
});

// ---------------------------------------------------------------------------
// Upload adapter
// ---------------------------------------------------------------------------

/**
 * Allowed canonical storage-key shape: the server generates keys as
 * `shipments/{uuid}/{documentType}/v{version}/{uuid}`. This re-validation is
 * defense-in-depth against traversal characters and URL injection — the value
 * maps to a Cloudinary public_id internally.
 */
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

const isSafeStorageKey = (key: string): boolean =>
  STORAGE_KEY_PATTERN.test(key) && !key.includes("..") && key.length < 512;

/** Prefix marking an asset key as a Cloudinary raw resource (stored in DB). */
const CLOUDINARY_RAW_KEY_SCHEME = "cloudinary:raw:";

const uploadPdf = (
  request: PutObjectRequest,
): Promise<UploadApiResponse> =>
  new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        // Private raw PDF: both knobs explicitly set — see module docs.
        resource_type: "raw",
        access_mode: "authenticated",
        type: "authenticated",
        // The caller's key is the full public_id — no folder composition,
        // no filename-derived ids, no overwrites (each version uploads anew).
        public_id: request.key,
        overwrite: false,
        unique_filename: false,
        use_filename: false,
        discard_original_filename: true,
        tags: ["customsdoc", "pdf", "private"],
      },
      (error, result) => {
        if (error || !result) {
          // Log only non-sensitive fields (name/status) — never API details.
          const code = (error as { http_code?: number })?.http_code;
          console.error(
            `[cloudinary-storage] Raw PDF upload failed (status=${code ?? "unknown"}).`,
          );
          reject(
            error instanceof Error
              ? error
              : new Error("Cloudinary upload failed without a response."),
          );
          return;
        }
        resolve(result);
      },
    );
    // Writes the policy-validated bytes; no base64 copy of the payload.
    stream.end(request.data);
  });

const cloudinaryStorage: ObjectStorage = {
  async put(request: PutObjectRequest): Promise<PutObjectResult> {
    if (!isSafeStorageKey(request.key)) {
      throw new Error("Storage key violates the required server-side format.");
    }
    if (request.data.byteLength === 0) {
      throw new Error("Upload payload is empty.");
    }
    // contentType is validated by the caller (MIME allow-list + magic bytes)
    // and is stored authoritatively in Neon; Cloudinary keeps the original
    // format for raw resources, so it is NOT forwarded to the provider.

    const response = await uploadPdf(request);

    // Authoritative size comes from the provider response when present,
    // falling back to the payload length (identical for raw uploads).
    return {
      key: `${CLOUDINARY_RAW_KEY_SCHEME}${response.public_id}`,
      sizeBytes:
        typeof response.bytes === "number" && response.bytes > 0
          ? response.bytes
          : request.data.byteLength,
    };
  },
};

export { cloudinaryStorage, isSafeStorageKey, CLOUDINARY_RAW_KEY_SCHEME };
