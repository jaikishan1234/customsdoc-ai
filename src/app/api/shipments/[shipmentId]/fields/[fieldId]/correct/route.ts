/**
 * POST /api/shipments/[shipmentId]/fields/[fieldId]/correct — human field
 * correction Route Handler.
 *
 * Thin, client-safe boundary over `correctExtractedField()`
 * (src/lib/services/correction-service.ts): it does NOT duplicate any
 * eligibility, validation, persistence or re-evaluation logic; it
 * authenticates, enforces the MANAGER-ONLY authorization (executives are
 * explicitly not permitted to submit corrections), validates request
 * framing, and maps the service's typed results to HTTP statuses.
 *
 * Authorization: `getSession()` + `hasRole()` per the auth helpers' Route
 * Handler guidance — explicit 40x responses, no redirects. Only
 * DOCUMENTATION_MANAGER may submit corrections anywhere this workflow
 * appears; the UI additionally hides correction actions from executives.
 *
 * Privacy/logging: failures log only error type names and identifiers the
 * route already owns (shipment/field ids). Never request bodies, stack
 * traces, SQL/storage details. Responses carry client-safe strings only.
 *
 * Status mapping:
 *   200 correction applied (auditWriteFailed flags a partial success)
 *   401 unauthenticated        (session ended mid-request)
 *   403 role not DOCUMENTATION_MANAGER
 *   404 shipment or field not found (incl. malformed UUIDs)
 *   400 invalid value / invalid reason / unchanged value
 *   409 field not correctable (document inactive, attempt superseded or
 *      not completed) or the shipment was already exported (exported
 *      records are final)
 *   500 unexpected server failure
 *   503 database unavailable (correction not applied)
 */

import { USER_ROLES, type UserRole } from "@/lib/auth";
import {
  correctExtractedField,
  type CorrectionBlocker,
  type CorrectFieldOutcome,
} from "@/lib/services/correction-service";
import {
  summarizeApprovalInvalidation,
  type ApprovalInvalidationSummary,
} from "@/lib/services/approval-invalidation-service";
import { getSession, hasRole } from "@/lib/server/auth";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Corrections are a manager decision — executives never submit them. */
const CORRECT_ROLES: ReadonlyArray<UserRole> = [USER_ROLES.DOCUMENTATION_MANAGER];

/** Uniform client-safe JSON error responses (extract-route convention). */
const jsonError = (status: number, error: string): Response =>
  Response.json({ error } satisfies CorrectionErrorBody, { status });

/* --- Wire contract (server -> client). Type-only exports; no logic here
 * may be (or is) imported by client components — they import TYPES only. */

/** Post-correction discrepancy re-evaluation, as reported to the client. */
export interface CorrectionCrossCheckBody {
  status: "applied" | "skipped_concurrent" | "not_found" | "unavailable";
  /** Present only for `applied` runs: convergence counts. */
  discrepanciesCreated?: number;
  discrepanciesUpdated?: number;
  discrepanciesObsoleted?: number;
  discrepanciesRecheckPending?: number;
  /** > 0: an audit write inside the re-evaluation needs manual backfill. */
  auditWritesFailed?: number;
  /** Additive: approvals the re-evaluation retired (a discrepancy became
   * OPEN or RECHECK_PENDING); normally 0 or 1. */
  approvalsInvalidated?: number;
  /** True only when one of those retirements' audit writes failed. */
  approvalInvalidationAuditFailed?: boolean;
}

/** The `corrected` (200) body. */
export interface CorrectionSuccessBody {
  status: "corrected";
  correctionId: string;
  /** The field's review state is now CORRECTED. */
  reviewStatus: "CORRECTED";
  /** True: the FIELD_CORRECTED audit write failed — manual backfill needed. */
  auditWriteFailed: boolean;
  crossCheck: CorrectionCrossCheckBody;
  /** Additive: the correction changed the evidence a live approval decision
   * was frozen on, so that decision was invalidated (or none was live). */
  approvalInvalidation: ApprovalInvalidationSummary;
  /** True when any audit write for this correction needs backfilling. */
  auditMissing: boolean;
  /** Client-safe warnings for partial-success states (empty when none). */
  warnings: readonly string[];
}

/** Every failure body: one client-safe `error` string and nothing else. */
export interface CorrectionErrorBody {
  error: string;
}

export type CorrectionResponse = CorrectionSuccessBody | CorrectionErrorBody;

/** Sanitized blocker -> client-safe message (constants; never raw details). */
const blockerMessage = (reason: CorrectionBlocker): string => {
  switch (reason) {
    case "document_inactive":
      return "This field belongs to a superseded document version and can no longer be corrected.";
    case "attempt_superseded":
      return "This field belongs to a superseded extraction attempt and can no longer be corrected. Correct the field of the document's current attempt instead.";
    case "attempt_not_completed":
      return "The current extraction attempt has not completed, so there is no confirmed value to correct yet. Run extraction first.";
    case "shipment_exported":
      return "This shipment has already been exported — the exported CSV is final and can no longer be corrected.";
  }
};

