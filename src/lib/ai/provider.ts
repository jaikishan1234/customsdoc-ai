import "server-only";

/**
 * Server-only Gemini adapter for structured document extraction, using the
 * Files API for the PDF and the Interactions API for generation (plain fetch —
 * no SDK, no new dependencies).
 *
 * Flow (three provider calls per extraction, one cleanup):
 *   1. POST /upload/v1beta/files            — resumable upload initiation
 *   2. POST <X-Goog-Upload-URL>             — upload bytes + finalize
 *      (plus bounded GET /v1beta/files/{id} polling while state != ACTIVE)
 *   3. POST /v1beta/interactions            — generate from the file URI
 *   4. DELETE /v1beta/{name}                — best-effort cleanup in finally
 *
 * Why uploads instead of inline base64: the previous inline path shared ONE
 * 60s deadline across base64 transfer and model generation, so a slow upload
 * consumed the generation budget. Each phase now has its own budget and a
 * size-aware upload ceiling.
 *
 * Security posture:
 * - Credentials come exclusively from the server-side environment
 *   (`GEMINI_API_KEY`), validated once at module load with the same fail-fast
 *   pattern as the Cloudinary adapter. Failures name the missing variable but
 *   never echo secret values.
 * - `store: false` on EVERY interaction: no Google-side interaction retention.
 *   The uploaded FILE is separate: the Files API keeps it up to 48 hours, so
 *   it is deleted in a `finally` after the generation response is consumed,
 *   and the 48-hour expiry is the fallback if cleanup cannot run (process
 *   kill / network loss). This hygiene is NOT a substitute for the
 *   synthetic-data-only policy: real customs documents must never reach this
 *   adapter, full stop.
 * - File names and URIs are transient provider artifacts: never logged,
 *   never returned to the service, never persisted. The result carries parsed
 *   model output only.
 * - NOTHING about request/response content is ever logged: no document bytes,
 *   no base64, no prompt text, no schema, no key material, no raw provider
 *   responses. Logs carry phase, elapsed ms, HTTP status, error category and
 *   byte counts only.
 * - The uploaded file's display name is a FIXED generic label — never the
 *   original filename (which can contain party names).
 * - This is the single place where provider nouns appear (endpoints, model id,
 *   upload headers, `x-goog-api-key`, `Api-Revision`, `response_format`).
 *   Service code works only in terms of catalogs, schemas and typed results.
 * - Model confidence is an UNTRUSTED estimate: callers must run the result
 *   through ./response-validation.ts against the generating catalog before
 *   persisting anything.
 * - An instance-local daily slot is reserved before every attempt (see
 *   ./request-ceiling.ts; best-effort per instance, not a global quota).
 *
 * Wire contract (verified against ai.google.dev):
 *   - Files upload: `x-goog-api-key`, `X-Goog-Upload-Protocol: resumable`,
 *     `X-Goog-Upload-Command: start`, `X-Goog-Upload-Header-Content-Length`,
 *     `X-Goog-Upload-Header-Content-Type`; the reply exposes the resumable
 *     `X-Goog-Upload-URL` header; the second request sends the raw bytes with
 *     `X-Goog-Upload-Offset: 0` and `X-Goog-Upload-Command: upload, finalize`.
 *   - Interactions: `Api-Revision: 2026-05-20`, input =
 *     [{ type: "document", uri, mime_type }, { type: "text", text: prompt }],
 *     response_format = { type: "text", mime_type: "application/json", schema }.
 *   - Files API limits: 2 GB per file / 20 GB per project / 48h retention.
 *     Our uploads are capped by the application at 25 MiB.
 */

import { DOCUMENT_MAX_SIZE_BYTES } from "@/lib/validation/document";

import { reserveExtractionRequestSlot } from "./request-ceiling";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_INTERACTIONS_ENDPOINT = `${GEMINI_API_BASE}/interactions`;
const GEMINI_FILES_UPLOAD_ENDPOINT =
  "https://generativelanguage.googleapis.com/upload/v1beta/files";

/** Pinned API revision header required by the Interactions REST surface. */
const GEMINI_API_REVISION = "2026-05-20";

/** Current stable Flash model with PDF input + structured outputs. */
export const GEMINI_EXTRACTION_MODEL = "gemini-3.8-flash";

