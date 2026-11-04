/**
 * PostgreSQL Enum Definitions
 *
 * All enumeration types used by the application schema. Defined in a single
 * module so table files can reference enums without circular imports.
 */

import { pgEnum } from "drizzle-orm/pg-core";

export const shipmentStatus = pgEnum("shipment_status", [
  "DRAFT",
  "PROCESSING",
  "REVIEW",
  "AWAITING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "EXPORTED",
]);

export const documentType = pgEnum("document_type", [
  "INVOICE",
  "PACKING_LIST",
  "BILL_OF_LADING",
]);

export const extractionStatus = pgEnum("extraction_status", [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "SUPERSEDED",
]);

/**
 * Human-review state of an extracted field:
 * - PENDING_REVIEW: requires review (required key or low confidence)
 * - ACCEPTED: reviewer confirmed the original extraction value
 * - CORRECTED: reviewer supplied a correction (see field_corrections)
 */
export const fieldReviewStatus = pgEnum("field_review_status", [
  "PENDING_REVIEW",
  "ACCEPTED",
  "CORRECTED",
]);

export const discrepancyType = pgEnum("discrepancy_type", [
  "WEIGHT_MISMATCH",
  "FIELD_MISMATCH",
  "MISSING_DOCUMENT",
  "MISSING_FIELD",
  "DUPLICATE",
]);

export const severity = pgEnum("severity", ["LOW", "MEDIUM", "CRITICAL"]);

/**
 * Discrepancy lifecycle. OPEN and RECHECK_PENDING both block export
 * regardless of severity (v3 rule); CRITICAL rows can never be WAIVED.
 */
export const discrepancyStatus = pgEnum("discrepancy_status", [
  "OPEN",
  "RECHECK_PENDING",
  "RESOLVED",
  "WAIVED",
  "OBSOLETE",
]);

export const approvalStatus = pgEnum("approval_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "INVALIDATED",
]);
