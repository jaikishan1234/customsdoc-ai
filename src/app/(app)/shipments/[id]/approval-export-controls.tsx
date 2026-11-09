"use client";

/**
 * Manager-only Export CSV control for one shipment.
 *
 * Honest-UX contract:
 * - Uses the existing export GET API; it invents no readiness logic. The
 *   server re-evaluates every rule and remains authoritative — the disabled
 *   reason from the panel is convenience, not authorization.
 * - The response is a CSV download (200): the file is saved with the
 *   filename the server proposes (`Content-Disposition`), and the row count
 *   reported by the API is echoed to the manager. The panel refreshes after
 *   the download so the shipment shows its new EXPORTED state.
 * - 401/403/404/409 and server failures render the API's client-safe
 *   message verbatim; a 409 (already exported / stale / blocked) implies
 *   nothing changed, so it is safe to retry after a refresh.
 * - A network failure or timeout after the button is pressed may leave the
 *   one-shot export stamp applied without a downloaded file — the message
 *   says exactly that and points to a refresh, never a blind retry.
 * - A failed EXPORT_COMPLETED audit write is reported via the
 *   `X-Audit-Missing: 1` response header (a CSV body cannot carry JSON
 *   warnings) and shown as a warning — never as a complete trail.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { ExportErrorBody } from "@/app/api/shipments/[shipmentId]/export/route";

/** Bounded: readiness + CSV build + stamp + audit. */
const EXPORT_CLIENT_TIMEOUT_MS = 30 * 1000;

const AUDIT_MISSING_HEADER = "X-Audit-Missing";
const ROW_COUNT_HEADER = "X-Row-Count";

type ExportState =
  | { phase: "idle" }
  | { phase: "exporting" }
  | { phase: "error"; message: string }
  | { phase: "unconfirmed"; message: string }
  | { phase: "done"; rowCount: number | null; auditMissing: boolean };

const buttonPrimary =
  "w-fit rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition " +
  "hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 " +
  "dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

export function ApprovalExportControls({
  shipmentId,
  disabledReason,
}: {
  shipmentId: string;
  /** Null = export is offered; any string is the reason it is disabled. */
  disabledReason: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<ExportState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const exportCsv = useCallback(async () => {
    setState({ phase: "exporting" });

    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(
      () => controller.abort(),
      EXPORT_CLIENT_TIMEOUT_MS,
    );

    let response: Response | null = null;
    let networkFailed = false;
    try {
      response = await fetch(`/api/shipments/${shipmentId}/export`, {
        method: "GET",
        signal: controller.signal,
      });
    } catch (error) {
      networkFailed = true;
      const timedOut =
        error instanceof DOMException && error.name === "AbortError";
      setState({
        phase: "unconfirmed",
        message: timedOut
          ? "The export did not confirm within the time limit. No confirmation was received — refresh the shipment to check whether the export stamp was already applied before retrying."
          : "The request could not reach the server. No confirmation was received — refresh the shipment to check whether the export stamp was already applied before retrying.",
      });
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
    }

    if (networkFailed || !response) return;

    if (!response.ok) {
      const parsed = await response
        .json()
        .then<ExportErrorBody | null>((data) =>
          data && typeof data === "object" ? (data as ExportErrorBody) : null,
        )
        .catch(() => null);
      setState({
        phase: "error",
        message:
          parsed?.error ??
          `The server responded with an unexpected format (HTTP ${response.status}). Nothing was exported.`,
      });
      return;
    }

    // Confirmed success: download the CSV, then refresh the server data.
    const auditMissing =
      response.headers.get(AUDIT_MISSING_HEADER) === "1";
    const rowCountHeader = response.headers.get(ROW_COUNT_HEADER);
    const rowCountValue =
      rowCountHeader === null ? Number.NaN : Number(rowCountHeader);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename =
      /filename="([^"]+)"/.exec(disposition)?.[1] ?? "shipment-export.csv";

    // Read the body fully, then save it through a temporary object URL.
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);

    setState({
      phase: "done",
      rowCount: Number.isFinite(rowCountValue) ? rowCountValue : null,
      auditMissing,
    });
    router.refresh();
  }, [router, shipmentId]);

  if (state.phase === "done") {
    return (
      <div className="flex flex-col gap-1">
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          CSV exported
          {state.rowCount !== null ? ` — ${state.rowCount} data row${state.rowCount === 1 ? "" : "s"}` : ""}.
          {" "}The shipment is now EXPORTED; the page has been refreshed.
        </p>
        {state.auditMissing ? (
          <p
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            The CSV was downloaded, but the audit entry of the export could
            not be written and needs backfilling.
          </p>
        ) : null}
      </div>
    );
  }

  const exporting = state.phase === "exporting";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonPrimary}
          disabled={exporting || disabledReason !== null}
          title={disabledReason ?? undefined}
          onClick={() => void exportCsv()}
        >
          {exporting ? "Exporting…" : "Download export CSV"}
        </button>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
          One-shot: exporting stamps the shipment as EXPORTED permanently.
        </span>
      </div>

      {disabledReason !== null ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Export unavailable: {disabledReason}
        </p>
      ) : null}

      {state.phase === "error" ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.message}
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