/** Only PDFs are accepted by the upload policy (see validation/document.ts). */
const GEMINI_PDF_MIME_TYPE = "application/pdf";

/**
 * Fixed, non-identifying display name sent with every upload. Never the
 * original filename: it is metadata we would rather not share with Google.
 */
const GEMINI_FILE_DISPLAY_NAME = "customsdoc-extraction";

/** Phase budgets — deliberately independent of each other. */
const GEMINI_UPLOAD_START_TIMEOUT_MS = 15_000;
const GEMINI_UPLOAD_MIN_TIMEOUT_MS = 60_000;
const GEMINI_UPLOAD_MAX_TIMEOUT_MS = 180_000;
/** Size-aware allowance: base + per-MiB, clamped to [min, max]. */
const GEMINI_UPLOAD_BASE_TIMEOUT_MS = 30_000;
const GEMINI_UPLOAD_MS_PER_MIB = 4_000;
/** Generation budget (unchanged; measured before any adjustment). */
const GEMINI_GENERATION_TIMEOUT_MS = 60_000;
/** Cleanup must never hold up the caller for long. */
const GEMINI_CLEANUP_TIMEOUT_MS = 10_000;

/** Bounded readiness polling for a just-uploaded file. */
const GEMINI_FILE_ACTIVE_POLL_ATTEMPTS = 10;
const GEMINI_FILE_ACTIVE_POLL_INTERVAL_MS = 1_000;
const GEMINI_FILE_ACTIVE_POLL_TIMEOUT_MS = 10_000;

/** Generous response cap (chars) — responses carry no echoed document; 8 MiB of
 * text is far above any legitimate structured extraction output. */
const GEMINI_MAX_RESPONSE_CHARS = 8 * 1024 * 1024;

/** Hard cap for the extracted-JSON text before parsing (defense-in-depth). */
const GEMINI_MAX_OUTPUT_JSON_CHARS = 1_000_000;

/** File metadata is tiny; cap it far below the interaction response cap. */
const GEMINI_MAX_FILE_METADATA_CHARS = 64 * 1024;

/** Provider-side file identifier shape (`files/{id}`) — validated before use
 * in any follow-up URL, since the value comes back from the provider. */
const GEMINI_FILE_NAME_PATTERN = /^files\/[A-Za-z0-9-]{1,64}$/;

// ---------------------------------------------------------------------------
// Fail-fast environment validation (never logs or exposes secret values).
// ---------------------------------------------------------------------------

const readEnv = (name: string): string | null => {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value;
};

const validateGeminiEnvironment = (): { apiKey: string } => {
  const apiKey = readEnv("GEMINI_API_KEY");
  if (apiKey === null) {
    throw new Error(
      "GEMINI_API_KEY is not set. Configure a free-tier Gemini API key " +
        "(Google AI Studio, restricted to the Gemini API) in .env.local or " +
        "the runtime environment. Server-side only — never NEXT_PUBLIC.",
    );
  }
  return { apiKey };
};

const geminiEnv = validateGeminiEnvironment();

// ---------------------------------------------------------------------------
// Typed contract (UNCHANGED — the service still passes bytes)
// ---------------------------------------------------------------------------

export interface StructuredExtractionRequest {
  /**
   * Fully-formed extraction prompt for the document type (built by the
   * service layer). The document's ONLY channel to the model is the uploaded
   * PDF file below — never embed document text here.
   */
  prompt: string;
  /** JSON Schema from `buildExtractionResponseSchema` (same catalog). */
  schema: Record<string, unknown>;
  /** Validated original PDF bytes (upload-policy capped; re-checked here). */
  document: Uint8Array;
}

export type GeminiStructuredResult =
  | { status: "success"; data: unknown }
  /** 2xx but output missing/unreadable — provider contract drift. */
  | { status: "invalid_response" }
  /** Non-429 4xx: malformed request/schema or key/config problems. */
  | { status: "rejected" }
  /** Provider 429 — their quota; mapped to durable business state. */
  | { status: "rate_limited" }
  /** Instance-local daily ceiling exhausted before any wire call. */
  | { status: "daily_ceiling_reached" }
  /** Network failure, timeout, 5xx, oversized/unreadable responses. */
  | { status: "unavailable" };

