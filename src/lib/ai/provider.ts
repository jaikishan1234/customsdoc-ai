import "server-only";

/**
 * Server-only Gemini "Interactions API" adapter for structured document
 * extraction (plain fetch — no SDK, no new dependencies).
 *
 * Security posture:
 * - Credentials come exclusively from the server-side environment
 *   (`GEMINI_API_KEY`), validated once at module load with the same fail-fast
 *   pattern as the Cloudinary adapter. Failures name the missing variable but
 *   never echo secret values.
 * - `store: false` on EVERY request: no Google-side interaction retention
 *   (the free tier would otherwise retain interactions for 1 day). This is a
 *   request-hygiene measure only — it is NOT a substitute for the
 *   synthetic-data-only policy: real customs documents must never reach this
 *   adapter, full stop.
 * - NOTHING about the request or response content is ever logged: no document
 *   bytes, no base64, no prompt text, no key material, no raw provider
 *   responses. Logs carry status codes / error names only. Parsed model
 *   output is returned typed to the caller — never serialized into logs.
 * - This is the single place where provider nouns appear (endpoint URL, model
 *   id, `x-goog-api-key`, `Api-Revision`, request fields such as
 *   `response_format`). Service code works only in terms of catalogs,
 *   schemas and typed results.
 * - Model confidence is an UNTRUSTED estimate: callers must run the result
 *   through ./response-validation.ts against the generating catalog before
 *   persisting anything.
 * - An instance-local daily slot is reserved before every attempt (see
 *   ./request-ceiling.ts; best-effort per instance, not a global quota).
 *
 * Wire contract (verified against ai.google.dev, Interactions API GA):
 *   POST v1beta/interactions, `x-goog-api-key` + `Api-Revision` headers,
 *   input = [inline PDF document block, text prompt], response_format =
 *   { type: "text", mime_type: "application/json", schema }.
 *   The PDF is sent inline: our capped documents (<= 25 MiB) become ~33%
 *   larger as base64, comfortably inside the documented 50 MB request limit.
 */

import { DOCUMENT_MAX_SIZE_BYTES } from "@/lib/validation/document";

import { reserveExtractionRequestSlot } from "./request-ceiling";

const GEMINI_INTERACTIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

/** Pinned API revision header required by the Interactions REST surface. */
const GEMINI_API_REVISION = "2026-05-20";

/** Current stable Flash model with PDF input + structured outputs. */
export const GEMINI_EXTRACTION_MODEL = "gemini-3.8-flash";

/** Documentation: PDF handling supports up to 50MB per request. */
const GEMINI_PROVIDER_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

/** Generous response cap (chars) — responses carry no echoed document; 8 MiB of
 * text is far above any legitimate structured extraction output. */
const GEMINI_MAX_RESPONSE_CHARS = 8 * 1024 * 1024;

/** Hard cap for the extracted-JSON text before parsing (defense-in-depth). */
const GEMINI_MAX_OUTPUT_JSON_CHARS = 1_000_000;

/** Per-request timeout; extraction runs are short, structured generations. */
const GEMINI_REQUEST_TIMEOUT_MS = 60_000;

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
// Typed contract
// ---------------------------------------------------------------------------

export interface StructuredExtractionRequest {
  /**
   * Fully-formed extraction prompt for the document type (built by the
   * service layer). The document's ONLY channel to the model is the inline
   * PDF block below — never embed document text here.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Chunked btoa — portable base64 with no Buffer dependency and no giant
 * `String.fromCharCode` calls (chunks of 0x8000 are the practical max).
 * The encoded document ONLY ever lives in the request body — never in logs.
 */
const encodeBase64 = (data: Uint8Array): string => {
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    binary += String.fromCharCode(...data.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
};

/** Conservative wire-size estimate: base64 inflation, prompt text, schema. */
const estimateRequestBodyChars = (
  documentByteLength: number,
  prompt: string,
  schema: Record<string, unknown>,
): number => {
  const base64Chars = 4 * Math.ceil(documentByteLength / 3);
  const schemaJsonChars = JSON.stringify(schema).length;
  return base64Chars + prompt.length + schemaJsonChars + 2048; // envelope slack
};

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
  if (
    estimateRequestBodyChars(document.byteLength, request.prompt, request.schema) >
    GEMINI_PROVIDER_BODY_LIMIT_BYTES
  ) {
    throw new Error("Base64-encoded extraction request would exceed the provider body limit.");
  }
};

/**
 * Bounded response read: capped streaming decode mirroring the upload/storage
 * discipline. Cap counted in UTF-16 code units (a close, conservative proxy
 * for bytes here). Returns null when the body is missing or exceeds the cap.
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

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

/**
 * Run ONE structured extraction against the pinned Gemini Flash model.
 *
 * All-or-nothing results; the daily slot is consumed even when the request
 * fails (conservative). Statuses are logged with status code / error name
 * ONLY — payload content never reaches a log line.
 */
export const extractStructured = async (
  request: StructuredExtractionRequest,
): Promise<GeminiStructuredResult> => {
  assertValidExtractionRequest(request);

  if (!reserveExtractionRequestSlot()) {
    return { status: "daily_ceiling_reached" };
  }

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
        // No Google-side retention (see module docs) — per request, always.
        store: false,
        input: [
          {
            type: "document",
            data: encodeBase64(request.document),
            mime_type: "application/pdf",
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
      signal: AbortSignal.timeout(GEMINI_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(
      `[gemini-provider] Transport failure (${error instanceof Error ? error.name : "unknown error type"}).`,
    );
    return { status: "unavailable" };
  }

  const status = response.status;
  if (status === 429) {
    console.error("[gemini-provider] Provider rate limit hit (status=429).");
    return { status: "rate_limited" };
  }
  if (status >= 500) {
    console.error(`[gemini-provider] Provider unavailable (status=${status}).`);
    return { status: "unavailable" };
  }
  if (status >= 400) {
    console.error(`[gemini-provider] Request rejected (status=${status}).`);
    return { status: "rejected" };
  }

  // --- Response-body phase -------------------------------------------------
  // The 60s deadline also spans streaming the body. If it fires here (or the
  // connection drops mid-body), reader.read() rejects. Without this guard that
  // rejection would escape the adapter as an uncaught throw and leave the
  // caller's attempt row in PROCESSING with no terminal state. Every failure
  // in this phase is a typed result instead.
  try {
    const text = await readCappedResponseText(
      response.body,
      GEMINI_MAX_RESPONSE_CHARS,
    );
    if (text === null) {
      console.error("[gemini-provider] Response body missing or over the size cap.");
      return { status: "unavailable" };
    }
    return decodeStructuredResponse(text);
  } catch (error) {
    console.error(
      `[gemini-provider] Response body read failure (${error instanceof Error ? error.name : "unknown error type"}).`,
    );
    return { status: "unavailable" };
  }
};

/**
 * Decode one complete response body: JSON envelope -> final output text ->
 * structured JSON. Every risky step is guarded, so this never throws; nothing
 * payload-derived is ever logged.
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
