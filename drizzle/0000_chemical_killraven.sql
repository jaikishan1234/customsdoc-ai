CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'INVALIDATED');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_status" AS ENUM('OPEN', 'RECHECK_PENDING', 'RESOLVED', 'WAIVED', 'OBSOLETE');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_type" AS ENUM('WEIGHT_MISMATCH', 'FIELD_MISMATCH', 'MISSING_DOCUMENT', 'MISSING_FIELD', 'DUPLICATE');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('INVOICE', 'PACKING_LIST', 'BILL_OF_LADING');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."field_review_status" AS ENUM('PENDING_REVIEW', 'ACCEPTED', 'CORRECTED');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('LOW', 'MEDIUM', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('DRAFT', 'PROCESSING', 'REVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPORTED');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text DEFAULT 'DOCUMENTATION_EXECUTIVE' NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"status" "shipment_status" DEFAULT 'DRAFT' NOT NULL,
	"description" text,
	"notes" text,
	"created_by" text NOT NULL,
	"assigned_to" text,
	"exported_at" timestamp with time zone,
	"exported_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_reference_key" UNIQUE("reference"),
	CONSTRAINT "shipments_reference_fmt" CHECK ("shipments"."reference" ~ '^SHP-[0-9]{4,10}$'),
	CONSTRAINT "shipments_export_consistency" CHECK ((("shipments"."status" = 'EXPORTED')
        = (("shipments"."exported_at" IS NOT NULL) AND ("shipments"."exported_by" IS NOT NULL))))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"document_type" "document_type" NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"checksum_sha256" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_version_uq" UNIQUE("shipment_id","document_type","version"),
	CONSTRAINT "documents_id_shipment_uq" UNIQUE("id","shipment_id"),
	CONSTRAINT "documents_size_positive" CHECK ("documents"."size_bytes" > 0),
	CONSTRAINT "documents_version_positive" CHECK ("documents"."version" >= 1),
	CONSTRAINT "documents_superseded_consistency" CHECK ((( "documents"."is_active" = true  AND "documents"."superseded_at" IS NULL)
        OR ( "documents"."is_active" = false AND "documents"."superseded_at" IS NOT NULL))),
	CONSTRAINT "documents_checksum_sha256" CHECK ("documents"."checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "extraction_status" DEFAULT 'PENDING' NOT NULL,
	"engine" text NOT NULL,
	"engine_run_ref" text,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"triggered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extractions_id_shipment_uq" UNIQUE("id","shipment_id"),
	CONSTRAINT "extractions_doc_attempt_uq" UNIQUE("document_id","attempt"),
	CONSTRAINT "extractions_attempt_positive" CHECK ("extractions"."attempt" >= 1),
	CONSTRAINT "extractions_completion" CHECK ((("extractions"."status" = 'COMPLETED') = ("extractions"."completed_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "extracted_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extraction_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"field_label" text NOT NULL,
	"raw_value" text,
	"parsed_value" text,
	"numeric_value" numeric(14, 4),
	"unit" text,
	"confidence" numeric(4, 3) NOT NULL,
	"page_number" integer,
	"bbox" integer[],
	"review_status" "field_review_status" DEFAULT 'PENDING_REVIEW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extracted_fields_id_extraction_shipment_uq" UNIQUE("id","extraction_id","shipment_id"),
	CONSTRAINT "extracted_fields_run_key_uq" UNIQUE("extraction_id","field_key"),
	CONSTRAINT "extracted_fields_confidence_range" CHECK ("extracted_fields"."confidence" >= 0 AND "extracted_fields"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "field_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"original_value" text NOT NULL,
	"original_numeric" numeric(14, 4),
	"corrected_value" text NOT NULL,
	"corrected_numeric" numeric(14, 4),
	"unit" text,
	"reason" text NOT NULL,
	"confidence_before" numeric(4, 3),
	"corrected_by" text NOT NULL,
	"corrected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_corrections_changes_value" CHECK ("field_corrections"."corrected_value" IS DISTINCT FROM "field_corrections"."original_value")
);
--> statement-breakpoint
CREATE TABLE "discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"type" "discrepancy_type" NOT NULL,
	"scope_key" text,
	"severity" "severity" DEFAULT 'MEDIUM' NOT NULL,
	"status" "discrepancy_status" DEFAULT 'OPEN' NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"expected_value" numeric(14, 4),
	"actual_value" numeric(14, 4),
	"delta_value" numeric(14, 4),
	"unit" text,
	"field_a_id" uuid,
	"field_b_id" uuid,
	"document_a_id" uuid,
	"document_b_id" uuid,
	"check_run_key" text DEFAULT 'crosscheck-v1' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discrepancies_evidence_consistency" CHECK (( ("discrepancies"."expected_value" IS NULL AND "discrepancies"."actual_value" IS NULL AND "discrepancies"."delta_value" IS NULL)
        OR ("discrepancies"."expected_value" IS NOT NULL AND "discrepancies"."actual_value" IS NOT NULL
                                     AND "discrepancies"."delta_value" IS NOT NULL))),
	CONSTRAINT "discrepancies_critical_not_waived" CHECK ("discrepancies"."status" <> 'WAIVED' OR "discrepancies"."severity" <> 'CRITICAL'),
	CONSTRAINT "discrepancies_resolution_consistency" CHECK ((("discrepancies"."status" IN ('RESOLVED', 'WAIVED'))
        = ("discrepancies"."resolved_at" IS NOT NULL AND "discrepancies"."resolved_by" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"approval_snapshot" jsonb,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_decision_consistency" CHECK (( ("approvals"."status" = 'PENDING' AND "approvals"."decided_by" IS NULL AND "approvals"."decided_at" IS NULL)
        OR ("approvals"."status" IN ('APPROVED', 'REJECTED')
              AND "approvals"."decided_by" IS NOT NULL AND "approvals"."decided_at" IS NOT NULL)
        OR ("approvals"."status" = 'INVALIDATED'))),
	CONSTRAINT "approvals_decider_pair" CHECK (("approvals"."decided_by" IS NULL) = ("approvals"."decided_at" IS NULL)),
	CONSTRAINT "approvals_not_self_superseding" CHECK ("approvals"."supersedes_id" IS DISTINCT FROM "approvals"."id"),
	CONSTRAINT "approvals_snapshot_required" CHECK ("approvals"."status" <> 'APPROVED' OR "approvals"."approval_snapshot" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"shipment_id" uuid,
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_exported_by_user_id_fk" FOREIGN KEY ("exported_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_triggered_by_user_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_shipment_fk" FOREIGN KEY ("document_id","shipment_id") REFERENCES "public"."documents"("id","shipment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_fields" ADD CONSTRAINT "extracted_fields_extraction_fk" FOREIGN KEY ("extraction_id","shipment_id") REFERENCES "public"."extractions"("id","shipment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_corrections" ADD CONSTRAINT "field_corrections_corrected_by_user_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_corrections" ADD CONSTRAINT "field_corrections_field_triple_fk" FOREIGN KEY ("field_id","extraction_id","shipment_id") REFERENCES "public"."extracted_fields"("id","extraction_id","shipment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_field_a_id_extracted_fields_id_fk" FOREIGN KEY ("field_a_id") REFERENCES "public"."extracted_fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_field_b_id_extracted_fields_id_fk" FOREIGN KEY ("field_b_id") REFERENCES "public"."extracted_fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_document_a_id_documents_id_fk" FOREIGN KEY ("document_a_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_document_b_id_documents_id_fk" FOREIGN KEY ("document_b_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_supersedes_id_approvals_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shipments_createdBy_idx" ON "shipments" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_active_type_uq" ON "documents" USING btree ("shipment_id","document_type") WHERE "documents"."is_active" = true;--> statement-breakpoint
CREATE INDEX "documents_shipment_idx" ON "documents" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_completed_uq" ON "extractions" USING btree ("document_id") WHERE "extractions"."status" = 'COMPLETED';--> statement-breakpoint
CREATE INDEX "extractions_document_created_idx" ON "extractions" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "extractions_status_idx" ON "extractions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "extracted_fields_shipment_review_idx" ON "extracted_fields" USING btree ("shipment_id","review_status","field_key");--> statement-breakpoint
CREATE INDEX "field_corrections_field_time_idx" ON "field_corrections" USING btree ("field_id","corrected_at");--> statement-breakpoint
CREATE INDEX "field_corrections_shipment_idx" ON "field_corrections" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discrepancies_live_uq" ON "discrepancies" USING btree ("shipment_id","type",coalesce("scope_key", '')) WHERE "discrepancies"."status" IN ('OPEN', 'RECHECK_PENDING');--> statement-breakpoint
CREATE INDEX "discrepancies_shipment_status_idx" ON "discrepancies" USING btree ("shipment_id","status");--> statement-breakpoint
CREATE INDEX "discrepancies_severity_idx" ON "discrepancies" USING btree ("severity");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_live_uq" ON "approvals" USING btree ("shipment_id") WHERE "approvals"."status" IN ('PENDING', 'APPROVED');--> statement-breakpoint
CREATE INDEX "approvals_shipment_time_idx" ON "approvals" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "approvals_decidedBy_idx" ON "approvals" USING btree ("decided_by");--> statement-breakpoint
CREATE INDEX "audit_logs_shipment_time_idx" ON "audit_logs" USING btree ("shipment_id","performed_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_time_idx" ON "audit_logs" USING btree ("actor_id","performed_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");