/** Internal failure categories (never client-facing; logs only). */
type GeminiErrorCategory =
  | "timeout"
  | "transport"
  | "rate_limited"
  | "rejected"
  | "provider_error"
  | "invalid_response";

type GeminiPhase =
  | "upload_start"
  | "upload_bytes"
  | "upload_ready"
  | "generate"
  | "cleanup";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Map a transport-level throw to a category (timeout vs everything else). */
const transportCategory = (error: unknown): GeminiErrorCategory =>
  error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport";

/** Map an HTTP status to a failure category. */
const categoryForStatus = (status: number): GeminiErrorCategory => {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_error";
  if (status >= 400) return "rejected";
  // 2xx with unusable content.
  return "invalid_response";
};

/** Map an internal category to the public typed result. */
const toResult = (category: GeminiErrorCategory): GeminiStructuredResult => {
  switch (category) {
    case "rate_limited":
      return { status: "rate_limited" };
    case "rejected":
      return { status: "rejected" };
    case "invalid_response":
      return { status: "invalid_response" };
    case "timeout":
    case "transport":
    case "provider_error":
      return { status: "unavailable" };
  }
};

/**
 * Sanitized phase log: phase, elapsed ms, HTTP status, category and (for
 * uploads) a byte count. Never keys, URIs, prompts, schemas or payloads.
 */
const logPhase = (
  phase: GeminiPhase,
  startedAt: number,
  category: GeminiErrorCategory | "success",
  httpStatus: number | null,
  bytes?: number,
): void => {
  const parts = [
    `phase=${phase}`,
    `category=${category}`,
    `httpStatus=${httpStatus ?? "none"}`,
    `elapsedMs=${Math.round(performance.now() - startedAt)}`,
  ];
  if (typeof bytes === "number") parts.push(`bytes=${bytes}`);
  const line = `[gemini-provider] ${parts.join(" ")}`;
  if (category === "success") {
    console.info(line);
  } else {
    console.error(line);
  }
};

/** Size-aware upload budget: base + per-MiB, clamped to [min, max]. */
const uploadTimeoutMs = (byteLength: number): number => {
  const mebibytes = Math.ceil(byteLength / (1024 * 1024));
  const estimate =
    GEMINI_UPLOAD_BASE_TIMEOUT_MS + mebibytes * GEMINI_UPLOAD_MS_PER_MIB;
  return Math.min(
    GEMINI_UPLOAD_MAX_TIMEOUT_MS,
    Math.max(GEMINI_UPLOAD_MIN_TIMEOUT_MS, estimate),
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Programmer/out-of-policy inputs fail fast: prompts, schemas and documents
 * come from trusted server code, so violations are bugs — not user errors.
 * Never throws on provider behavior (those are typed results).
 */
const assertValidExtractionRequest = (request: StructuredExtractionRequest): void => {
  if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
    throw new Error("Extraction prompt must be a non-empty string.");
  }
  if (!isRecord(request.schema)) {
    throw new Error("Extraction schema must be a JSON Schema object.");
  }
  const { document } = request;
  if (
    !(document instanceof Uint8Array) ||
    document.byteLength === 0 ||
    document.byteLength > DOCUMENT_MAX_SIZE_BYTES
  ) {
    throw new Error(
      "Extraction document violates the validated upload policy (empty or over the application cap).",
    );
  }
};

/**
 * Bounded response read: capped streaming decode mirroring the upload/storage
 * discipline. Cap counted in UTF-16 code units (a close, conservative proxy
 * for bytes here). Returns null when the body is missing or exceeds the cap.
 * Rejects on transport abort — callers own that classification.
 */
const readCappedResponseText = async (
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<string | null> => {
  if (!stream) return null;
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      text += decoder.decode(value, { stream: true });
      if (text.length > cap) {
        await reader.cancel();
        return null;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
};

/** Bounded body read + JSON parse. Throws only on transport abort. */
const readBoundedJson = async (
  response: Response,
  cap: number,
): Promise<unknown | null> => {
  const text = await readCappedResponseText(response.body, cap);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Extract the model's final text from the documented Interactions response
 * shapes. Both surfaces are honored defensively (contract note: the SDK
 * exposes `output_text`; the REST examples read `steps[-1].content[0].text`).
 * Never logs the extracted text.
 */
const extractOutputText = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;

  const explicit = payload["output_text"];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }

  const steps = payload["steps"];
  if (!Array.isArray(steps)) return null;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!isRecord(step)) continue;
    const content = step["content"];
    if (!Array.isArray(content)) continue;
    let text = "";
    for (const block of content) {
      if (isRecord(block) && typeof block["text"] === "string") {
        text += block["text"];
      }
    }
    if (text.trim().length > 0) return text;
  }
  return null;
};

