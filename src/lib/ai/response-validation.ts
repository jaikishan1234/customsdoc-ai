/**
 * Strict validation of model-produced structured extraction output.
 *
 * Pure, dependency-free validator in the same style as
 * `src/lib/validation/document.ts` (no Zod, no SDK imports). The model's
 * `response_format` schema ALREADY constrains its grammar, but constrained
 * decoding is not a trust boundary: this module re-asserts everything against
 * the catalog that generated the schema:
 *
 * - EVERY key in `fields` must be a catalog field key (or its paired
 *   `<key>_confidence`) — unknown keys invalidate the whole response.
 * - Value types are re-checked per catalog kind; text/date values are capped
 *   (server-side-unenforced `minLength`/`maxLength` are enforced HERE) and
 *   dates must be genuine ISO-8601 calendar dates.
 * - Numbers must be finite and within the capacity of the
 *   `extracted_fields.numeric_value NUMERIC(14,4)` column.
 * - Confidence must be a finite number in [0, 1] whenever the paired value is
 *   present — model-reported confidence is treated strictly as an ESTIMATE;
 *   out-of-range or non-numeric confidences invalidate the response, they are
 *   never clamped into acceptance (constraint: reject invalid confidence).
 * - A null/blank value records an ABSENT field (confidence null). This is the
 *   only lenient normalization, and it is explicit.
 *
 * Any violation fails the WHOLE response (strict, all-or-nothing) so services
 * never persist partially-validated data.
 */

import type { DocumentTypeValue } from "@/lib/validation/document";

import {
  getExtractionFieldCatalog,
  type ExtractionFieldDefinition,
  type ExtractionFieldKind,
} from "./extraction-catalogs";

const CONFIDENCE_KEY_SUFFIX = "_confidence";

const MAX_TEXT_VALUE_CHARS = 500;

/** Strict ISO-8601 date (YYYY-MM-DD) with plausible month/day ranges. */
const ISO_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/**
 * `extracted_fields.numeric_value` is NUMERIC(14,4): 10 integer digits. A
 * value at or beyond 10^10 cannot be stored — reject it here instead of
 * failing at insert time.
 */
const NUMERIC_MAGNITUDE_LIMIT = 10_000_000_000;

/** The Interactions API accepts PDFs up to 1000 pages. */
const PAGE_NUMBER_LIMIT = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type ExtractionParseFailureReason =
  | "shape" // missing/mistyped structural containers
  | "unknown_key" // model invented a key outside the catalog
  | "confidence" // missing/out-of-range/non-numeric confidence for a present value
  | "value"; // wrong type/format/length for a value

export interface ValidatedExtractionField {
  key: string;
  label: string;
  kind: ExtractionFieldKind;
  /** Normalized non-empty scalar; null when absent/unreadable in the document. */
  value: string | number | null;
  /** Catalog unit (weights: "KG"); null otherwise. */
  unit: string | null;
  /** In [0, 1]; null only when the value itself is absent. */
  confidence: number | null;
}

export type ExtractionParseResult =
  | {
      status: "success";
      /** Document-level page the model reported, or null. */
      pageNumber: number | null;
      /** One entry per catalog field, in catalog order. */
      fields: readonly ValidatedExtractionField[];
    }
  | { status: "invalid"; reason: ExtractionParseFailureReason; detail: string };

const fail = (
  reason: ExtractionParseFailureReason,
  detail: string,
): ExtractionParseResult => ({ status: "invalid", reason, detail });

const absentField = (
  definition: ExtractionFieldDefinition,
): ValidatedExtractionField => ({
  key: definition.key,
  label: definition.label,
  kind: definition.kind,
  value: null,
  unit: definition.unit,
  confidence: null,
});

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isValidConfidence = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 1;

/** Validate one present (non-null) value against its kind. Returns null when
 * the value is valid normalized; "absent" for blank text; otherwise the
 * failure detail. */
