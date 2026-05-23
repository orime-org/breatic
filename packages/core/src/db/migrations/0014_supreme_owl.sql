-- Add `created_at` to `yjs_documents` so it conforms to the project-wide
-- rule (CLAUDE.md "关键规范"): every PG table has a createdAt timestamp.
--
-- Backfill strategy for existing rows (user 2026-05-23, option A.1):
--   created_at = updated_at, because the earliest update is the create
--   time — Hocuspocus's persistence extension upserts on `store()`, so
--   `updated_at` on an existing row is the closest available proxy to
--   the original insert moment. Backfilling with `NOW()` (the simpler
--   Drizzle default) would lose this information and stamp every old
--   row with the migration time, which is misleading.
--
-- Done in three steps so we can run the backfill UPDATE between
-- ADD COLUMN and SET NOT NULL.

ALTER TABLE "yjs_documents" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint

-- Backfill from updated_at (every existing row has a non-null
-- updated_at because the old schema defaulted it to NOW()).
UPDATE "yjs_documents" SET "created_at" = "updated_at" WHERE "updated_at" IS NOT NULL;
--> statement-breakpoint

-- Safety net for any row with NULL updated_at (theoretically none
-- because of defaultNow on insert, but defensive). Keeps the
-- NOT NULL constraint below from failing.
UPDATE "yjs_documents" SET "created_at" = now() WHERE "created_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "yjs_documents" ALTER COLUMN "created_at" SET NOT NULL;