/** Defensive removal of an optional whole-string code fence around JSON. */
const stripOptionalCodeFence = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
};

/**
 * Decode one complete interaction response body: JSON envelope -> final output
 * text -> structured JSON. Every risky step is guarded, so this never throws;
 * nothing payload-derived is ever logged.
 */
const decodeStructuredResponse = (text: string): GeminiStructuredResult => {
  let responsePayload: unknown;
  try {
    responsePayload = JSON.parse(text);
  } catch {
    console.error("[gemini-provider] HTTP response was not parseable JSON.");
    return { status: "invalid_response" };
  }

  const outputText = extractOutputText(responsePayload);
  if (outputText === null) {
    console.error("[gemini-provider] Response carried no text output step.");
    return { status: "invalid_response" };
  }

  const structuredText = stripOptionalCodeFence(outputText);
  if (structuredText.length === 0 || structuredText.length > GEMINI_MAX_OUTPUT_JSON_CHARS) {
    console.error("[gemini-provider] Structured output text is empty or oversized.");
    return { status: "invalid_response" };
  }

  let structured: unknown;
  try {
    structured = JSON.parse(structuredText);
  } catch {
    console.error("[gemini-provider] Structured output was not parseable JSON.");
    return { status: "invalid_response" };
  }

  return { status: "success", data: structured };
};

// ---------------------------------------------------------------------------
// Files API
// ---------------------------------------------------------------------------

/** A successfully uploaded, ready-to-use provider file. Never persisted. */
interface UploadedGeminiFile {
  /** Provider resource name, e.g. `files/abc-123`. */
  name: string;
  /** Opaque content URI used as the Interactions document reference. */
  uri: string;
  /** Provider-reported processing state at finalize time, if present. */
  state: string | null;
}

type UploadOutcome =
  | { ok: true; file: UploadedGeminiFile }
  | { ok: false; category: GeminiErrorCategory };

/** Parse and shape-check the `{ file: { name, uri, state } }` upload payload. */
const parseUploadedFile = (payload: unknown): UploadedGeminiFile | null => {
  if (!isRecord(payload)) return null;
  const file = payload["file"];
  if (!isRecord(file)) return null;

  const name = file["name"];
  const uri = file["uri"];
  if (typeof name !== "string" || !GEMINI_FILE_NAME_PATTERN.test(name)) {
    return null;
  }
  if (typeof uri !== "string" || !uri.startsWith("https://")) {
    return null;
  }

  const state = file["state"];
  return { name, uri, state: typeof state === "string" ? state : null };
};

/**
 * Wait until the uploaded file can be used for inference. PDFs are normally
 * ACTIVE at finalize; polling is bounded (10 x 1s) so a stuck file can never
 * hang a run.
 */
const waitForFileActive = async (
  file: UploadedGeminiFile,
  finalizeStatus: number,
): Promise<
  | { ok: true; httpStatus: number | null }
  | { ok: false; category: GeminiErrorCategory; httpStatus: number | null }
