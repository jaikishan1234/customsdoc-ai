"use client";

/**
 * Manager-only field-correction control for ONE extracted field.
 *
 * Honest-UX contract:
 * - Shows the ORIGINAL extracted value (immutable extraction snapshot) plus
 *   the current effective value context the parent renders.
 * - Submits the corrected value + a MANDATORY reason; both are validated
 *   server-side (this client performs no real validation — the server is
 *   authoritative and its client-safe error strings are shown verbatim).
 * - Actions are idempotent-safe: a lost confirmation can be safely
 *   re-checked by refreshing, and re-submitting an already-applied value is
 *   rejected server-side as a no-op rather than duplicated.
 * - The page is refreshed ONLY after a confirmed HTTP 200; failures never
 *   claim success and never refresh (stale data stays visible with the
 *   error).
 * - Error/failure text is always the route's client-safe strings; no raw
 *   provider/SQL/storage data ever reaches this component.
 * - Network failure / timeout: says exactly that no confirmation was
 *   received and tells the manager to refresh and re-check before
 *   retrying — never a fake "applied".
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type {
  CorrectionResponse,
  CorrectionSuccessBody,
} from "@/app/api/shipments/[shipmentId]/fields/[fieldId]/correct/route";

/** Generous but bounded: the correction includes a synchronous cross-check. */
const CORRECTION_CLIENT_TIMEOUT_MS = 60 * 1000;

type DialogState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "error"; message: string }
  | { phase: "unconfirmed"; message: string }
  | { phase: "done"; body: CorrectionSuccessBody };

const controlClasses =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-900 " +
  "outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";
const labelClasses =
  "text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const buttonPrimary =
  "w-fit rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition " +
  "hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 " +
  "dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const buttonGhost =
  "w-fit rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 transition " +
  "hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 " +
  "dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

export function FieldCorrectionControl({
  shipmentId,
  fieldId,
  fieldLabel,
  originalValue,
  unit,
  isNumeric,
}: {
  shipmentId: string;
  fieldId: string;
  fieldLabel: string;
  /** The ORIGINAL extraction snapshot (before any correction). */
  originalValue: string;
  unit: string | null;
  isNumeric: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<DialogState>({ phase: "idle" });
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(
    async (formData: FormData) => {
      setState({ phase: "submitting" });
      const controller = new AbortController();
      abortRef.current = controller;
      const timer = setTimeout(
        () => controller.abort(),
        CORRECTION_CLIENT_TIMEOUT_MS,
      );

      let response: Response | null = null;
      let networkFailed = false;
      try {
        // Simple JSON body from the two controlled-ish inputs (they are
        // plain form fields — FormData keeps this dependency-free).
        response = await fetch(
          `/api/shipments/${shipmentId}/fields/${fieldId}/correct`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              correctedValue: formData.get("correctedValue"),
              reason: formData.get("reason"),
            }),
            signal: controller.signal,
          },
        );
      } catch (error) {
        networkFailed = true;
        const timedOut =
          error instanceof DOMException && error.name === "AbortError";
        setState({
          phase: "unconfirmed",
          message: timedOut
            ? "The correction did not confirm within the time limit. No confirmation was received — refresh the page to check the field's current state before retrying. Re-submitting an already-applied value is safely rejected."
            : "The request could not reach the server. No confirmation was received — refresh the page to check the field's current state before retrying. Re-submitting an already-applied value is safely rejected.",
        });
      } finally {
        clearTimeout(timer);
        abortRef.current = null;
      }

      if (networkFailed || !response) return;

      const parse = await response
        .json()
        .then<CorrectionResponse | null>((data) =>
          data && typeof data === "object" ? (data as CorrectionResponse) : null,
        )
        .catch(() => null);
      if (!parse) {
        setState({
          phase: "error",
          message:
            "The server responded with an unexpected format. Refresh the page to check the field's current state before retrying.",
        });
        return;
      }
      if ("error" in parse) {
        setState({ phase: "error", message: parse.error });
        return;
      }

      // Confirmed success ONLY here: report, then refresh the server data.
      setState({ phase: "done", body: parse });
      router.refresh();
    },
    [fieldId, router, shipmentId],
  );

  if (!open) {
    return (
      <button
        type="button"
        className={buttonGhost}
        aria-label={`Correct ${fieldLabel}`}
        onClick={() => setOpen(true)}
      >
        Correct
      </button>
    );
  }

  return (
    <form
      action={submit}
      className="mt-2 w-full max-w-xl rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
      // The server is authoritative; keep native validation minimal.
      noValidate
    >
      <p className={labelClasses}>
        Correcting: {fieldLabel}
      </p>
      <dl className="mt-1 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-zinc-500 dark:text-zinc-400">Original extraction</dt>
          <dd className="font-mono text-zinc-700 dark:text-zinc-200">
            {originalValue}
            {unit ? ` ${unit}` : ""}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-zinc-500 dark:text-zinc-400">Current value</dt>
          <dd className="font-mono text-zinc-700 dark:text-zinc-200">
            {originalValue}
            {unit ? ` ${unit}` : ""}
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor={`correct-value-${fieldId}`} className={labelClasses}>
          Corrected value
        </label>
        <input
          id={`correct-value-${fieldId}`}
          name="correctedValue"
          inputMode={isNumeric ? "decimal" : undefined}
          autoComplete="off"
          disabled={state.phase === "submitting"}
          className={controlClasses}
        />
        {isNumeric ? (
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Plain decimal number, at most 4 decimals, within the storage
            precision (as if printed on the document, without separators).
          </p>
        ) : null}
      </div>

      <div className="mt-2 flex flex-col gap-1">
        <label htmlFor={`correct-reason-${fieldId}`} className={labelClasses}>
          Reason (required)
        </label>
        <textarea
          id={`correct-reason-${fieldId}`}
          name="reason"
          rows={2}
          maxLength={500}
          required
          autoComplete="off"
          disabled={state.phase === "submitting"}
          className={controlClasses}
        />
      </div>

      {state.phase === "submitting" ? (
        <p role="status" className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
          Applying correction and re-evaluating discrepancies…
        </p>
      ) : null}

      {state.phase === "error" ? (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.message}
        </p>
      ) : null}

      {state.phase === "unconfirmed" ? (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {state.message}
        </p>
      ) : null}

      {state.phase === "done" ? (
        <div className="mt-2 flex flex-col gap-1">
          <p
            role="status"
            className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
          >
            Correction applied{state.body.auditWriteFailed
              ? ", but its audit entry failed to write and needs manual backfill"
              : ""}
            . The cross-document check re-evaluated this shipment:{" "}
            {state.body.crossCheck.status === "applied"
              ? `created ${state.body.crossCheck.discrepanciesCreated ?? 0}, updated ${state.body.crossCheck.discrepanciesUpdated ?? 0}, closed ${state.body.crossCheck.discrepanciesObsoleted ?? 0}, moved to re-check ${state.body.crossCheck.discrepanciesRecheckPending ?? 0}.`
              : state.body.crossCheck.status === "skipped_concurrent"
                ? "a cross-check was already running for this shipment — the next one converges the state automatically."
                : "the re-evaluation could not complete this time; the next extraction run or correction re-evaluates."}
          </p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            The page has been refreshed with the corrected data.
          </p>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className={buttonPrimary}
          disabled={state.phase === "submitting"}
        >
          {state.phase === "submitting" ? "Submitting…" : "Submit correction"}
        </button>
        <button
          type="button"
          className={buttonGhost}
          disabled={state.phase === "submitting"}
          onClick={() => {
            setOpen(false);
            setState({ phase: "idle" });
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
