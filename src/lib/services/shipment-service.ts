import "server-only";

/**
 * Shipment service — the ONLY sanctioned writer of the shipments table, and
 * the sanctioned reader for listing/count queries.
 *
 * All state and ownership decisions are made here, server-side:
 * - `createdBy` comes exclusively from the verified session (`requireSession`).
 * - `id`, `createdAt`, `updatedAt` are database-generated.
 * - `status` is left at its database default (DRAFT) — never client-supplied.
 * - `assignedTo`, `exportedAt`, `exportedBy` are never set at creation.
 *
 * Driver note (neon-http): there are NO transactions. Shipment insert and
 * audit insert are two independent statements. If the audit insert fails after
 * a successful shipment insert, this is reported as a distinct partial-success
 * result — the shipment is NOT rolled back or duplicated, and the action layer
 * still routes the user to the created shipment. A blind form retry is fenced
 * off by the unique `shipments_reference_key` constraint (mapped to a friendly
 * duplicate-reference error), so no duplicate shipment can be created.
 */

import { count, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { shipmentStatus, shipments, type Shipment } from "@/lib/db/schema";
import { requireSession } from "@/lib/server/auth";
import {
  appendAuditLog,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
} from "@/lib/services/audit-service";
import {
  validateShipmentInput,
  type ShipmentFieldErrors,
  type ShipmentRawInput,
} from "@/lib/validation/shipment";

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = "23505";

/** The shipments table's unique reference constraint. */
const SHIPMENTS_REFERENCE_CONSTRAINT = "shipments_reference_key";

/**
 * Walk the error's `cause` chain looking for a Postgres unique violation.
 * Drizzle wraps driver errors in `DrizzleQueryError` (original error exposed
 * on `.cause`), so the raw NeonDbError lives deeper than the thrown error.
 */
const findUniqueViolation = (
  error: unknown,
): { constraint: string | undefined } | null => {
  let current: unknown = error;
  // Bounded depth — enough to traverse Drizzle → driver wrapping.
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === PG_UNIQUE_VIOLATION) {
      return {
        constraint: (current as { constraint?: unknown }).constraint as
          | string
          | undefined,
      };
    }
    current = current.cause;
  }
  return null;
};

export type CreateShipmentResult =
  | {
      status: "created";
      shipment: Shipment;
    }
  | {
      /** Shipment created but the audit row could not be written. */
      status: "created_audit_failed";
      shipment: Shipment;
    }
  | { status: "invalid_input"; errors: ShipmentFieldErrors }
  | { status: "duplicate_reference" }
  | { status: "unexpected_error" };

/**
 * Create a shipment from validated user input.
 *
 * Calls `requireSession()` itself: unauthenticated callers are redirected to
 * /sign-in before any DB access, and the resulting server-verified session
 * supplies `createdBy` and the audit actor — no user ID or role is ever taken
 * from the request body.
 */
export async function createShipment(
  input: ShipmentRawInput,
): Promise<CreateShipmentResult> {
  const session = await requireSession();

  const validation = validateShipmentInput(input);
  if (!validation.success) {
    return { status: "invalid_input", errors: validation.errors };
  }

  const { reference, description, notes } = validation.data;

  let created: Shipment;
  try {
    const inserted = await db
      .insert(shipments)
      .values({
        reference,
        description,
        notes,
        // Server-owned: from the verified session. Everything else (id,
        // status DRAFT, createdAt/updatedAt) is database-generated/default.
        createdBy: session.user.id,
      })
      .returning();
    created = inserted[0]!;
  } catch (error) {
    const uniqueViolation = findUniqueViolation(error);
    if (
      uniqueViolation !== null &&
      uniqueViolation.constraint === SHIPMENTS_REFERENCE_CONSTRAINT
    ) {
      // Expected business outcome: the user picked an existing reference.
      // The message is intentionally generic — no SQL or driver details.
      return { status: "duplicate_reference" };
    }

    // Unknown DB failure — log it server-side without query internals
    // (no SQL text, params or connection data), and reply generically.
    console.error(
      `[shipment-service] Unexpected error creating shipment (reference=${reference}).`,
    );
    return { status: "unexpected_error" };
  }

  // Append-only audit trail for the creation event. Not atomic with the
  // insert (neon-http has no transactions) — a failure here is surfaced as
  // `created_audit_failed` so incident response can backfill this exact trail.
  try {
    await appendAuditLog({
      action: AUDIT_ACTIONS.shipmentCreate,
      entityType: AUDIT_ENTITY_TYPES.shipment,
      entityId: created.id,
      actorId: session.user.id,
      shipmentId: created.id,
      details: {
        reference: created.reference,
        createdBy: session.user.id,
      },
    });
  } catch {
    console.error(
      `[shipment-service] SHIPMENT_CREATE audit write failed for shipment ` +
        `id=${created.id} reference=${created.reference} — audit trail ` +
        `requires manual backfill.`,
    );
    return { status: "created_audit_failed", shipment: created };
  }

  return { status: "created", shipment: created };
}

