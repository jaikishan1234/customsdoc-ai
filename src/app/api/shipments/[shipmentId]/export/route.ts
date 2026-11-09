/**
 * GET /api/shipments/[shipmentId]/export — manager-only CSV export Route
 * Handler.
 *
 * Thin, client-safe boundary over `evaluateExportReadiness()`,
 * `buildShipmentCsv()`, `stampShipmentExported()` and `appendExportAudit()`
 * (src/lib/services/export-service.ts): it duplicates no eligibility,
 * encoding or persistence logic. It authenticates, enforces the
 * MANAGER-ONLY authorization (executives are explicitly not permitted to
 * export), validates request framing, and maps the service's typed results
 * to HTTP statuses.
 *
 * Write order (neon-http, no transactions — partial-success discipline):
 *   1. permission evaluation (read-only);
 *   2. CSV construction (read-only) — built BEFORE any write so an encoding
 *      failure leaves the shipment untouched;
 *   3. the guarded one-shot stamp `APPROVED -> EXPORTED` (exportedAt +
 *      exportedBy set together as CHECK `shipments_export_consistency`
 *      requires); a concurrent export or any other transition matches zero
 *      rows, so a second successful export is impossible;
 *   4. the EXPORT_COMPLETED audit row (row count + stamped instant, never
 *      field values).
 *
 * A failed audit write does not fail the export: the CSV response cannot
 * carry a JSON warning body, so the gap is reported via the dedicated
 * `X-Audit-Missing: 1` response header plus a server log entry — the
 * response never claims a complete trail that does not exist. Recovery for
 * that state is manual backfill (existing audit-gap convention); nothing is
 * rolled back or retried.
 *
 * Privacy: failures log only identifiers the route already owns (shipment
 * id) and error type names — never CSV content, snapshots, checksums or
 * credentials. Successful responses carry the CSV bytes; the only outside
 * identifier is the shipment reference, which is the document's own
 * business key (DB-validated `^SHP-[0-9]{4,10}$`, filename-safe).
 *
 * Status mapping:
 *   200 CSV exported (X-Audit-Missing: 1 flags a partial success)
 *   401 unauthenticated        (session ended mid-request)
 *   403 role not DOCUMENTATION_MANAGER
 *   404 shipment not found (incl. malformed UUIDs)
 *   409 export blocked (shipment not APPROVED / already exported, pending
 *      decision, no approved decision, stale evidence, unresolved readiness
 *      blockers, or the status changed between evaluation and stamping)
 *   500 unexpected server failure
 *   503 database unavailable (nothing was written or exported)
 */

import { USER_ROLES, type UserRole } from "@/lib/auth";
import {
  appendExportAudit,
  buildShipmentCsv,
  evaluateExportReadiness,
  SHIPMENT_REFERENCE_PATTERN,
  stampShipmentExported,
  type ExportBlocker,
  type ExportEvaluation,
} from "@/lib/services/export-service";
import type { AuditActor } from "@/lib/services/audit-service";
import { getSession, hasRole } from "@/lib/server/auth";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Export is a manager decision — executives never finalize an export. */
const EXPORT_ROLES: ReadonlyArray<UserRole> = [USER_ROLES.DOCUMENTATION_MANAGER];

/** Response header name set on a 200 CSV response when the audit write
 * failed (the CSV body cannot carry a JSON warning). The UI reads it. */
const AUDIT_MISSING_HEADER = "X-Audit-Missing";

/* --- Wire contract (server -> client). Type-only exports; no logic here
 * may be (or is) imported by client components — they import TYPES only. */

/** Every failure body: one client-safe `error` string plus the structured
 * blocker (client-safe constants only — never ids/checksums/values). */
export interface ExportErrorBody {
  error: string;
  /** Present for 409 blocks: the structured export blocker. */
  exportBlocker?: ExportBlocker;
}

/** Map an export blocker to one client-safe message (constants only). */
const blockerMessage = (blocker: ExportBlocker): string => {
  switch (blocker.code) {
    case "shipment_status":
      return blocker.detail === "already_exported"
        ? "This shipment has already been exported — the export stamp is one-shot history and records stay final."
        : "This shipment must be APPROVED before it can be exported.";
    case "no_approved_decision":
      return "No approved decision exists for this shipment.";
    case "decision_pending":
      return "This shipment has a pending approval decision — approve (or reject) it before exporting.";
    case "snapshot_stale":
      return "The approved decision's evidence has changed since it was captured (stale snapshot). The decision must be re-decided before exporting.";
    case "freshness_unavailable":
      return "The decision's evidence could not be re-verified right now — refresh the shipment and try again.";
    case "not_ready":
      return "The shipment is not ready for export — resolve the readiness blockers first.";
  }
};

/** Map a non-`ready` evaluation to its HTTP response. Exhaustive — no
 * invented variants. */