> => {
  if (file.state === "ACTIVE") {
    return { ok: true, httpStatus: finalizeStatus };
  }
  if (file.state === "FAILED") {
    return { ok: false, category: "provider_error", httpStatus: finalizeStatus };
  }

  for (
    let attempt = 0;
    attempt < GEMINI_FILE_ACTIVE_POLL_ATTEMPTS;
    attempt += 1
  ) {
    await sleep(GEMINI_FILE_ACTIVE_POLL_INTERVAL_MS);
    let response: Response;
    try {
      response = await fetch(`${GEMINI_API_BASE}/${file.name}`, {
        method: "GET",
        headers: { "x-goog-api-key": geminiEnv.apiKey },
        cache: "no-store",
        signal: AbortSignal.timeout(GEMINI_FILE_ACTIVE_POLL_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, category: transportCategory(error), httpStatus: null };
    }

    if (!response.ok) {
      const category = categoryForStatus(response.status);
      await response.body?.cancel();
      return { ok: false, category, httpStatus: response.status };
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(response, GEMINI_MAX_FILE_METADATA_CHARS);
    } catch (error) {
      return {
        ok: false,
        category: transportCategory(error),
        httpStatus: response.status,
      };
    }

    const state =
      isRecord(payload) && typeof payload["state"] === "string"
        ? payload["state"]
        : null;
    if (state === "ACTIVE") {
      return { ok: true, httpStatus: response.status };
    }
    if (state === "FAILED") {
      return { ok: false, category: "provider_error", httpStatus: response.status };
    }
  }

  // Bounded polling exhausted: treat as a provider-side stall.
  return { ok: false, category: "timeout", httpStatus: null };
};

/**
 * `BodyInit` in this TypeScript lib requires an ArrayBuffer-backed view,
 * while `StructuredExtractionRequest.document` is intentionally a plain
 * `Uint8Array` (unchanged public contract). Bytes always originate from the
 * storage `get` result (`Uint8Array<ArrayBuffer>`), so this is a type-level
 * narrowing only — no copy of the document is made.
 */
const asUploadBody = (document: Uint8Array): Uint8Array<ArrayBuffer> =>
  document as Uint8Array<ArrayBuffer>;

/**
 * Upload the PDF through the resumable Files API in two requests (metadata,
 * then bytes) and wait for it to be ACTIVE. Logs phase timings only.
 */
const uploadPdfToFiles = async (document: Uint8Array): Promise<UploadOutcome> => {
  // --- Phase 1: resumable upload initiation (metadata only) ----------------
  const startAt = performance.now();
  let startResponse: Response;
  try {
    startResponse = await fetch(GEMINI_FILES_UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        "x-goog-api-key": geminiEnv.apiKey,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(document.byteLength),
        "X-Goog-Upload-Header-Content-Type": GEMINI_PDF_MIME_TYPE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: GEMINI_FILE_DISPLAY_NAME } }),
      cache: "no-store",
      signal: AbortSignal.timeout(GEMINI_UPLOAD_START_TIMEOUT_MS),
    });
  } catch (error) {
    const category = transportCategory(error);
    logPhase("upload_start", startAt, category, null);
    return { ok: false, category };
  }

  if (!startResponse.ok) {
    const category = categoryForStatus(startResponse.status);
    logPhase("upload_start", startAt, category, startResponse.status);
    await startResponse.body?.cancel();
    return { ok: false, category };
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  await startResponse.body?.cancel();
  if (uploadUrl === null || !uploadUrl.startsWith("https://")) {
    logPhase("upload_start", startAt, "invalid_response", startResponse.status);
    return { ok: false, category: "invalid_response" };
  }
  logPhase("upload_start", startAt, "success", startResponse.status);

  // --- Phase 2: upload the bytes and finalize ------------------------------
  const bytesAt = performance.now();
  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "content-type": GEMINI_PDF_MIME_TYPE,
        "content-length": String(document.byteLength),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: asUploadBody(document),
      cache: "no-store",
      signal: AbortSignal.timeout(uploadTimeoutMs(document.byteLength)),
    });
  } catch (error) {
    const category = transportCategory(error);
    logPhase("upload_bytes", bytesAt, category, null, document.byteLength);
    return { ok: false, category };
  }

  if (!uploadResponse.ok) {
    const category = categoryForStatus(uploadResponse.status);
    logPhase(
      "upload_bytes",
      bytesAt,
      category,
      uploadResponse.status,
      document.byteLength,
    );
    await uploadResponse.body?.cancel();
    return { ok: false, category };
  }

  let payload: unknown;
  try {
    payload = await readBoundedJson(uploadResponse, GEMINI_MAX_FILE_METADATA_CHARS);
  } catch (error) {
    const category = transportCategory(error);
    logPhase(
      "upload_bytes",
      bytesAt,
      category,
      uploadResponse.status,
      document.byteLength,
    );
    return { ok: false, category };
  }

  const file = parseUploadedFile(payload);
  if (file === null) {
    logPhase(
      "upload_bytes",
      bytesAt,
      "invalid_response",
      uploadResponse.status,
      document.byteLength,
    );
    return { ok: false, category: "invalid_response" };
  }
  logPhase(
    "upload_bytes",
    bytesAt,
    "success",
    uploadResponse.status,
    document.byteLength,
  );

  // --- Phase 3: readiness (bounded polling) --------------------------------
  const readyAt = performance.now();
  const readiness = await waitForFileActive(file, uploadResponse.status);
  if (!readiness.ok) {
    logPhase("upload_ready", readyAt, readiness.category, readiness.httpStatus);
    return { ok: false, category: readiness.category };
  }
  logPhase("upload_ready", readyAt, "success", readiness.httpStatus);

  return { ok: true, file };
};

