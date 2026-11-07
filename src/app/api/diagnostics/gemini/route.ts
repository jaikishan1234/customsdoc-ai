/**
 * Opt-in, authenticated, text-only Gemini connectivity probe.
 *
 * Purpose: separate "is the Gemini endpoint reachable and does structured
 * output work at all?" from "is the PDF extraction request too slow?".
 * It sends ONE tiny text interaction — no PDF, no Cloudinary, no database,
 * no extraction pipeline — and reports only timing, HTTP status and a
 * sanitized category.
 *
 * Inert by default: unless GEMINI_DIAGNOSTIC_ENABLED === "true" this route
 * answers 404, so a deployed environment never exposes it. There is no UI,
 * no link and no metadata pointing at it. POST only (no accidental GET).
 *
 * Never logs: API key, prompt text, response contents, headers or secrets.
 * Diagnostic-only ceiling (20s) is independent of the production 60s timeout.
 */

import { USER_ROLES } from "@/lib/auth";
import { getSession, hasRole } from "@/lib/server/auth";

/** Keep in sync with src/lib/ai/provider.ts (source of truth). */
const GEMINI_INTERACTIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_API_REVISION = "2026-05-20";

/** Diagnostic-only ceiling — deliberately NOT the production timeout. */
const DIAGNOSTIC_TIMEOUT_MS = 20_000;

/** Minimum gap between probes in one instance (protects the free tier). */
const MIN_PROBE_INTERVAL_MS = 15_000;

/** Cap for draining the provider body (tiny response expected). */
const MAX_RESPONSE_CHARS = 64 * 1024;

const DIAGNOSTIC_ROLES = [
  USER_ROLES.DOCUMENTATION_EXECUTIVE,
  USER_ROLES.DOCUMENTATION_MANAGER,
] as const;

/** Trivial schema: proves structured-output decoding without a document. */
const DIAGNOSTIC_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const;

const DIAGNOSTIC_PROMPT = 'Respond with exactly this JSON and nothing else: {"ok": true}';

export type GeminiDiagnosticCategory =
  | "success"
  | "timeout"
  | "transport"
  | "rate_limited"
  | "rejected"
  | "provider_error"
  | "invalid_response";

let lastProbeAt = 0;

const json = (body: unknown, status: number): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

/** Bounded body read — never buffers more than `cap` characters. */
const readCappedText = async (
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

/** Pull the model's final text out of the documented response shapes. */
const extractOutputText = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const direct = record["output_text"];
  if (typeof direct === "string" && direct.trim().length > 0) return direct;

  const steps = record["steps"];
  if (!Array.isArray(steps)) return null;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (typeof step !== "object" || step === null) continue;
    const content = (step as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    let text = "";
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const value = (block as Record<string, unknown>)["text"];
      if (typeof value === "string") text += value;
    }
    if (text.trim().length > 0) return text;
  }
  return null;
};

/** True only when the text is the JSON object we asked for. */
const isExpectedJson = (text: string): boolean => {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")
    .trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)["ok"] === true
    );
  } catch {
    return false;
  }
};

export async function POST(): Promise<Response> {
  // 1. Opt-in gate — behaves as a non-existent route when disabled.
  if (process.env.GEMINI_DIAGNOSTIC_ENABLED !== "true") {
    return json({ error: "Not found." }, 404);
  }

  // 2. Authenticated + role-gated (server-side only).
  const session = await getSession();
  if (!session) {
    return json({ error: "You must be signed in to run this check." }, 401);
  }
  if (!hasRole(session, DIAGNOSTIC_ROLES)) {
    return json({ error: "You do not have permission to run this check." }, 403);
  }

  // 3. Per-instance throttle (best-effort, not a global quota).
  const now = Date.now();
  if (now - lastProbeAt < MIN_PROBE_INTERVAL_MS) {
    return json(
      { error: "A connectivity check ran recently. Try again shortly." },
      429,
    );
  }
  lastProbeAt = now;

  // 4. Key comes from the existing server-side environment only.
  const apiKey = process.env.GEMINI_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    console.error("[gemini-diagnostic] GEMINI_API_KEY is not configured.");
    return json({ error: "The AI provider is not configured." }, 500);
  }

  const startedAt = performance.now();
  let httpStatus: number | null = null;
  let category: GeminiDiagnosticCategory = "transport";

  try {
    const response = await fetch(GEMINI_INTERACTIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
        "Api-Revision": GEMINI_API_REVISION,
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        store: false,
        input: [{ type: "text", text: DIAGNOSTIC_PROMPT }],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: DIAGNOSTIC_SCHEMA,
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS),
    });

    httpStatus = response.status;

    if (httpStatus === 429) {
      category = "rate_limited";
    } else if (httpStatus >= 500) {
      category = "provider_error";
    } else if (httpStatus >= 400) {
      category = "rejected";
    } else {
      // 2xx: drain (bounded), then confirm the model returned our JSON.
      const bodyText = await readCappedText(response.body, MAX_RESPONSE_CHARS);
      let envelope: unknown = null;
      if (bodyText !== null) {
        try {
          envelope = JSON.parse(bodyText);
        } catch {
          envelope = null;
        }
      }
      const outputText = extractOutputText(envelope);
      category =
        outputText !== null && isExpectedJson(outputText)
          ? "success"
          : "invalid_response";
    }
  } catch (error) {
    // AbortSignal.timeout rejects with name "TimeoutError" (matches the
    // production log); anything else is a transport-level failure.
    category =
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "transport";
  }

  const elapsedMs = Math.round(performance.now() - startedAt);

  // Sanitized only: no key, prompt, headers or provider body.
  console.info(
    `[gemini-diagnostic] category=${category} httpStatus=${httpStatus ?? "none"} elapsedMs=${elapsedMs}`,
  );

  return json({ category, httpStatus, elapsedMs }, 200);
}
