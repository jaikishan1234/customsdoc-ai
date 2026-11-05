"use server";

/**
 * Server action for shipment creation (POST from the /shipments/new form).
 *
 * Ownership & errors: the service re-derives the session server-side and
 * validates all input — nothing in the FormData is trusted beyond raw text.
 * The redirect to the created shipment happens OUTSIDE any try/catch so
 * Next.js control-flow NEXT_REDIRECT errors are never swallowed.
 *
 * This file exports ONLY the async Server Action. All shared types and the
 * initial state object live in action-state.ts (a sibling module without
 * "use server"), since "use server" files may not export plain values.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { CreateShipmentActionState } from "./action-state";
import { createShipment } from "@/lib/services/shipment-service";

const formDataToRawInput = (formData: FormData) => ({
  reference: formData.get("reference"),
  description: formData.get("description"),
  notes: formData.get("notes"),
});

export async function createShipmentAction(
  _prevState: CreateShipmentActionState,
  formData: FormData,
): Promise<CreateShipmentActionState> {
  const result = await createShipment(formDataToRawInput(formData));

  switch (result.status) {
    case "created":
    case "created_audit_failed": {
      // The shipment exists in both cases (audit failure is logged for manual
      // backfill; the user must NOT resubmit the form, which the unique
      // reference constraint would reject — and rightly so).
      // Success: refresh the (future) shipment listing, then navigate to the
      // detail page. Redirect is called without a wrapping try/catch.
      revalidatePath("/shipments");
      redirect(`/shipments/${result.shipment.id}`);
    }

    case "invalid_input":
      return { status: "invalid_input", errors: result.errors };

    case "duplicate_reference":
      // Friendly, field-level feedback — no SQL or constraint internals.
      return {
        status: "duplicate_reference",
        errors: {
          reference:
            "This reference is already used by another shipment. Choose a " +
            "different one (e.g. SHP-24811).",
        },
      };

    case "unexpected_error":
    default:
      return { status: "unexpected_error" };
  }
}
