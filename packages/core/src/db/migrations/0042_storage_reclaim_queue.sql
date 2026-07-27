-- Storage reclaim queue (#1826 design §2.3, v15 2026-07-26) — the work list
-- the OFFLINE reclaim job reads.
--
-- When an upload or a generated output turns out to be a within-studio
-- duplicate, the copy we just stored is redundant. Runtime is NOT allowed to
-- delete physical objects (§0 rule 1 — that is what keeps the delete attack
-- surface at zero), so it does the only thing it may: INSERT one more row here
-- saying "this object is a known duplicate, safe to reclaim". The offline job
-- then works from an explicit list instead of scanning the bucket guessing
-- which objects are orphans.
--
-- Reclaiming these is safe by construction: every consumer URL is taken from
-- the SURVIVING row's canonical (§0 rule 2), so nothing live points at them.
--
-- No deleted_at: an internal work queue (like the lifecycle outbox), not a
-- project-scoped audit row — the physical object still needs reclaiming after
-- its project is gone.
--
-- Hand-written (same pattern as 0034/0040/0041: .sql + _journal entry, no
-- snapshot). Pre-launch, empty DB — no backfill.

CREATE TABLE IF NOT EXISTS "storage_reclaim_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"studio_id" uuid NOT NULL,
	"kept_storage_key" text NOT NULL,
	"source" varchar(16) NOT NULL,
	"reclaimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "storage_reclaim_queue" ADD CONSTRAINT "storage_reclaim_queue_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- One row per redundant object: a retried report must not queue it twice
-- (the INSERT is ON CONFLICT DO NOTHING against this constraint).
CREATE UNIQUE INDEX IF NOT EXISTS "storage_reclaim_queue_storage_key_unique" ON "storage_reclaim_queue" ("storage_key");--> statement-breakpoint

-- The offline job's driving query: pending backlog, oldest first.
CREATE INDEX IF NOT EXISTS "storage_reclaim_queue_pending_idx" ON "storage_reclaim_queue" ("reclaimed_at","created_at");