/** Map a non-`success` service outcome to its HTTP response. Exhaustive —
 * no invented variants. */
const mapOutcome = (
  outcome: Exclude<CorrectFieldOutcome, { status: "success" }>,
): Response => {
  switch (outcome.status) {
    case "not_found":
      return jsonError(404, "Shipment or extracted field not found.");
    case "field_not_correctable":
      return jsonError(409, blockerMessage(outcome.reason));
    case "invalid_value":
      return jsonError(
        400,
        "The corrected value is invalid for this field type: numeric fields need a plain decimal number with at most 4 decimals within the storage precision, integer fields a non-negative whole number, date fields an ISO date (YYYY-MM-DD) and text fields 1-500 characters.",
      );
    case "invalid_reason":
      return jsonError(400, "A correction reason is required (1-500 characters).");
    case "unchanged_value":
      return jsonError(
        400,
        "The submitted value equals the field's current value (original extraction or latest correction) — nothing to correct.",
      );
    case "unavailable":
      console.error(
        "[correct-route] Database unavailable during field correction.",
      );
      return jsonError(
        503,
        "The service is temporarily unavailable. The correction was not applied. Please try again.",
      );
  }
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ shipmentId: string; fieldId: string }> },
): Promise<Response> {
  // --- 1. Server-side session & role (explicit 40x; no redirects) ----------
  const session = await getSession();
  if (!session?.user?.id) {
    return jsonError(401, "You must be signed in to submit corrections.");
  }
  if (!hasRole(session, CORRECT_ROLES)) {
    return jsonError(
      403,
      "Only documentation managers may submit field corrections.",
    );
  }

  // --- 2. Structural UUID validation (404 without a DB round-trip) ---------
  const { shipmentId, fieldId } = await params;
  const sid = shipmentId.trim();
  const fid = fieldId.trim();
  if (!UUID_PATTERN.test(sid) || !UUID_PATTERN.test(fid)) {
    return jsonError(404, "Shipment or extracted field not found.");
  }

  // --- 3. Request framing: JSON object with the two required strings.-------
  // Strict type-and-shape validation happens in the service; here only
  // non-JSON or non-object bodies are rejected early as 400.
  const body: unknown = await request.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonError(400, "The request body must be a JSON object.");
  }

  // --- 4. Delegate the entire workflow to the service -----------------------
  const payload = body as Record<string, unknown>;
  const result = await correctExtractedField(
    sid,
    fid,
    payload.correctedValue,
    payload.reason,
    session.user.id,
  );

  if (result.status !== "success") {
    return mapOutcome(result);
  }

  const { crossCheck } = result;
  const crossCheckBody: CorrectionCrossCheckBody =
    crossCheck.status === "applied"
      ? {
          status: "applied",
          discrepanciesCreated: crossCheck.summary.discrepanciesCreated,
          discrepanciesUpdated: crossCheck.summary.discrepanciesUpdated,
          discrepanciesObsoleted: crossCheck.summary.discrepanciesObsoleted,
          discrepanciesRecheckPending:
            crossCheck.summary.discrepanciesRecheckPending,
          auditWritesFailed: crossCheck.summary.auditWritesFailed,
          approvalsInvalidated: crossCheck.summary.approvalsInvalidated,
          approvalInvalidationAuditFailed:
            crossCheck.summary.approvalInvalidationAuditFailed,
        }
      : crossCheck;
  const approvalInvalidation = summarizeApprovalInvalidation(
    result.approvalInvalidation,
  );

  // Additive, machine-readable audit gap reporting: the business result stays
  // successful, but the response never implies the trail is complete.
  const auditWarnings: string[] = [];
  if (result.auditWriteFailed) {
    auditWarnings.push(
      "The correction was saved, but its audit entry could not be written and needs backfilling.",
    );
  }
  const crossCheckAuditFailures =
    result.crossCheck.status === "applied"
      ? result.crossCheck.summary.auditWritesFailed
      : 0;
  if (crossCheckAuditFailures > 0) {
    auditWarnings.push(
      `The discrepancy re-evaluation finished, but ${crossCheckAuditFailures} audit ${crossCheckAuditFailures === 1 ? "entry" : "entries"} could not be written and ${crossCheckAuditFailures === 1 ? "needs" : "need"} backfilling.`,
    );
  }
  if (approvalInvalidation.auditWriteFailed) {
    auditWarnings.push(
      "The shipment's approval decision was invalidated because of this correction, but its audit entry could not be written and needs backfilling.",
    );
  }

  return Response.json(
    {
      status: "corrected",
      correctionId: result.correctionId,
      reviewStatus: "CORRECTED" as const,
      auditWriteFailed: result.auditWriteFailed,
      crossCheck: crossCheckBody,
      approvalInvalidation,
      auditMissing: auditWarnings.length > 0,
      warnings: auditWarnings,
    } satisfies CorrectionSuccessBody,
    { status: 200 },
  );
}
