"use client";

/**
 * Extraction trigger panel for the shipment detail page.
 *
 * Contract notes (honest UX):
 * - The run is SYNCHRONOUS server-side and can take a while (documents are
 *   processed sequentially, each with one storage read + one AI request).
 *   The button stays disabled with a pending state until the HTTP response
 *   arrives, and the client uses an explicit generous timeout.
 * - A network error / timeout NEVER claims completion: the panel shows that
 *   no confirmation was received, points at the results section (which the
 *   server re-renders), and explains that a re-run is always safe (a re-run
 *   creates a new attempt per document; the service fences duplicates).
 * - The server renders the attempt history / extracted fields — this panel
 *   only triggers the run, reports per-document outcomes, and asks Next.js
 *   to refresh the server data after a confirmed response.
 * - Errors shown are always the route's client-safe strings; no raw
 *   provider/SQL/storage details ever reach this component.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type {
  ExtractRunResponse,
  ExtractRunSuccessBody,
} from "@/app/api/shipments/[shipmentId]/extract/route";

/**
 * Generous client-side timeout: three documents, sequential, each with
 * provider latency. A hit timeout signal aborts the client fetch — the
 * server side may still be running, which the messaging handles honestly.
 */
const EXTRACTION_CLIENT_TIMEOUT_MS = 3 * 60 * 1000;

/** Client-friendly text for the sanitized error codes (constant strings). */
const ERROR_CODE_LABELS: Record<string, string> = {
  STORAGE_NOT_FOUND: "Stored document no longer found",
  STORAGE_KEY_INVALID: "Stored document reference invalid",
  STORAGE_UNAVAILABLE: "Document storage temporarily unavailable",
  CHECKSUM_MISMATCH: "Stored document failed the integrity check",
  PROVIDER_UNAVAILABLE: "AI provider temporarily unavailable",
  PROVIDER_RATE_LIMITED: "AI provider rate limit hit",
  PROVIDER_REJECTED: "AI provider rejected the request",
  PROVIDER_INVALID_OUTPUT: "AI output failed validation",
  DAILY_CEILING: "Daily extraction ceiling reached",
  PERSISTENCE_FAILED: "Results could not be saved",
  SUPERSEDE_INCOMPLETE: "Retired the previous result but save incomplete",
  STALE_PROCESSING: "Abandoned attempt recovered",
  INTERNAL_ERROR: "Internal error",
};

const SKIP_REASON_LABELS: Record<string, string> = {
  daily_ceiling: "Daily extraction ceiling reached",
  daily_count_unavailable: "Extraction skipped — usage could not be verified",
};

type PanelState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "error"; message: string }
  | { phase: "unconfirmed"; message: string }
  | { phase: "done"; body: ExtractRunSuccessBody };

const buttonClasses =
  "w-fit rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition " +
  "hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 " +
  "dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const noteClasses =
  "text-xs text-zinc-500 dark:text-zinc-400";

