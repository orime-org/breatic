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
-- Two such hits are two user actions and each keeps its own row, which the
-- partial predicate below allows by excluding nulls.
ALTER TABLE "node_history" ADD COLUMN "upload_storage_key" text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "node_history_upload_key_unique"
  ON "node_history" ("upload_storage_key")
  WHERE "upload_storage_key" IS NOT NULL
    AND "entry_type" = 'upload'
    AND "deleted_at" IS NULL;
