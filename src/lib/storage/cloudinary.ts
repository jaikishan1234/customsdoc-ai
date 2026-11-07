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
 * - Retrieval (`get`) is strictly server-side: authenticated raw assets are
 *   read through signed Admin-API requests; no URL is ever returned, exposed
 *   to the browser or logged, and no asset is ever made public.
 */

import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

import { DOCUMENT_MAX_SIZE_BYTES } from "@/lib/validation/document";
import type {
  GetObjectRequest,
  ObjectStorage,
  PutObjectRequest,
  PutObjectResult,
  StorageGetResult,
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

  // ---------------------------------------------------------------------------
  // Server-side retrieval (authenticated raw assets) — see StorageGetResult.
  // ---------------------------------------------------------------------------

  async get(request: GetObjectRequest): Promise<StorageGetResult> {
    // The persisted key carries the provider prefix; only that exact scheme
    // is accepted. The remainder must re-pass the same key-shape validation
    // used at upload (defense-in-depth, same server-generated format).
    if (
      typeof request?.key !== "string" ||
      !request.key.startsWith(CLOUDINARY_RAW_KEY_SCHEME)
    ) {
      return { status: "invalid_key" };
    }
    const publicId = request.key.slice(CLOUDINARY_RAW_KEY_SCHEME.length);
    if (!isSafeStorageKey(publicId)) {
      return { status: "invalid_key" };
    }

    // Signed Admin-API download endpoint (api.cloudinary.com), bearing the
    // same api_secret-derived signature as every other Admin call. This is
    // the SDK's supported mechanism for private/authenticated assets and is
    // NOT CDN delivery — it works even where the account's PDF CDN flag is
    // off (Free plan). The URL is consumed by the fetch below and is never
    // returned to callers or logged; the result carries BYTES only.
    let downloadUrl: string;
    try {
      downloadUrl = cloudinary.utils.private_download_url(publicId, "pdf", {
        resource_type: "raw",
        type: "authenticated",
      });
    } catch (error) {
      console.error(
        "[cloudinary-storage] Retrieval URL construction failed:",
        error instanceof Error ? error.name : "unknown error type",
      );
      return { status: "unavailable" };
    }

    let response: Response;
    try {
      response = await fetch(downloadUrl, {
        headers: { accept: "application/pdf" },
        redirect: "follow",
      });
    } catch (error) {
      console.error(
        "[cloudinary-storage] Retrieval fetch failed:",
        error instanceof Error ? error.name : "unknown error type",
      );
      return { status: "unavailable" };
    }

    // Missing asset = durable business state (e.g. reconciled orphans);
    // anything else non-2xx is provider trouble. Only the status code is
    // logged — never the URL, query signature or response body.
    if (response.status === 404) {
      return { status: "not_found" };
    }
    if (!response.ok) {
      console.error(
        `[cloudinary-storage] Retrieval unavailable (status=${response.status}).`,
      );
      return { status: "unavailable" };
    }

    // Size is fully bounded: a Content-Length pre-screen rejects deliberate
    // over-cap declarations without reading, and the capped stream read is
    // authoritative (mirrors the handler's uploader-side discipline; stored
    // assets can never exceed this cap, so overshoot means tampering).
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > DOCUMENT_MAX_SIZE_BYTES
    ) {
      console.error(
        `[cloudinary-storage] Retrieval over declared size cap (declared=${declaredLength}).`,
      );
      return { status: "unavailable" };
    }

    const body = await readCappedResponse(response.body, DOCUMENT_MAX_SIZE_BYTES);
    if (!body.ok) {
      console.error(
        "[cloudinary-storage] Retrieval exceeded the streaming size cap.",
      );
      return { status: "unavailable" };
    }
    if (body.data.byteLength === 0) {
      console.error("[cloudinary-storage] Retrieved zero bytes for the asset.");
      return { status: "unavailable" };
    }

    return {
      status: "found",
      data: body.data,
      // Informational only — documents.mime_type stays authoritative.
      contentType: response.headers.get("content-type"),
      sizeBytes: body.data.byteLength,
    };
  },
};

/** Renders the capped read independent of how the body stream is obtained. */
type CappableStream = ReadableStream<Uint8Array> | null;

const readCappedResponse = async (
  stream: CappableStream,
  cap: number,
): Promise<{ ok: true; data: Uint8Array<ArrayBuffer> } | { ok: false }> => {
  if (!stream) {
    return { ok: false };
  }
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
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, data };
};

export { cloudinaryStorage, isSafeStorageKey, CLOUDINARY_RAW_KEY_SCHEME };
