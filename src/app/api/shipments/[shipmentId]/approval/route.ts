/**
 * POST /api/shipments/[shipmentId]/approval — manager-only approval or
 * rejection Route Handler (stage 2 backend; no approval UI, no CSV export).
 *
 * Thin, client-safe boundary over `approveShipment()` / `rejectShipment()`
 * (src/lib/services/approval-service.ts): it duplicates no readiness or
 * persistence logic. It authenticates, enforces the MANAGER-ONLY
 * authorization, validates request framing, and maps the service's typed
 * results to HTTP statuses.
 *
 * Body (JSON object):
 *   { "decision": "approve" }
 *   { "decision": "reject", "note": "why the shipment is sent back" }
 * The note is mandatory for rejection (1-500 characters) and ignored for
 * approval. Approval itself carries no values: readiness is re-evaluated
 * from the database on every request.
 *
 * Privacy/logging: failures log only identifiers the route already owns
 * (shipment id) and constant messages. Responses never carry checksums,
 * storage keys, actor ids or extracted values — blockers are type/field-level
 * facts only.
 *
 * Status mapping:
 *   200 decision applied (auditWriteFailed flags a partial success)
 *   400 malformed body / invalid or missing rejection note
 *   401 unauthenticated        (session ended mid-request)
 *   403 role not DOCUMENTATION_MANAGER
 *   404 shipment not found (incl. malformed UUIDs)
 *   409 not ready (exact blockers), status conflict, or an existing live
 *       approval/rejection decision
 *   503 database unavailable (decision not applied)
 */

import { USER_ROLES, type UserRole } from "@/lib/auth";
import type { ApprovalSnapshot } from "@/lib/db/schema";
import {
  approveShipment,
  rejectShipment,
  type ApprovalBlocker,
  type ApprovalDecisionOutcome,
} from "@/lib/services/approval-service";
import { getSession, hasRole } from "@/lib/server/auth";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Approvals and rejections are manager decisions. */
const DECISION_ROLES: ReadonlyArray<UserRole> = [
  USER_ROLES.DOCUMENTATION_MANAGER,
];

const jsonError = (status: number, error: string): Response =>
  Response.json({ error } satisfies ApprovalErrorBody, { status });

/* --- Wire contract (server -> client). Type-only exports. ---------------- */

/** Snapshot provenance, deliberately without checksums or ids. */
export interface ApprovalSnapshotSummary {
  documentCount: number;
  extractionCount: number;
  checkRunKey: string | null;
  capturedAt: string;
}

/** The `approved` (200) body. */
export interface ApprovalApprovedBody {
  status: "approved";
  approvalId: string;
  shipmentStatus: "APPROVED";
  snapshot: ApprovalSnapshotSummary;
  /** True: the APPROVAL_APPROVED audit write failed — backfill needed. */
  auditWriteFailed: boolean;
  auditMissing: boolean;
  warnings: readonly string[];
}

/** The `rejected` (200) body. */
export interface ApprovalRejectedBody {
  status: "rejected";
  approvalId: string;
  shipmentStatus: "REJECTED";
  /** True: the APPROVAL_REJECTED audit write failed — backfill needed. */
  auditWriteFailed: boolean;
  auditMissing: boolean;
  warnings: readonly string[];
}

/** Every failure body: client-safe `error` plus optional structured facts. */
export interface ApprovalErrorBody {
  error: string;
  /** Present for 409 readiness failures: the exact blocking facts. */
  blockers?: readonly ApprovalBlocker[];
  /** Present when the current shipment status refused the transition. */
  shipmentStatus?: string;
  /** Present when a live decision already exists. */
  decidedStatus?: "PENDING" | "APPROVED";
}

export type ApprovalResponse =
  | ApprovalApprovedBody
  | ApprovalRejectedBody
  | ApprovalErrorBody;

const snapshotSummary = (snapshot: ApprovalSnapshot): ApprovalSnapshotSummary => ({
  documentCount: snapshot.documents.length,
  extractionCount: snapshot.extractions.length,
  checkRunKey: snapshot.checkRunKey ?? null,
  capturedAt: snapshot.capturedAt,
});

