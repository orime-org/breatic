-- A video's node_history row is written from inside a BullMQ job that BullMQ
-- replays whole (design §6.4.1), and the write is a plain INSERT today: every
-- replay leaves the user another copy of the same upload in the node's history.
--
-- The key identifies the upload rather than the attempt. One upload is one
-- storage key (`upload_grants_storage_key_unique` already holds that), so the
-- key it was granted is what this column stores.
--
-- Null for generations, which key on (task_id, node_id) instead, and null for
-- the first-pass dedup hit, which records an upload without issuing a grant.
-- The partial predicate below excludes nulls, so this index never joins two
-- keyless rows; whether they may coexist is migration 0087's call (one row
-- per content per node).
ALTER TABLE "node_history" ADD COLUMN "upload_storage_key" text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "node_history_upload_key_unique"
  ON "node_history" ("upload_storage_key")
  WHERE "upload_storage_key" IS NOT NULL
    AND "entry_type" = 'upload'
    AND "deleted_at" IS NULL;
