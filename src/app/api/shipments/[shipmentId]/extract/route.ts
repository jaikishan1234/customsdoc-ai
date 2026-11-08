/**
 * POST /api/shipments/[shipmentId]/extract — extraction trigger Route Handler.
 *
 * Thin, client-safe boundary over `runExtractionForShipment()`
 * (src/lib/services/extraction-service.ts): it does NOT duplicate any
 * eligibility, attempt-row, provider, validation or persistence logic; it
 * authenticates, enforces basic request framing, fences accidental duplicate
 * submissions, and maps the service's typed results to HTTP statuses.
 *
 * Runtime: `cacheComponents` is enabled and uses the Node.js runtime by
 * default; the `runtime` segment export is disallowed (no edge handler is
 * possible here) — same configuration as the document upload route.
 *
 * Duplicate submissions (honest disclosure — NOT exactly-once):
 * - A per-instance module-scope in-flight set keyed by shipment id suppresses
 *   accidental double clicks / duplicate pushes to the SAME process while a
 *   run is still executing (docs are processed sequentially, so a run lasts
 *   seconds to minutes). It is NOT a global lock: on multi-instance
 *   deployments two instances can run concurrently — correctness is carried
 *   by the SERVICE instead (per-document `(document_id, attempt)` unique
 *   index + max(attempt) freshness rule), never by this route.
 * - Every subsequent run simply creates attempt N+1 per document; re-running
 *   after a failure is therefore always safe.
 *
 * Latency & request-duration limit (honest disclosure — synchronous):
 * - This handler stays synchronous: it awaits the full sequential run and
 *   then returns the per-document outcomes in one JSON body. No background
 *   jobs / queues are introduced in this step.
 * - Each document costs a storage retrieval + one Gemini request; a
 *   shipment's total wall time grows linearly with its active-document count
 *   and can exceed short platform request-duration limits (e.g. serverless
 *   execution timeouts). If the runtime terminates the request mid-run, the
 *   client sees a network error while the server keeps whatever state it had
 *   written; that state is recoverable — the max(attempt) rule keeps stale
 *   rows out of downstream use and a retry continues cleanly with attempt
 *   N+1. Clients SHOULD use generous timeouts for this endpoint.
 *
 * Security/logging: on failures this route logs only error type names and
 * identifiers it already owns (shipmentId). It never logs request bodies,
 * stack traces, SQL/provider errors, storage keys, checksums or extracted
 * document contents, and no such data appears in responses.
 *
 * Status mapping:
 *   200 started (per-document outcomes in the body; partial success is 200)
 *   401 unauthenticated      (session ended mid-request)
 *   403 role not permitted
 *   404 shipment not found   (including non-UUID shipment ids)
 *   409 status e.g. REVIEW/APPROVED blocks extraction; no active documents;
 *      duplicate submission to this instance while a run is executing
 *   500 server-side lifecycle write failure
 *   503 database unavailable
 */

import { USER_ROLES } from "@/lib/auth";
import type { DocumentEntryType } from "@/lib/services/document-service";
import {
  runExtractionForShipment,
  type DocumentExtractionOutcome,
  type RunExtractionResult,
} from "@/lib/services/extraction-service";
import { getSession, hasRole } from "@/lib/server/auth";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXTRACT_ROLES = [
  USER_ROLES.DOCUMENTATION_EXECUTIVE,
  USER_ROLES.DOCUMENTATION_MANAGER,
] as const;

/** Uniform client-safe JSON error responses (upload-route convention). */
const jsonError = (status: number, error: string): Response =>
  Response.json({ error } satisfies ExtractRunErrorBody, { status });

/* --- Wire contract (server -> client). Type-only exports; no logic here
 * may be (or is) imported by client components — they import TYPES only. */

/** One per-document outcome as sent in the `started` (200) body. */
export type ExtractDocumentOutcomeBody =
  | {
      status: "completed";
      documentId: string;
      documentType: DocumentEntryType;
      attempt: number;
      fieldCount: number;
      missingRequiredKeys: readonly string[];
      warning?: string;
    }
  | {
      status: "supersede_incomplete";
      documentId: string;
      documentType: DocumentEntryType;
      attempt: number;
      supersededAttemptCount: number;
      warning: string;
    }
  | {
      status: "failed";
      documentId: string;
      documentType: DocumentEntryType;
      attempt: number;
      /** Sanitized error-code constant (never a raw provider message). */
      errorCode: string;
    }
  | {
      status: "conflict";
      documentId: string;
      documentType: DocumentEntryType;
    }
  | {
      status: "skipped";
      documentId: string;
      documentType: DocumentEntryType;
      reason: "daily_ceiling" | "daily_count_unavailable";
    };

