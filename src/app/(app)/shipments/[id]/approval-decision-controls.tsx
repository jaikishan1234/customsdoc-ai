"use client";

/**
 * Manager-only approve/reject controls for one shipment.
 *
 * Honest-UX contract:
 * - Uses the existing approval POST API; it invents no readiness logic. The
 *   server re-evaluates every rule and remains authoritative.
 * - Approve is offered only when the server's readiness result is ready and
 *   no live decision exists; the button also carries an explicit disabled
 *   reason so a manager never has to guess why it is unavailable.
 * - Reject always requires a non-empty note (1-500 characters) and sends it
 *   to the API. The client only pre-checks presence; the server validates the
 *   length and content policy.
 * - 401/403/404/409 and server failures render the API's client-safe message
 *   verbatim (a 409 may also include the exact readiness blockers).
 * - Data is refreshed ONLY after a confirmed 200; warnings about a failed
 *   audit write are shown instead of implying a complete audit trail.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type {
  ApprovalResponse,
  ApprovalApprovedBody,
  ApprovalRejectedBody,
} from "@/app/api/shipments/[shipmentId]/approval/route";
import { formatDocumentTypeLabel } from "@/lib/document-display";
import { formatLongDateTimeUtc } from "@/lib/date-display";
import type { ApprovalBlocker } from "@/lib/services/approval-service";

/** Bounded: approval is a guarded update plus one audit insert. */
const DECISION_CLIENT_TIMEOUT_MS = 30 * 1000;

type DecisionState =
  | { phase: "idle" }
  | { phase: "submitting"; decision: "approve" | "reject" }
  | {
      phase: "error";
      message: string;
      blockers?: readonly ApprovalBlocker[];
    }
  | { phase: "unconfirmed"; message: string }
  | {
      phase: "done";
      body: ApprovalApprovedBody | ApprovalRejectedBody;
    };

const buttonPrimary =
  "w-fit rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition " +
  "hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 " +
  "dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const buttonDanger =
  "w-fit rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 transition " +
  "hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 " +
  "dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40";
const buttonGhost =
  "w-fit rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 transition " +
  "hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 " +
  "dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
const textareaClasses =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-900 " +
  "outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

/** Blocker text for a 409 response (same vocabulary the panel renders). */
const blockerText = (blocker: ApprovalBlocker): string => {
  switch (blocker.code) {
    case "missing_document":
      return `${formatDocumentTypeLabel(blocker.documentType)} is missing.`;
    case "attempt_not_completed":
      return `${formatDocumentTypeLabel(blocker.documentType)}: latest attempt ${blocker.attempt} is ${blocker.extractionStatus}.`;
    case "required_field_missing":
      return `${formatDocumentTypeLabel(blocker.documentType)} · ${blocker.fieldLabel} is missing.`;
    case "required_field_pending":
      return `${formatDocumentTypeLabel(blocker.documentType)} · ${blocker.fieldLabel} is pending review.`;
    case "blocking_discrepancy":
      return `${blocker.discrepancyType}${blocker.scopeKey ? ` (${blocker.scopeKey})` : ""} is ${blocker.status}.`;
  }
};

