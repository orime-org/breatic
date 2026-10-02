-- A history row keeps the media numbers its content landed on the node with
-- (#2184), so restoring the row puts back the same seven fields the settle
-- wrote. Nullable: a medium may have no such number, and rows written before
-- this migration have none. Types follow the same-named studio_assets columns.
ALTER TABLE "node_history" ADD COLUMN "media_width" integer;
--> statement-breakpoint
ALTER TABLE "node_history" ADD COLUMN "media_height" integer;
--> statement-breakpoint
ALTER TABLE "node_history" ADD COLUMN "duration_seconds" numeric(12, 3);
--> statement-breakpoint
ALTER TABLE "node_history" ADD COLUMN "mime_type" varchar(100);
--> statement-breakpoint
ALTER TABLE "node_history" ADD COLUMN "size_bytes" bigint;