/** The `started` (200) body. */
export interface ExtractRunSuccessBody {
  status: "started";
  flippedToProcessing: boolean;
  summary: {
    completed: number;
    failed: number;
    conflict: number;
    skipped: number;
  };
  documents: readonly ExtractDocumentOutcomeBody[];
  /** True when at least one audit write for this run needs backfilling. */
  auditMissing: boolean;
  /** Client-safe warnings for partial-success states (empty when none). */
  warnings: readonly string[];
  /** Per-run cross-document discrepancy check result (additive). A failure
   * here does not affect the per-document outcomes above. */
  crossCheck:
    | {
        status: "applied";
        discrepanciesCreated: number;
        discrepanciesUpdated: number;
        discrepanciesObsoleted: number;
        /** > 0 means evidence snapshots need manual audit backfill. */
        auditWritesFailed: number;
      }
    | { status: "deferred" }
    | { status: "failed" };
}

/** Every failure body: one client-safe `error` string and nothing else. */
export interface ExtractRunErrorBody {
  error: string;
}

export type ExtractRunResponse = ExtractRunSuccessBody | ExtractRunErrorBody;

/**
 * Per-instance in-flight fence (best-effort duplicate protection — see the
 * module header for what this deliberately does NOT guarantee).
 */
const inFlightExtractions = new Set<string>();

/**
 * Client-safe projection of one per-document outcome. The service's outcome
 * variants are all safe for clients by design (ids, counts, document types,
 * sanitized error codes, catalog key NAMES) — this mapping exists to stay
 * explicit and exhaustive, and to attach client-facing warnings for
 * partial-success states.
 */
/**
 * Client-safe audit-gap summary for one run: `auditMissing` is true whenever
 * any reported audit write did not land, and every gap gets one fixed
 * warning string (no ids, no raw errors).
 */
const summarizeAuditGaps = (
  outcomes: readonly DocumentExtractionOutcome[],
  crossCheck: ExtractRunSuccessBody["crossCheck"],
): { auditMissing: boolean; warnings: string[] } => {
  const warnings: string[] = [];

  const completedAuditFailed = outcomes.filter(
    (outcome) => outcome.status === "completed_audit_failed",
  ).length;
  if (completedAuditFailed > 0) {
    warnings.push(
      `${completedAuditFailed} audit ${completedAuditFailed === 1 ? "entry" : "entries"} for completed extraction${completedAuditFailed === 1 ? "" : "s"} could not be written and ${completedAuditFailed === 1 ? "needs" : "need"} backfilling.`,
    );
  }

  const failedAuditMissing = outcomes.filter(
    (outcome) => outcome.status === "failed" && outcome.auditMissing === true,
  ).length;
  if (failedAuditMissing > 0) {
    warnings.push(
      `${failedAuditMissing} failed attempt${failedAuditMissing === 1 ? "" : "s"} could not be audited — the audit ${failedAuditMissing === 1 ? "entry needs" : "entries need"} backfilling.`,
    );
  }

  if (crossCheck.status === "applied" && crossCheck.auditWritesFailed > 0) {
    const failed = crossCheck.auditWritesFailed;
    warnings.push(
      `The discrepancy re-evaluation finished, but ${failed} audit ${failed === 1 ? "entry" : "entries"} could not be written and ${failed === 1 ? "needs" : "need"} backfilling.`,
    );
  }

  return { auditMissing: warnings.length > 0, warnings };
};

const projectOutcome = (
  outcome: DocumentExtractionOutcome,
): ExtractDocumentOutcomeBody => {
  switch (outcome.status) {
    case "completed":
      return {
        status: "completed" as const,
        documentId: outcome.documentId,
        documentType: outcome.documentType,
        attempt: outcome.attempt,
        fieldCount: outcome.fieldCount,
        missingRequiredKeys: outcome.missingRequiredKeys,
      };
    case "completed_audit_failed":
      return {
        status: "completed" as const,
        documentId: outcome.documentId,
        documentType: outcome.documentType,
        attempt: outcome.attempt,
        fieldCount: outcome.fieldCount,
        missingRequiredKeys: outcome.missingRequiredKeys,
        warning: "Extracted, but its audit entry needs backfilling.",
      };
    case "supersede_incomplete":
      return {
        status: outcome.status,
        documentId: outcome.documentId,
        documentType: outcome.documentType,
        attempt: outcome.attempt,
        supersededAttemptCount: outcome.supersededAttemptCount,
        warning:
          "Partially applied: the previous extraction is retired, this one did not finish. Run extraction again to recover.",
      };
    case "failed":
      return {
        status: "failed" as const,
        documentId: outcome.documentId,
        documentType: outcome.documentType,
        attempt: outcome.attempt,
        errorCode: outcome.errorCode,
      };
    case "conflict":
      return {
        status: "conflict" as const,
        documentId: outcome.documentId,
        documentType: outcome.documentType,
      };
    case "skipped":
      return {
        status: "skipped" as const,
        documentId: outcome.documentId,
        documentType: outcome.documentType,
        reason: outcome.reason,
      };
  }
};