// ---------------------------------------------------------------------------
// Read-only queries (listing / dashboard counts)
// ---------------------------------------------------------------------------

/** Page size for shipment listings. */
export const SHIPMENTS_PAGE_SIZE = 20;

/** Upper bound of requested pages — prevents absurd offsets from bad URLs. */
const MAX_LIST_PAGE = 1000;

/** All shipment statuses (derived from the pgEnum — single source of truth). */
export const SHIPMENT_STATUSES = shipmentStatus.enumValues;

export type ShipmentStatusValue = (typeof shipmentStatus.enumValues)[number];

export interface ShipmentListSuccess {
  status: "success";
  shipments: Shipment[];
  /** Total shipments matching the filter (across all pages). */
  total: number;
  /** Current 1-based page (clamped to a safe range). */
  page: number;
  pageSize: number;
  totalPages: number;
  /** Active status filter after validation, or null for "all". */
  statusFilter: ShipmentStatusValue | null;
}

export type ShipmentListResult =
  | ShipmentListSuccess
  | { status: "unavailable" };

/**
 * List shipments, newest first, with optional validated status filter and
 * clamped pagination. Raw/untrusted `page`/`status` inputs (e.g. URL query
 * params) are sanitized here: page falls back to 1 outside [1, MAX],
 * statuses not in the pgEnum are ignored (no filter), and there is no way to
 * inject through either path. Two independent queries run concurrently via
 * Promise.all (neon-http has no transactions; reads don't need one).
 *
 * Errors are logged server-side and reported as `unavailable` — never raw
 * SQL/driver details. Does not modify `createShipment` behavior.
 */
export async function listShipments(params: {
  page?: unknown;
  status?: unknown;
}): Promise<ShipmentListResult> {
  // Page: accept numeric strings; anything invalid -> page 1, clamped.
  const parsedPage = Number.parseInt(String(params.page ?? ""), 10);
  const page =
    Number.isFinite(parsedPage) && parsedPage >= 1
      ? Math.min(parsedPage, MAX_LIST_PAGE)
      : 1;

  // Status filter: case-insensitive match against the pgEnum values only.
  const rawStatus =
    typeof params.status === "string" ? params.status.trim().toUpperCase() : "";
  const statusFilter = (SHIPMENT_STATUSES as readonly string[]).includes(
    rawStatus,
  )
    ? (rawStatus as ShipmentStatusValue)
    : null;

  const whereClause = statusFilter ? eq(shipments.status, statusFilter) : undefined;

  try {
    // `desc(createdAt)` newest-first with `desc(id)` as a deterministic
    // tie-break so rows inserted in the same instant cannot reorder pages.
    const [pageRows, countRows] = await Promise.all([
      db
        .select()
        .from(shipments)
        .where(whereClause)
        .orderBy(desc(shipments.createdAt), desc(shipments.id))
        .limit(SHIPMENTS_PAGE_SIZE)
        .offset((page - 1) * SHIPMENTS_PAGE_SIZE),
      db.select({ total: count() }).from(shipments).where(whereClause),
    ]);

    const total = countRows[0]?.total ?? 0;

    return {
      status: "success",
      shipments: pageRows,
      total,
      page,
      pageSize: SHIPMENTS_PAGE_SIZE,
      totalPages: Math.ceil(total / SHIPMENTS_PAGE_SIZE),
      statusFilter,
    };
  } catch {
    console.error(
      `[shipment-service] Failed to list shipments (page=${page}, statusFilter=${statusFilter ?? "all"}).`,
    );
    return { status: "unavailable" };
  }
}

export type ShipmentCountResult =
  | { status: "success"; total: number }
  | { status: "unavailable" };

/**
 * Total shipment count for dashboard statistics. Real data only — callers
 * render `unavailable` as "—" instead of inventing a number.
 */
export async function countShipments(): Promise<ShipmentCountResult> {
  try {
    const results = await db.select({ total: count() }).from(shipments);
    return { status: "success", total: results[0]?.total ?? 0 };
  } catch {
    console.error("[shipment-service] Failed to count shipments.");
    return { status: "unavailable" };
  }
}