const mapEvaluation = (
  outcome: Exclude<ExportEvaluation, { status: "ready" }>,
): Response => {
  switch (outcome.status) {
    case "not_found":
      return Response.json(
        { error: "Shipment not found." } satisfies ExportErrorBody,
        { status: 404 },
      );
    case "unavailable":
      console.error("[export-route] Database unavailable during export.");
      return Response.json(
        {
          error:
            "The service is temporarily unavailable. Nothing was exported. Please try again.",
        } satisfies ExportErrorBody,
        { status: 503 },
      );
    case "blocked":
      return Response.json(
        {
          error: blockerMessage(outcome.blocker),
          exportBlocker: outcome.blocker,
        } satisfies ExportErrorBody,
        { status: 409 },
      );
  }
};

/** Safe CSV filename: the reference is DB-validated `^SHP-[0-9]{4,10}$` and
 * the stamp is compact UTC time — both filename-safe without quoting. */
const csvFilename = (reference: string, exportedAt: Date): string => {
  const safeReference = SHIPMENT_REFERENCE_PATTERN.test(reference)
    ? reference
    : "shipment";
  const stamp = exportedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${safeReference}-export-${stamp}.csv`;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ shipmentId: string }> },
): Promise<Response> {
  // --- 1. Server-side session & role (explicit 40x; no redirects) ----------
  const session = await getSession();
  if (!session?.user?.id) {
    return Response.json(
      { error: "You must be signed in to export shipments." } satisfies ExportErrorBody,
      { status: 401 },
    );
  }
  if (!hasRole(session, EXPORT_ROLES)) {
    return Response.json(
      {
        error: "Only documentation managers may export shipments.",
      } satisfies ExportErrorBody,
      { status: 403 },
    );
  }

  // --- 2. Structural UUID validation (404 without a DB round-trip) ---------
  const { shipmentId } = await params;
  const sid = shipmentId.trim();
  if (!UUID_PATTERN.test(sid)) {
    return Response.json(
      { error: "Shipment not found." } satisfies ExportErrorBody,
      { status: 404 },
    );
  }

  try {
    // --- 3. Permission -------------------------------------------------------
    const evaluation = await evaluateExportReadiness(sid);
    if (evaluation.status !== "ready") {
      return mapEvaluation(evaluation);
    }

    // --- 4. CSV (read-only, built before ANY write) ---------------------------
    const built = await buildShipmentCsv(sid);
    if (built.status === "not_found") {
      return Response.json(
        { error: "Shipment not found." } satisfies ExportErrorBody,
        { status: 404 },
      );
    }
    if (built.status === "no_approved_decision") {
      return Response.json(
        {
          error: "No approved decision exists for this shipment.",
        } satisfies ExportErrorBody,
        { status: 409 },
      );
    }
    if (built.status === "unavailable") {
      console.error("[export-route] CSV construction failed.");
      return Response.json(
        {
          error:
            "The service is temporarily unavailable. Nothing was exported. Please try again.",
        } satisfies ExportErrorBody,
        { status: 503 },
      );
    }

    // --- 5. One-shot stamp (single guarded statement) -------------------------
    const actorId: AuditActor = session.user.id;
    const stamp = await stampShipmentExported(sid, session.user.id);
    if (stamp.status === "unavailable") {
      return Response.json(
        {
          error:
            "The service is temporarily unavailable. Nothing was exported. Please try again.",
        } satisfies ExportErrorBody,
        { status: 503 },
      );
    }
    if (stamp.status === "no_longer_approved") {
      return Response.json(
        {
          error:
            stamp.currentStatus === "EXPORTED"
              ? "This shipment has already been exported — the export stamp is one-shot history and records stay final."
              : `The shipment's status changed during the export (now ${stamp.currentStatus ?? "unknown"}). Refresh the shipment and try again.`,
        } satisfies ExportErrorBody,
        { status: 409 },
      );
    }

    // --- 6. Audit (partial success reported via header, never claimed) --------
    const auditWritten = await appendExportAudit(
      {
        shipmentId: sid,
        reference: built.reference,
        rowCount: built.rowCount,
        exportedAt: stamp.exportedAt,
      },
      actorId,
    );

    // --- 7. CSV response ------------------------------------------------------
    const headers = new Headers();
    headers.set("Content-Type", "text/csv; charset=utf-8");
    headers.set(
      "Content-Disposition",
      `attachment; filename="${csvFilename(built.reference, stamp.exportedAt)}"`,
    );
    headers.set("Cache-Control", "no-store");
    headers.set("X-Row-Count", String(built.rowCount));
    if (!auditWritten) {
      headers.set(AUDIT_MISSING_HEADER, "1");
    }
    // Explicitly UTF-8 bytes.
    return new Response(new TextEncoder().encode(built.csv), {
      status: 200,
      headers,
    });
  } catch (error) {
    // Services are non-throwing by contract; an exception here is a route-
    // side bug. Report 500 without leaking internals.
    console.error(
      "[export-route] Unexpected failure " +
        `(type=${error instanceof Error ? error.name : typeof error}).`,
    );
    return Response.json(
      {
        error:
          "An unexpected server error occurred. Nothing was exported. Please try again.",
      } satisfies ExportErrorBody,
      { status: 500 },
    );
  }
}