/** Aggregate counts for a compact summary alongside the per-document list. */
const summarize = (
  outcomes: readonly DocumentExtractionOutcome[],
): { completed: number; failed: number; conflict: number; skipped: number } => {
  let completed = 0;
  let failed = 0;
  let conflict = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    switch (outcome.status) {
      case "completed":
      case "completed_audit_failed":
        completed += 1;
        break;
      case "supersede_incomplete":
      case "failed":
        failed += 1;
        break;
      case "conflict":
        conflict += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
    }
  }
  return { completed, failed, conflict, skipped };
};

/**
 * Map a non-`started` service result to its HTTP response. Exhaustive over
 * {@link RunExtractionResult} minus `started` — no invented variants.
 */
const mapRunResult = (result: Exclude<RunExtractionResult, { status: "started" }>): Response => {
  switch (result.status) {
    case "unauthenticated":
      // Session ended between the route check and the service call.
      return jsonError(401, "You must be signed in to run extraction.");
    case "forbidden":
      return jsonError(
        403,
        "You do not have permission to run extraction on this shipment.",
      );
    case "shipment_not_found":
      return jsonError(404, "Shipment not found.");
    case "status_blocked":
      return jsonError(
        409,
        "Extraction is not available while the shipment is " +
          `${result.currentStatus}. It can run on DRAFT, PROCESSING or REJECTED shipments only.`,
      );
    case "no_documents":
      return jsonError(409, "Upload documents before running extraction.");
    case "unavailable":
      console.error("[extract-route] Database unavailable during extraction run.");
      return jsonError(
        503,
        "The service is temporarily unavailable. Please try again.",
      );
    case "status_update_failed":
      console.error(
        "[extract-route] Shipment PROCESSING transition write failed.",
      );
      return jsonError(
        500,
        "Something went wrong while starting the extraction. Please try again.",
      );
  }
};

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ shipmentId: string }> },
): Promise<Response> {
  // --- 1. Server-side session & role (explicit 40x; no redirects) ----------
  const session = await getSession();
  if (!session) {
    return jsonError(401, "You must be signed in to run extraction.");
  }
  if (!hasRole(session, EXTRACT_ROLES)) {
    return jsonError(
      403,
      "You do not have permission to run extraction on this shipment.",
    );
  }

  // --- 2. Structural shipment-id validation (uuid or nothing) --------------
  const { shipmentId } = await params;
  const id = shipmentId.trim();
  if (!UUID_PATTERN.test(id)) {
    return jsonError(404, "Shipment not found.");
  }

  // --- 3. Duplicate-submission fence (per-instance, best-effort) -----------
  // Best-effort only against accidental duplicates in THIS process; cross-
  // instance concurrency is intentionally NOT fenced here — the service's
  // per-document attempt uniqueness owns that correctness guarantee.
  if (inFlightExtractions.has(id)) {
    return jsonError(
      409,
      "An extraction for this shipment is already running. Please wait for it to finish.",
    );
  }
  inFlightExtractions.add(id);
  try {
    // --- 4. Delegate the entire lifecycle to the service -------------------
    // The service re-verifies session/roles server-side (defense in depth)
    // and awaits the full sequential run before this handler responds.
    const result = await runExtractionForShipment(id);
    if (result.status !== "started") {
      return mapRunResult(result);
    }
    const auditGaps = summarizeAuditGaps(result.outcomes, result.crossCheck);
    return Response.json(
      {
        status: "started" as const,
        flippedToProcessing: result.flippedToProcessing,
        summary: summarize(result.outcomes),
        documents: result.outcomes.map(projectOutcome),
        crossCheck: result.crossCheck,
        auditMissing: auditGaps.auditMissing,
        warnings: auditGaps.warnings,
      } satisfies ExtractRunSuccessBody,
      { status: 200 },
    );
  } catch (error) {
    // The service is typed not to throw, but a runtime abort (e.g. a platform
    // duration limit cancelling the request path) or an unexpected failure
    // must not leak internals. Note: the finally below clears the fence —
    // work may still be counted as neither claimed nor completed here.
    console.error(
      "[extract-route] Unhandled failure during extraction:",
      error instanceof Error ? error.name : "unknown error type",
    );
    return jsonError(
      500,
      "Something went wrong while running the extraction. Please try again.",
    );
  } finally {
    inFlightExtractions.delete(id);
  }
}