export function ExtractionPanel({
  shipmentId,
  canRun,
  currentStatus,
}: {
  shipmentId: string;
  canRun: boolean;
  currentStatus: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<PanelState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      // Cleanup on unmount: never leak a pending timer or fetch.
      abortRef.current?.abort();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const runExtraction = useCallback(async () => {
    setState({ phase: "running" });
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(
      () => controller.abort(),
      EXTRACTION_CLIENT_TIMEOUT_MS,
    );
    timeoutRef.current = timer;

    let response: Response | null = null;
    let networkFailed = false;
    try {
      response = await fetch(`/api/shipments/${shipmentId}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
    } catch (error) {
      networkFailed = true;
      // Distinguish a deliberate timeout abort from other failures only for
      // wording; both mean "no completion confirmation received".
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      setState({
        phase: "unconfirmed",
        message: timedOut
          ? "Extraction did not confirm within the time limit. It may still be running on the server or have stopped partway — check the results below and refresh. A re-run is always safe."
          : "The request could not reach the server. No confirmation was received — check the results below and refresh. A re-run is always safe.",
      });
    } finally {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      abortRef.current = null;
    }

    if (networkFailed || !response) return;

    const parse = await response
      .json()
      .then<ExtractRunResponse | null>((data) => (data && typeof data === "object" ? (data as ExtractRunResponse) : null))
      .catch(() => null);
    if (!parse) {
      setState({
        phase: "error",
        message: "The server responded with an unexpected format. Please check the results below and refresh.",
      });
      return;
    }
    if ("error" in parse) {
      setState({
        phase: "error",
        message:
          response.status === 409
            ? `${parse.error} (HTTP 409)`
            : parse.error,
      });
      return;
    }

    // Confirmed completion (HTTP 200 + started body) — refresh so the
    // server-rendered attempt history and fields update below.
    setState({ phase: "done", body: parse });
    router.refresh();
  }, [router, shipmentId]);

  if (!canRun) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        Extraction is available for shipments in DRAFT, PROCESSING or REJECTED
        status. This shipment is currently <strong>{currentStatus}</strong>.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runExtraction}
          disabled={state.phase === "running"}
          aria-busy={state.phase === "running"}
          className={buttonClasses}
        >
          {state.phase === "running" ? "Extracting…" : "Run extraction"}
        </button>
        <p className={noteClasses}>
          Sequential run — one AI request per document. This can take a minute
          or more.
        </p>
      </div>

      {state.phase === "running" ? (
        <p role="status" className="text-sm text-zinc-600 dark:text-zinc-300">
          Running… documents are processed one at a time. Do not start another
          run for this shipment.
        </p>
      ) : null}

      {state.phase === "error" ? (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.message}
        </p>
      ) : null}

      {state.phase === "unconfirmed" ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {state.message}
        </p>
      ) : null}

      {state.phase === "done" ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm text-zinc-600 dark:text-zinc-300">
            Run finished — {state.body.summary.completed} completed,{" "}
            {state.body.summary.failed} failed/saved-incomplete,{" "}
            {state.body.summary.skipped} skipped
            {state.body.summary.conflict > 0
              ? `, ${state.body.summary.conflict} concurrent conflict${state.body.summary.conflict === 1 ? "" : "s"}`
              : ""}
            . Results below have been refreshed.
          </p>
          <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {state.body.documents.map((outcome, index) => (
              <li
                key={`${outcome.documentId}-${outcome.status}-${index}`}
                className="flex flex-col gap-1 py-2 text-xs text-zinc-600 dark:text-zinc-300"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                    {outcome.documentType}
                  </span>
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">
                    {outcome.status === "completed"
                      ? `Extracted (${outcome.fieldCount} field${outcome.fieldCount === 1 ? "" : "s"})`
                      : outcome.status === "supersede_incomplete"
                        ? "Partially applied — run extraction again to recover"
                        : outcome.status === "failed"
                          ? `Failed: ${ERROR_CODE_LABELS[outcome.errorCode] ?? outcome.errorCode}`
                          : outcome.status === "conflict"
                            ? "Skipped — another run already owns the next attempt"
                            : `Skipped — ${SKIP_REASON_LABELS[outcome.reason] ?? outcome.reason}`}
                  </span>
                  {outcome.status === "completed" || outcome.status === "supersede_incomplete" ? (
                    <span className="text-zinc-500 dark:text-zinc-400">
                      attempt {outcome.attempt}
                    </span>
                  ) : null}
                  {outcome.status === "failed" ? (
                    <span className="text-zinc-500 dark:text-zinc-400">
                      attempt {outcome.attempt}
                    </span>
                  ) : null}
                  {outcome.status === "completed" && outcome.warning ? (
                    <span className="text-amber-700 dark:text-amber-300">
                      {outcome.warning}
                    </span>
                  ) : null}
                </div>
                {outcome.status === "completed" &&
                outcome.missingRequiredKeys.length > 0 ? (
                  <p className="text-amber-700 dark:text-amber-300">
                    Missing required keys:{" "}
                    {outcome.missingRequiredKeys.join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
