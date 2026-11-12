-- A media run's state lives in the ticket provider hands back (inner#1743):
-- the worker stores it on the task before every paid request, with a version
-- for a compare-and-set write and a mark while a send is in flight, so a
-- crash mid-send is resumed through provider's recover.
ALTER TABLE tasks ADD COLUMN provider_ticket jsonb;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN provider_ticket_version integer;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN provider_sending_at timestamptz;
--> statement-breakpoint

-- A clone belongs to the upstream that made it: every row so far was made on
-- WaveSpeed, and one source may have a live clone on each upstream.
ALTER TABLE studio_upstream_clones ADD COLUMN upstream text;
--> statement-breakpoint
UPDATE studio_upstream_clones SET upstream = 'wavespeed';
--> statement-breakpoint
ALTER TABLE studio_upstream_clones ALTER COLUMN upstream SET NOT NULL;
--> statement-breakpoint
DROP INDEX "studio_upstream_clones_live_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "studio_upstream_clones_live_key" ON "studio_upstream_clones" ("studio_id", "upstream", "kind", "source_key") WHERE "deleted_at" IS NULL;
