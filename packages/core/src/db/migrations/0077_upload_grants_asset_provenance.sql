-- What the asset an upload produces is, and what generation it came out of
-- (#181, design §4.10). The worker uploads its own output through the ingest
-- Worker now, so the report handler can no longer assume every grant it sees
-- is a user's upload; both facts are known when the grant is minted and
-- nowhere afterwards, since the Worker only ever knows what the ticket told it.
--
-- `asset_source` rather than `source`: that column already exists here holding
-- a different vocabulary (`mini_tool`, read by node_history and the activity
-- feed), while this one holds `studio_assets.source` (`upload` / `ai` /
-- `cover`). One name over two vocabularies is how `mini_tool` would end up
-- written into the asset ledger.
ALTER TABLE "upload_grants" ADD COLUMN "asset_source" text;--> statement-breakpoint

ALTER TABLE "upload_grants" ADD COLUMN "generation_task_id" uuid;--> statement-breakpoint

ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_generation_task_id_tasks_id_fk"
  FOREIGN KEY ("generation_task_id") REFERENCES "public"."tasks"("id")
  ON DELETE restrict ON UPDATE no action;
