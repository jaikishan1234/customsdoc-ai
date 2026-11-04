/**
 * Schema Entry Point
 *
 * This file acts as the centralized schema definition for Drizzle ORM.
 * All domain tables, relations, and types are exported from here.
 *
 * Module layout (v3 design):
 * - auth.ts        Better Auth core tables — DO NOT modify.
 * - enums.ts       PostgreSQL enum types.
 * - shipments.ts   Aggregate root.
 * - documents.ts   Immutable per-version document rows.
 * - extractions.ts One row per extraction attempt (traceable history).
 * - extractedFields.ts  Extraction output (immutable values + review state).
 * - discrepancies.ts    Cross-document check results (live state).
 * - fieldCorrections.ts Append-only correction history (effective values).
 * - approvals.ts   Manager decisions + approval snapshots.
 * - auditLogs.ts   Append-only audit trail.
 */

export * from "./auth";
export * from "./enums";
export * from "./shipments";
export * from "./documents";
export * from "./extractions";
export * from "./extractedFields";
export * from "./fieldCorrections";
export * from "./discrepancies";
export * from "./approvals";
export * from "./auditLogs";
