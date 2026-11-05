/**
 * Shared client/server state contract for the shipment-creation server
 * action. Lives in a module WITHOUT "use server" so the plain object can be
 * imported by the client form — a "use server" file may only export async
 * functions.
 */

import type { ShipmentFieldErrors } from "@/lib/validation/shipment";

export type CreateShipmentActionState = {
  status: "idle" | "invalid_input" | "duplicate_reference" | "unexpected_error";
  errors?: ShipmentFieldErrors;
};

/** Initial useActionState state (plain, serializable, not an async fn). */
export const initialCreateShipmentActionState: CreateShipmentActionState = {
  status: "idle",
};