/**
 * Best-effort deletion of the temporary provider file. Never affects the
 * extraction outcome: failures are logged (status/category only) and the
 * provider's 48-hour expiry remains the fallback.
 */
const deleteGeminiFile = async (name: string): Promise<void> => {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${GEMINI_API_BASE}/${name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": geminiEnv.apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(GEMINI_CLEANUP_TIMEOUT_MS),
    });
    await response.body?.cancel();
    logPhase(
      "cleanup",
      startedAt,
      response.ok ? "success" : categoryForStatus(response.status),
      response.status,
    );
  } catch (error) {
    logPhase("cleanup", startedAt, transportCategory(error), null);
  }
};

// ---------------------------------------------------------------------------
// Generation (Interactions API)
// ---------------------------------------------------------------------------

/**
 * Run ONE structured generation against the uploaded file URI, consuming the
 * whole response body before returning so the caller's cleanup runs only when
 * the provider has nothing left to stream.
 */
const generateFromFileUri = async (
  fileUri: string,
  request: StructuredExtractionRequest,
): Promise<GeminiStructuredResult> => {
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetch(GEMINI_INTERACTIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": geminiEnv.apiKey,
        "Api-Revision": GEMINI_API_REVISION,
      },
      body: JSON.stringify({
        model: GEMINI_EXTRACTION_MODEL,
        // No Google-side interaction retention (see module docs) — always.
        store: false,
        input: [
          {
            type: "document",
            uri: fileUri,
            mime_type: GEMINI_PDF_MIME_TYPE,
          },
          { type: "text", text: request.prompt },
        ],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: request.schema,
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(GEMINI_GENERATION_TIMEOUT_MS),
    });
  } catch (error) {
    const category = transportCategory(error);
    logPhase("generate", startedAt, category, null);
    return toResult(category);
  }

  if (!response.ok) {
    const category = categoryForStatus(response.status);
    logPhase("generate", startedAt, category, response.status);
    await response.body?.cancel();
    return toResult(category);
  }

  // The generation deadline also spans streaming the body: reader.read() can
  // reject here, so this phase is fully guarded (never escapes as a throw).
  try {
    const text = await readCappedResponseText(
      response.body,
      GEMINI_MAX_RESPONSE_CHARS,
    );
    if (text === null) {
      logPhase("generate", startedAt, "invalid_response", response.status);
      return toResult("invalid_response");
    }
    const result = decodeStructuredResponse(text);
    logPhase(
      "generate",
      startedAt,
      result.status === "success" ? "success" : "invalid_response",
      response.status,
    );
    return result;
  } catch (error) {
    const category = transportCategory(error);
    logPhase("generate", startedAt, category, response.status);
    return toResult(category);
  }
};

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

/**
 * Run ONE structured extraction: upload -> generate -> delete.
 *
 * All-or-nothing results; the daily slot is consumed even when the request
 * fails (conservative). The uploaded file is always deleted in `finally`
 * (best effort) after the generation response has been consumed.
 */
export const extractStructured = async (
  request: StructuredExtractionRequest,
): Promise<GeminiStructuredResult> => {
  assertValidExtractionRequest(request);

  if (!reserveExtractionRequestSlot()) {
    return { status: "daily_ceiling_reached" };
  }

  const upload = await uploadPdfToFiles(request.document);
  if (!upload.ok) {
    return toResult(upload.category);
  }

  try {
    return await generateFromFileUri(upload.file.uri, request);
  } finally {
    // Runs after the response body has been consumed (or after a failure).
    await deleteGeminiFile(upload.file.name);
  }
};
