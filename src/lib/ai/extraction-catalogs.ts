/**
 * Per-document-type extraction field catalogs (INVOICE / PACKING_LIST /
 * BILL_OF_LADING).
 *
 * Each catalog is the single source of truth for BOTH directions of the
 * extraction contract:
 * - `buildExtractionResponseSchema` turns a catalog into the JSON Schema sent
 *   to the Gemini Interactions API (`response_format.schema`), so the model's
 *   output grammar is generated from the same definitions that validation
 *   asserts against.
 * - `response-validation.ts` validates model output STRICTLY against the same
 *   catalog: unknown field keys, wrong value types, malformed dates and
 *   invalid confidence values are rejected — never stored on trust.
 *
 * Fields map onto `extracted_fields` columns:
 *   `key` -> field_key, `label` -> field_label, `unit` -> unit (weights only;
 *   null otherwise), `required` flags a key whose absence should force
 *   PENDING_REVIEW at the service layer (runs are typed, not keywords).
 *
 * Schema subset: only constructs documented as supported by Gemini's
 * structured-output mode are emitted (string/number/integer type arrays incl.
 * nullability, `description`, `format: "date"`, `required`, `properties`,
 * `additionalProperties`). Server-side-unenforced keywords (minLength, etc.)
 * are deliberately omitted and enforced by our validators instead.
 */

import { DOCUMENT_TYPES, type DocumentTypeValue } from "@/lib/validation/document";

export type ExtractionFieldKind = "text" | "date" | "numeric" | "integer";

export interface ExtractionFieldDefinition {
  /** Stable snake_case key persisted as `extracted_fields.field_key`. */
  key: string;
  /** Human-readable label persisted as `extracted_fields.field_label`. */
  label: string;
  kind: ExtractionFieldKind;
  /** Measurement unit (weights: "KG"); null for counts, text and dates. */
  unit: string | null;
  /** Absence of a required key should surface for review at the service layer. */
  required: boolean;
  /** Model guidance — injected verbatim into the JSON Schema `description`. */
  description: string;
}

export interface ExtractionFieldCatalog {
  documentType: DocumentTypeValue;
  fields: readonly ExtractionFieldDefinition[];
}

const field = (
  key: string,
  label: string,
  kind: ExtractionFieldKind,
  description: string,
  options: { required?: boolean; unit?: string } = {},
): ExtractionFieldDefinition => ({
  key,
  label,
  kind,
  unit: options.unit ?? null,
  required: options.required ?? false,
  description,
});

const INVOICE_FIELDS: readonly ExtractionFieldDefinition[] = [
  field("invoice_number", "Invoice number", "text",
    "The invoice number exactly as printed on the invoice document.",
    { required: true }),
  field("invoice_date", "Invoice date", "date",
    "The invoice issue date as printed on the document.",
    { required: true }),
  field("seller_name", "Seller name", "text",
    "The company or person issuing the invoice (seller/exporter)."),
  field("buyer_name", "Buyer name", "text",
    "The company or person the invoice is billed to (buyer/importer)."),
  field("currency", "Currency", "text",
    "The three-letter ISO 4217 currency code the invoice amounts are denominated in (e.g. USD).",
    { required: true }),
  field("total_amount", "Invoice total amount", "numeric",
    "The grand total amount payable on the invoice, in the invoice currency.",
    { required: true }),
  field("total_quantity", "Total quantity", "numeric",
    "Total quantity of goods invoiced (the sum of the line quantities), as a number."),
  field("incoterm", "Incoterm", "text",
    "The Incoterms trade term on the invoice (e.g. FOB, CIF)."),
  field("payment_terms", "Payment terms", "text",
    "Short payment terms as printed (e.g. NET 30); null when absent."),
];

const PACKING_LIST_FIELDS: readonly ExtractionFieldDefinition[] = [
  field("packing_list_number", "Packing list number", "text",
    "The packing list number exactly as printed on the document."),
  field("packing_list_date", "Packing list date", "date",
    "The packing list issue date as printed on the document."),
  field("shipper_name", "Shipper name", "text",
    "The party who packed and ships the cargo."),
  field("consignee_name", "Consignee name", "text",
    "The party to whom the goods are delivered."),
  field("total_packages", "Total packages", "integer",
    "Total number of shipping units/packages stated on the packing list (e.g. 120 cartons -> 120)."),
  field("gross_weight_kg", "Gross weight (kg)", "numeric",
    "Total gross weight of the shipment in kilograms.",
    { unit: "KG" }),
  field("net_weight_kg", "Net weight (kg)", "numeric",
    "Total net weight of the goods in kilograms.",
    { unit: "KG" }),
  field("goods_description", "Goods description", "text",
    "Concise description of the goods as stated on the packing list."),
];

const BILL_OF_LADING_FIELDS: readonly ExtractionFieldDefinition[] = [
  field("bol_number", "Bill of lading number", "text",
    "The bill of lading number exactly as printed (carrier B/L reference).",
    { required: true }),
  field("bol_date", "Bill of lading date", "date",
    "The bill of lading issue date as printed on the document.",
    { required: true }),
  field("shipper_name", "Shipper name", "text",
    "The party who ships the goods."),
  field("consignee_name", "Consignee name", "text",
    "The party to whom the goods are consigned."),
  field("notify_party", "Notify party", "text",
    "The party to be notified on arrival; null when absent."),
  field("vessel_name", "Vessel name", "text",
    "The vessel carrying the cargo; null for non-maritime shipments."),
  field("voyage_number", "Voyage number", "text",
    "The voyage number; null when absent."),
  field("port_of_loading", "Port of loading", "text",
    "The port where the goods are loaded aboard the vessel.",
    { required: true }),
  field("port_of_discharge", "Port of discharge", "text",
    "The port where the goods are discharged from the vessel.",
    { required: true }),
  field("container_number", "Container number", "text",
    "The primary container identifier (e.g. ABCU1234567); the leading container when several."),
  field("total_packages", "Total packages", "integer",
    "Total number of packages declared on the bill of lading."),
  field("gross_weight_kg", "Gross weight (kg)", "numeric",
    "Total gross weight of the shipment in kilograms.",
    { unit: "KG" }),
  field("freight_terms", "Freight terms", "text",
    "Freight payment terms as printed (e.g. FREIGHT PREPAID, FREIGHT COLLECT)."),
];

