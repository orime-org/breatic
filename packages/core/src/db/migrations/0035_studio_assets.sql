-- Studio asset registry (spec 2026-07-04-asset-layer-v1). One physical
-- asset row per unique content PER STUDIO (within-studio dedup). The
-- content_hash is a DEDUP COLUMN ONLY - never in the storage key / URL
-- (a content-hash URL would be a content-existence oracle). Hand-written
-- (drizzle-kit generate needs a TTY; same pattern as 0025..0034: .sql +
-- _journal entry, no snapshot).
--
-- V1 has no delete flow (assets accumulate); deleted_at is reserved for a
-- future GDPR / studio-deletion cascade and does NOT cascade with
-- deleteProject (studio-scoped). No updated_at (rows are immutable once
-- created - content_hash defines them).

CREATE TABLE IF NOT EXISTS "studio_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"file_url" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"source" varchar(20) NOT NULL,
	"generation_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "studio_assets" ADD CONSTRAINT "studio_assets_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "studio_assets" ADD CONSTRAINT "studio_assets_generation_task_id_tasks_id_fk" FOREIGN KEY ("generation_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Within-studio dedup key: one row per (studio, content) among live rows.
-- Partial UNIQUE (Drizzle's builder does not emit partial unique indexes).
CREATE UNIQUE INDEX IF NOT EXISTS "studio_assets_studio_hash_unique" ON "studio_assets" ("studio_id", "content_hash") WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Usage sum + management listing scoped to one studio (partial on live rows).
CREATE INDEX IF NOT EXISTS "studio_assets_studio_idx" ON "studio_assets" ("studio_id") WHERE "deleted_at" IS NULL;