/** Map a non-success outcome to its HTTP response. Exhaustive. */
const mapOutcome = (
  outcome: Exclude<
    ApprovalDecisionOutcome,
    { status: "approved" } | { status: "rejected" }
  >,
): Response => {
  switch (outcome.status) {
    case "not_found":
      return jsonError(404, "Shipment not found.");
    case "not_ready":
      return Response.json(
        {
          error:
            "The shipment is not ready for approval. Resolve the listed blockers and try again.",
          blockers: outcome.blockers,
        } satisfies ApprovalErrorBody,
        { status: 409 },
      );
    case "invalid_status":
      return Response.json(
        {
          error:
            "The shipment's current status does not allow this decision. Refresh the shipment and try again.",
          shipmentStatus: outcome.shipmentStatus,
        } satisfies ApprovalErrorBody,
        { status: 409 },
      );
    case "already_decided":
      return Response.json(
        {
          error:
            outcome.decidedStatus === "APPROVED"
              ? "This shipment already has a live approval."
              : "This shipment already has a pending approval decision.",
          decidedStatus: outcome.decidedStatus,
        } satisfies ApprovalErrorBody,
        { status: 409 },
      );
    case "invalid_note":
      return jsonError(
        400,
        "A rejection note is required (1-500 characters).",
      );
    case "unavailable":
      console.error(
        "[approval-route] Database unavailable during an approval decision.",
      );
      return jsonError(
        503,
        "The service is temporarily unavailable. The decision may not have been applied — refresh the shipment before retrying.",
      );
  }
};

type DecisionBody = { decision: "approve" } | { decision: "reject"; note: unknown };

/** Structural body validation only; the service validates the note itself. */
const parseDecisionBody = (body: unknown): DecisionBody | null => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const payload = body as Record<string, unknown>;
  if (payload.decision === "approve") {
    return { decision: "approve" };
  }
  if (payload.decision === "reject") {
    return { decision: "reject", note: payload.note };
  }
  return null;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ shipmentId: string }> },
): Promise<Response> {
  // --- 1. Server-side session & role (explicit 40x; no redirects) ----------
  const session = await getSession();
  if (!session?.user?.id) {
    return jsonError(401, "You must be signed in to decide an approval.");
  }
  if (!hasRole(session, DECISION_ROLES)) {
    return jsonError(
      403,
      "Only documentation managers may approve or reject shipments.",
    );
  }

  // --- 2. Structural UUID validation (404 without a DB round-trip) ---------
  const { shipmentId } = await params;
  const sid = shipmentId.trim();
  if (!UUID_PATTERN.test(sid)) {
    return jsonError(404, "Shipment not found.");
  }

  // --- 3. Request framing ---------------------------------------------------
  const body: unknown = await request.json().catch(() => null);
  const decision = parseDecisionBody(body);
  if (!decision) {
    return jsonError(
      400,
      'The request body must be a JSON object with "decision": "approve" or "reject".',
    );
  }

  // --- 4. Delegate the entire workflow to the service -----------------------
  const result =
    decision.decision === "approve"
      ? await approveShipment(sid, session.user.id)
      : await rejectShipment(sid, decision.note, session.user.id);

  if (result.status === "approved") {
    const warnings: string[] = [];
    if (result.auditWriteFailed) {
      warnings.push(
        "The shipment was approved, but its audit entry could not be written and needs backfilling.",
      );
    }
    return Response.json(
      {
        status: "approved",
        approvalId: result.approvalId,
        shipmentStatus: "APPROVED" as const,
        snapshot: snapshotSummary(result.snapshot),
        auditWriteFailed: result.auditWriteFailed,
        auditMissing: warnings.length > 0,
        warnings,
      } satisfies ApprovalApprovedBody,
      { status: 200 },
    );
  }

  if (result.status === "rejected") {
    const warnings: string[] = [];
    if (result.auditWriteFailed) {
      warnings.push(
        "The shipment was rejected, but its audit entry could not be written and needs backfilling.",
      );
    }
    return Response.json(
      {
        status: "rejected",
        approvalId: result.approvalId,
        shipmentStatus: "REJECTED" as const,
        auditWriteFailed: result.auditWriteFailed,
        auditMissing: warnings.length > 0,
        warnings,
      } satisfies ApprovalRejectedBody,
      { status: 200 },
    );
  }

  return mapOutcome(result);
}
