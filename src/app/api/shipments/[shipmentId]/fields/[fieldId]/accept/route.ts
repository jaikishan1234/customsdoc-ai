/**
 * POST /api/shipments/[shipmentId]/fields/[fieldId]/accept — human field
 * acceptance Route Handler.
 *
 * Thin, client-safe boundary over `acceptExtractedField()`
 * (src/lib/services/field-review-service.ts): it duplicates no eligibility,
 * validation or persistence logic. It authenticates, enforces the
 * MANAGER-ONLY authorization (executives are explicitly not permitted to
 * accept values), validates request framing, and maps the service's typed
 * results to HTTP statuses.
 *
 * The request carries no body and no correction reason: accepting asserts the
 * ORIGINAL extraction snapshot is correct, so there is nothing to submit. A
 * value that needs a different number/date/text is a correction, not an
 * acceptance.
 *
 * Privacy/logging: failures log only error type names and identifiers the
 * route already owns (shipment/field ids). Never request bodies, stack
 * traces, SQL/storage details. Responses carry client-safe strings only.
 *
 * Status mapping:
 *   200 field accepted (auditWriteFailed flags a partial success)
 *   401 unauthenticated        (session ended mid-request)
 *   403 role not DOCUMENTATION_MANAGER
 *   404 shipment or field not found (incl. malformed UUIDs)
 *   400 the stored value is missing/invalid and cannot be accepted
 *   409 not acceptable right now (document inactive, attempt superseded or
 *      not completed, or the value was already accepted/corrected)
 *   500 unexpected server failure
 *   503 database unavailable (acceptance not applied)
 */

import { USER_ROLES, type UserRole } from "@/lib/auth";
import {
  acceptExtractedField,
  type AcceptFieldOutcome,
  type FieldAcceptBlocker,
} from "@/lib/services/field-review-service";
import { getSession, hasRole } from "@/lib/server/auth";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Acceptance is a manager decision — executives never accept values. */
const ACCEPT_ROLES: ReadonlyArray<UserRole> = [USER_ROLES.DOCUMENTATION_MANAGER];

/** Uniform client-safe JSON error responses (extract-route convention). */
const jsonError = (status: number, error: string): Response =>
  Response.json({ error } satisfies FieldAcceptErrorBody, { status });

/* --- Wire contract (server -> client). Type-only exports; no logic here
 * may be (or is) imported by client components — they import TYPES only. */

/** The `accepted` (200) body. */
export interface FieldAcceptSuccessBody {
  status: "accepted";
  fieldId: string;
  /** The field's review state is now ACCEPTED. */
  reviewStatus: "ACCEPTED";
  /** True: the FIELD_ACCEPTED audit write failed — manual backfill needed. */
  auditWriteFailed: boolean;
  /** True when any audit write for this acceptance needs backfilling. */
  auditMissing: boolean;
  /** Client-safe warnings for partial-success states (empty when none). */
  warnings: readonly string[];
}

/** Every failure body: one client-safe `error` string and nothing else. */
export interface FieldAcceptErrorBody {
  error: string;
}

export type FieldAcceptResponse =
  | FieldAcceptSuccessBody
  | FieldAcceptErrorBody;

/** Sanitized blocker -> client-safe message (constants; never raw details). */
const blockerMessage = (reason: FieldAcceptBlocker): string => {
  switch (reason) {
    case "document_inactive":
      return "This field belongs to a superseded document version and can no longer be accepted.";
    case "attempt_superseded":
      return "This field belongs to a superseded extraction attempt and can no longer be accepted. Review the document's current attempt instead.";
    case "attempt_not_completed":
      return "The current extraction attempt has not completed, so there is no confirmed value to accept yet. Run extraction first.";
    case "already_reviewed":
      return "This field has already been reviewed (accepted or corrected) and cannot be accepted again.";
  }
};

/** Map a non-`success` service outcome to its HTTP response. Exhaustive —
 * no invented variants. */
const mapOutcome = (
  outcome: Exclude<AcceptFieldOutcome, { status: "success" }>,
): Response => {
  switch (outcome.status) {
    case "not_found":
      return jsonError(404, "Shipment or extracted field not found.");
    case "field_not_acceptable":
      return jsonError(409, blockerMessage(outcome.reason));
    case "invalid_value":
      return jsonError(
        400,
        "This field has no valid stored value to accept. Correct the value instead.",
      );
    case "unavailable":
      console.error(
        "[accept-route] Database unavailable during field acceptance.",
      );
      return jsonError(
        503,
        "The service is temporarily unavailable. The field was not accepted. Please try again.",
      );
  }
};

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ shipmentId: string; fieldId: string }> },
): Promise<Response> {
  // --- 1. Server-side session & role (explicit 40x; no redirects) ----------
  const session = await getSession();
  if (!session?.user?.id) {
    return jsonError(401, "You must be signed in to accept extracted values.");
  }
  if (!hasRole(session, ACCEPT_ROLES)) {
    return jsonError(
      403,
      "Only documentation managers may accept extracted values.",
    );
  }

  // --- 2. Structural UUID validation (404 without a DB round-trip) ---------
  const { shipmentId, fieldId } = await params;
  const sid = shipmentId.trim();
  const fid = fieldId.trim();
  if (!UUID_PATTERN.test(sid) || !UUID_PATTERN.test(fid)) {
    return jsonError(404, "Shipment or extracted field not found.");
  }

  // --- 3. Delegate the entire workflow to the service -----------------------
  const result = await acceptExtractedField(sid, fid, session.user.id);
  if (result.status !== "success") {
    return mapOutcome(result);
  }

  const warnings: string[] = [];
  if (result.auditWriteFailed) {
    warnings.push(
      "The field was accepted, but its audit entry could not be written and needs backfilling.",
    );
  }

  return Response.json(
    {
      status: "accepted",
      fieldId: fid,
      reviewStatus: "ACCEPTED" as const,
      auditWriteFailed: result.auditWriteFailed,
      auditMissing: warnings.length > 0,
      warnings,
    } satisfies FieldAcceptSuccessBody,
    { status: 200 },
  );
}
