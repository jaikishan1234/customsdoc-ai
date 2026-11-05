/**
 * Shipment input validation.
 *
 * Pure, dependency-free validators — the project deliberately does not ship a
 * schema-validation library. These functions are safe to import from both the
 * client (instant feedback) and the server (the service layer re-validates
 * everything it receives; client checks are UX only, never authorization).
 */

/** Canonical shipment reference format, mirrored by the DB CHECK
 * `shipments_reference_fmt` in src/lib/db/schema/shipments.ts. */
export const SHIPMENT_REFERENCE_PATTERN = /^SHP-[0-9]{4,10}$/;

export const SHIPMENT_DESCRIPTION_MAX_LENGTH = 500;
export const SHIPMENT_NOTES_MAX_LENGTH = 2000;

export interface ShipmentFieldErrors {
  reference?: string;
  description?: string;
  notes?: string;
}

/** Validated, normalized creation data — the ONLY shape the service accepts. */
export interface ShipmentCreateData {
  reference: string;
  description: string | null;
  notes: string | null;
}

export type ShipmentValidationResult =
  | { success: true; data: ShipmentCreateData }
  | { success: false; errors: ShipmentFieldErrors };

/** Raw (untrusted) input shape, as collected from a form/FormData. */
export interface ShipmentRawInput {
  reference: unknown;
  description: unknown;
  notes: unknown;
}

const REFERENCE_REQUIRED_ERROR = "Reference is required (e.g. SHP-24811).";
const REFERENCE_FORMAT_ERROR =
  "Reference must be the letters SHP followed by a hyphen and 4–10 digits " +
  "(e.g. SHP-24811).";
const DESCRIPTION_MAX_ERROR = `Description must be ${SHIPMENT_DESCRIPTION_MAX_LENGTH} characters or fewer.`;
const NOTES_MAX_ERROR = `Notes must be ${SHIPMENT_NOTES_MAX_LENGTH} characters or fewer.`;

/** Coerce a raw form value to a trimmed string, or null when absent/not text. */
const toTrimmedStringOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Normalize a shipment reference: trim surrounding whitespace and uppercase.
 * `shp-24811` → `SHP-24811`. Digits and hyphen are unaffected, so uppercasing
 * can only fix letter case — it cannot make an invalid reference valid.
 */
export const normalizeShipmentReference = (raw: string): string =>
  raw.trim().toUpperCase();

/**
 * Validate shipment creation input. Returns either normalized data ready for
 * the service layer, or per-field error messages for the form.
 */
export function validateShipmentInput(
  input: ShipmentRawInput,
): ShipmentValidationResult {
  const errors: ShipmentFieldErrors = {};

  // Reference — user-supplied, so it must be present and well-formed. Uppercase
  // normalization happens before the format check (letters only change case).
  const rawReference = toTrimmedStringOrNull(input.reference);
  if (rawReference === null) {
    errors.reference = REFERENCE_REQUIRED_ERROR;
  } else {
    const normalized = normalizeShipmentReference(rawReference);
    if (!SHIPMENT_REFERENCE_PATTERN.test(normalized)) {
      errors.reference = REFERENCE_FORMAT_ERROR;
    }
  }

  // Description / notes — optional; empty string is treated as absent (NULL),
  // mirroring the nullable text columns.
  const description = toTrimmedStringOrNull(input.description);
  if (description !== null && description.length > SHIPMENT_DESCRIPTION_MAX_LENGTH) {
    errors.description = DESCRIPTION_MAX_ERROR;
  }

  const notes = toTrimmedStringOrNull(input.notes);
  if (notes !== null && notes.length > SHIPMENT_NOTES_MAX_LENGTH) {
    errors.notes = NOTES_MAX_ERROR;
  }

  if (Object.keys(errors).length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      // Safe: format was verified above.
      reference: normalizeShipmentReference(rawReference as string),
      description,
      notes,
    },
  };
}