const validatePresentValue = (
  value: unknown,
  kind: ExtractionFieldKind,
): { outcome: "absent" } | { outcome: "valid"; value: string | number } | { outcome: "fail"; detail: string } => {
  if (kind === "numeric") {
    if (!isFiniteNumber(value)) {
      return { outcome: "fail", detail: "Numeric field value is not a finite number." };
    }
    if (!(Math.abs(value) < NUMERIC_MAGNITUDE_LIMIT)) {
      return {
        outcome: "fail",
        detail: "Numeric field value exceeds the storage magnitude limit.",
      };
    }
    return { outcome: "valid", value };
  }

  if (kind === "integer") {
    if (!isFiniteNumber(value) || !Number.isInteger(value)) {
      return { outcome: "fail", detail: "Integer field value is not a whole number." };
    }
    if (value < 0 || !(Math.abs(value) < NUMERIC_MAGNITUDE_LIMIT)) {
      return {
        outcome: "fail",
        detail: "Integer field value is negative or exceeds the storage magnitude limit.",
      };
    }
    return { outcome: "valid", value };
  }

  // text / date
  if (typeof value !== "string") {
    return { outcome: "fail", detail: "Text field value is not a string." };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { outcome: "absent" };
  }
  if (trimmed.length > MAX_TEXT_VALUE_CHARS) {
    return { outcome: "fail", detail: "Text field value exceeds the value length cap." };
  }
  if (kind === "date" && !ISO_DATE_PATTERN.test(trimmed)) {
    return { outcome: "fail", detail: "Date field value is not a valid ISO-8601 date." };
  }
  return { outcome: "valid", value: trimmed };
};

/**
 * Validate an ALREADY-PARSED JSON payload (the provider adapter returns the
 * parsed `steps` output value as `data: unknown`) against a document type's
 * catalog. Never logs; no document-derived text is included in failure
 * details — they are static, key-name-safe strings.
 */
export const parseStructuredExtractionResponse = (
  payload: unknown,
  documentType: DocumentTypeValue,
): ExtractionParseResult => {
  const catalog = getExtractionFieldCatalog(documentType);

  if (!isRecord(payload)) {
    return fail("shape", "Structured output is not a JSON object.");
  }

  for (const key of Object.keys(payload)) {
    if (key !== "fields" && key !== "page_number") {
      return fail("unknown_key", "Structured output carries an unexpected top-level key.");
    }
  }

  const rawPageNumber = payload["page_number"];
  if (rawPageNumber === undefined) {
    return fail("shape", "Structured output is missing page_number.");
  }
  let pageNumber: number | null = null;
  if (rawPageNumber !== null) {
    if (
      !isFiniteNumber(rawPageNumber) ||
      !Number.isInteger(rawPageNumber) ||
      rawPageNumber < 1 ||
      rawPageNumber > PAGE_NUMBER_LIMIT
    ) {
      return fail("value", "page_number is not a valid 1-based page number.");
    }
    pageNumber = rawPageNumber;
  }

  const rawFields = payload["fields"];
  if (!isRecord(rawFields)) {
    return fail("shape", "Structured output is missing the fields object.");
  }

  // Unknown-key rejection: anything outside the catalog (including invented
  // confidence pairings) invalidates the response.
  const allowedKeys = new Set<string>();
  for (const definition of catalog.fields) {
    allowedKeys.add(definition.key);
    allowedKeys.add(`${definition.key}${CONFIDENCE_KEY_SUFFIX}`);
  }
  for (const key of Object.keys(rawFields)) {
    if (!allowedKeys.has(key)) {
      return fail("unknown_key", "Structured output carries an unknown field key.");
    }
  }

  const validated: ValidatedExtractionField[] = [];
  for (const definition of catalog.fields) {
    const rawValue = rawFields[definition.key];

    // Undefined (never emitted) and null both mean ABSENT — the schema marks
    // every key required-but-nullable, so treat them identically.
    if (rawValue === undefined || rawValue === null) {
      validated.push(absentField(definition));
      continue;
    }

    const valueCheck = validatePresentValue(rawValue, definition.kind);
    if (valueCheck.outcome === "fail") {
      return fail("value", valueCheck.detail);
    }
    if (valueCheck.outcome === "absent") {
      validated.push(absentField(definition));
      continue;
    }

    const rawConfidence = rawFields[`${definition.key}${CONFIDENCE_KEY_SUFFIX}`];
    if (!isValidConfidence(rawConfidence)) {
      return fail(
        "confidence",
        `Confidence for a present value must be a number in [0, 1].`,
      );
    }

    validated.push({
      key: definition.key,
      label: definition.label,
      kind: definition.kind,
      value: valueCheck.value,
      unit: definition.unit,
      confidence: rawConfidence,
    });
  }

  return { status: "success", pageNumber, fields: validated };
};