const EXTRACTION_FIELD_CATALOGS: Record<DocumentTypeValue, ExtractionFieldCatalog> = {
  INVOICE: { documentType: "INVOICE", fields: INVOICE_FIELDS },
  PACKING_LIST: { documentType: "PACKING_LIST", fields: PACKING_LIST_FIELDS },
  BILL_OF_LADING: { documentType: "BILL_OF_LADING", fields: BILL_OF_LADING_FIELDS },
};

/**
 * Strict lookup by document type. The document type space is closed
 * (`DOCUMENT_TYPES` mirrors the `document_type` pgEnum), so this never
 * returns null — malformed types cannot reach it.
 */
export const getExtractionFieldCatalog = (
  documentType: DocumentTypeValue,
): ExtractionFieldCatalog => EXTRACTION_FIELD_CATALOGS[documentType];

/** Storage-key-style shape any catalog field key must satisfy. */
const CATALOG_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

const MAX_COMBINED_KEY_LENGTH = 120;

/**
 * Module-load self-check: a malformed catalog is a programmer error and must
 * fail at startup, never surface as a runtime extraction quirk.
 */
const assertCatalogsConsistent = (): void => {
  for (const documentType of DOCUMENT_TYPES) {
    const catalog = EXTRACTION_FIELD_CATALOGS[documentType];
    const seen = new Set<string>();
    for (const definition of catalog.fields) {
      if (!CATALOG_KEY_PATTERN.test(definition.key)) {
        throw new Error(
          `Extraction catalog inconsistency (${documentType}): invalid field key shape.`,
        );
      }
      if (seen.has(definition.key)) {
        throw new Error(
          `Extraction catalog inconsistency (${documentType}): duplicate field key.`,
        );
      }
      seen.add(definition.key);
      if (
        definition.unit !== null &&
        definition.kind !== "numeric" &&
        definition.kind !== "integer"
      ) {
        throw new Error(
          `Extraction catalog inconsistency (${documentType}): unit is only valid on numeric fields.`,
        );
      }
      if (
        definition.label.trim().length === 0 ||
        definition.description.trim().length === 0
      ) {
        throw new Error(
          `Extraction catalog inconsistency (${documentType}): empty label or description.`,
        );
      }
      if (`${definition.key}_confidence`.length > MAX_COMBINED_KEY_LENGTH) {
        throw new Error(
          `Extraction catalog inconsistency (${documentType}): confidence key too long.`,
        );
      }
    }
  }
};

assertCatalogsConsistent();

/** Fresh JSON Schema for one value property — kind-specific, nullable. */
function valueSchemaFor(definition: ExtractionFieldDefinition): Record<string, unknown> {
  switch (definition.kind) {
    case "text":
      return {
        type: ["string", "null"],
        description:
          `${definition.description} Use null when the value is absent or unreadable.`,
      };
    case "date":
      return {
        // `format: "date"` is supported and guides ISO output.
        type: ["string", "null"],
        format: "date",
        description:
          `${definition.description} Convert to ISO-8601 (YYYY-MM-DD); ` +
          "use null when absent, unreadable or not a valid calendar date.",
      };
    case "numeric":
      return {
        type: ["number", "null"],
        description:
          `${definition.description} Output a plain number without thousand separators or currency symbols; use null when absent or unreadable.`,
      };
    case "integer":
      return {
        type: ["integer", "null"],
        description:
          `${definition.description} Output a whole number without separators or unit words; use null when absent or unreadable.`,
      };
  }
}

const confidenceDescription =
  "Transcription confidence for the paired value, in the range [0, 1]. " +
  "Use your honest self-assessment; use null only when the paired value is null.";

/**
 * Build the `response_format.schema` object sent to the Interactions API for
 * one document type. Layout is deliberately FLAT (`<key>` +
 * `<key>_confidence` siblings plus a document-level `page_number`) — the
 * provider compiles schemas into constrained-decoding grammars where every
 * nesting level and branch multiplies state, and flat keeps us well within it.
 * Every property is `required` but nullable: the model must always answer
 * explicitly (value or null), never omit keys.
 */
export const buildExtractionResponseSchema = (
  documentType: DocumentTypeValue,
): Record<string, unknown> => {
  const catalog = getExtractionFieldCatalog(documentType);

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const definition of catalog.fields) {
    properties[definition.key] = valueSchemaFor(definition);
    properties[`${definition.key}_confidence`] = {
      type: ["number", "null"],
      description: confidenceDescription,
    };
    required.push(definition.key, `${definition.key}_confidence`);
  }

  return {
    type: "object",
    properties: {
      page_number: {
        type: ["integer", "null"],
        description:
          "1-based page of the document where the extracted fields were found. " +
          "Use null when not determinable.",
      },
      fields: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
    required: ["page_number", "fields"],
    additionalProperties: false,
  };
};
