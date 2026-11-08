"use client";

/**
 * Manager-only ACCEPT control for ONE extracted field pending review.
 *
 * Honest-UX contract:
 * - Accepting asserts the ORIGINAL extraction snapshot is correct; the value
 *   is never submitted, so the control can never alter it. A wrong value is a
 *   correction, not an acceptance.
 * - The server is authoritative: eligibility (active document, current
 *   COMPLETED attempt, still PENDING_REVIEW, valid value) is re-verified on
 *   every request and its client-safe error strings are shown verbatim.
 * - The page is refreshed ONLY after a confirmed HTTP 200; failures never
 *   claim success and never refresh.
 * - Network failure / timeout: says exactly that no confirmation was
 *   received and tells the manager to refresh and re-check before retrying —
 *   never a fake "accepted".
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type {
  FieldAcceptResponse,
  FieldAcceptSuccessBody,
} from "@/app/api/shipments/[shipmentId]/fields/[fieldId]/accept/route";

/** Bounded: acceptance is a single guarded update plus one audit insert. */
const ACCEPT_CLIENT_TIMEOUT_MS = 30 * 1000;

type AcceptState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "error"; message: string }
  | { phase: "unconfirmed"; message: string }
  | { phase: "done"; body: FieldAcceptSuccessBody };

const buttonGhost =
  "w-fit rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 transition " +
  "hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 " +
  "dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

export function FieldAcceptControl({
  shipmentId,
  fieldId,
  fieldLabel,
}: {
  shipmentId: string;
  fieldId: string;
  fieldLabel: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<AcceptState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const accept = useCallback(async () => {
    setState({ phase: "submitting" });
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(
      () => controller.abort(),
      ACCEPT_CLIENT_TIMEOUT_MS,
    );

    let response: Response | null = null;
    let networkFailed = false;
    try {
      response = await fetch(
        `/api/shipments/${shipmentId}/fields/${fieldId}/accept`,
        { method: "POST", signal: controller.signal },
      );
    } catch (error) {
      networkFailed = true;
      const timedOut =
        error instanceof DOMException && error.name === "AbortError";
      setState({
        phase: "unconfirmed",
        message: timedOut
          ? "The acceptance did not confirm within the time limit. No confirmation was received — refresh the page to check the field's current state before retrying."
          : "The request could not reach the server. No confirmation was received — refresh the page to check the field's current state before retrying.",
      });
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
    }

    if (networkFailed || !response) return;

    const parsed = await response
      .json()
      .then<FieldAcceptResponse | null>((data) =>
        data && typeof data === "object" ? (data as FieldAcceptResponse) : null,
      )
      .catch(() => null);
    if (!parsed) {
      setState({
        phase: "error",
        message:
          "The server responded with an unexpected format. Refresh the page to check the field's current state before retrying.",
      });
      return;
    }
    if ("error" in parsed) {
      setState({ phase: "error", message: parsed.error });
      return;
    }

    // Confirmed success ONLY here: report, then refresh the server data.
    setState({ phase: "done", body: parsed });
    router.refresh();
  }, [fieldId, router, shipmentId]);

  if (state.phase === "done") {
    return (
      <div className="flex flex-col gap-1">
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          Accepted. The page has been refreshed with the reviewed value.
        </p>
        {state.body.warnings.length > 0 ? (
          <ul
            role="alert"
            className="flex flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {state.body.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className={buttonGhost}
        aria-label={`Accept ${fieldLabel}`}
        disabled={state.phase === "submitting"}
        onClick={accept}
      >
        {state.phase === "submitting" ? "Accepting…" : "Accept value"}
      </button>

      {state.phase === "error" ? (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.message}
        </p>
      ) : null}

      {state.phase === "unconfirmed" ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