export function ApprovalDecisionControls({
  shipmentId,
  approveDisabledReason,
  rejectDisabledReason,
}: {
  shipmentId: string;
  /** Null = approve is offered; any string is the reason it is disabled. */
  approveDisabledReason: string | null;
  /** Null = reject is offered; any string is the reason it is disabled. */
  rejectDisabledReason: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<DecisionState>({ phase: "idle" });
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(
    async (decision: "approve" | "reject") => {
      if (decision === "reject" && note.trim().length === 0) {
        setNoteError("A rejection note is required.");
        return;
      }
      setNoteError(null);
      setState({ phase: "submitting", decision });

      const controller = new AbortController();
      abortRef.current = controller;
      const timer = setTimeout(
        () => controller.abort(),
        DECISION_CLIENT_TIMEOUT_MS,
      );

      let response: Response | null = null;
      let networkFailed = false;
      try {
        response = await fetch(`/api/shipments/${shipmentId}/approval`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            decision === "approve"
              ? { decision: "approve" }
              : { decision: "reject", note: note.trim() },
          ),
          signal: controller.signal,
        });
      } catch (error) {
        networkFailed = true;
        const timedOut =
          error instanceof DOMException && error.name === "AbortError";
        setState({
          phase: "unconfirmed",
          message: timedOut
            ? "The decision did not confirm within the time limit. No confirmation was received — refresh the shipment to check its current status before retrying."
            : "The request could not reach the server. No confirmation was received — refresh the shipment to check its current status before retrying.",
        });
      } finally {
        clearTimeout(timer);
        abortRef.current = null;
      }

      if (networkFailed || !response) return;

      const parsed = await response
        .json()
        .then<ApprovalResponse | null>((data) =>
          data && typeof data === "object" ? (data as ApprovalResponse) : null,
        )
        .catch(() => null);

      if (!parsed) {
        setState({
          phase: "error",
          message: `The server responded with an unexpected format (HTTP ${response.status}). Refresh the shipment before retrying.`,
        });
        return;
      }
      if ("error" in parsed) {
        setState({
          phase: "error",
          message: parsed.error,
          blockers: parsed.blockers,
        });
        return;
      }

      // Confirmed success ONLY here: report, then refresh the server data.
      setState({ phase: "done", body: parsed });
      setRejectOpen(false);
      setNote("");
      router.refresh();
    },
    [note, router, shipmentId],
  );

  if (state.phase === "done") {
    const body = state.body;
    return (
      <div className="flex flex-col gap-1">
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          {body.status === "approved"
            ? "Shipment approved. The page has been refreshed with the recorded decision."
            : "Shipment rejected. The page has been refreshed with the recorded decision."}
        </p>
        {body.warnings.length > 0 ? (
          <ul
            role="alert"
            className="flex flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {body.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        {body.status === "approved" && body.snapshot.capturedAt !== null ? (
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Evidence snapshot captured{" "}
            {formatLongDateTimeUtc(
              new Date(body.snapshot.capturedAt),
              "UTC",
            )}{" "}
            · {body.snapshot.documentCount} document
            {body.snapshot.documentCount === 1 ? "" : "s"} ·{" "}
            {body.snapshot.extractionCount} extraction
            {body.snapshot.extractionCount === 1 ? "" : "s"}.
          </p>
        ) : null}
      </div>
    );
  }

  const submitting = state.phase === "submitting";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-2">
        <button
          type="button"
          className={buttonPrimary}
          disabled={submitting || approveDisabledReason !== null}
          title={approveDisabledReason ?? undefined}
          onClick={() => void submit("approve")}
        >
          {state.phase === "submitting" && state.decision === "approve"
            ? "Approving…"
            : "Approve shipment"}
        </button>
        {rejectOpen ? null : (
          <button
            type="button"
            className={buttonDanger}
            disabled={submitting || rejectDisabledReason !== null}
            title={rejectDisabledReason ?? undefined}
            onClick={() => {
              setRejectOpen(true);
              setState({ phase: "idle" });
            }}
          >
            Reject shipment
          </button>
        )}
      </div>

      {approveDisabledReason !== null ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Approve unavailable: {approveDisabledReason}
        </p>
      ) : null}
      {rejectDisabledReason !== null && !rejectOpen ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Reject unavailable: {rejectDisabledReason}
        </p>
      ) : null}

      {rejectOpen ? (
        <div className="flex w-full max-w-xl flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <label
            htmlFor={`rejection-note-${shipmentId}`}
            className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
          >
            Rejection note (required)
          </label>
          <textarea
            id={`rejection-note-${shipmentId}`}
            rows={3}
            maxLength={500}
            value={note}
            disabled={submitting}
            onChange={(event) => {
              setNote(event.target.value);
              if (noteError !== null) setNoteError(null);
            }}
            className={textareaClasses}
          />
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            1-500 characters. The note is stored on the rejection and in the
            audit trail.
          </p>
          {noteError !== null ? (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {noteError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonDanger}
              disabled={submitting || rejectDisabledReason !== null}
              onClick={() => void submit("reject")}
            >
              {state.phase === "submitting" && state.decision === "reject"
                ? "Rejecting…"
                : "Confirm rejection"}
            </button>
            <button
              type="button"
              className={buttonGhost}
              disabled={submitting}
              onClick={() => {
                setRejectOpen(false);
                setNote("");
                setNoteError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === "error" ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>{state.message}</p>
          {state.blockers && state.blockers.length > 0 ? (
            <ul className="list-disc pl-4">
              {state.blockers.map((blocker, index) => (
                <li key={`${blocker.code}-${index}`}>{blockerText(blocker)}</li>
              ))}
            </ul>
          ) : null}
        </div>
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
