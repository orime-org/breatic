-- The hash of the bytes as received (inner#1367). The ingest Worker turns a
-- picture shown at an EXIF orientation upright, which changes the stored bytes
-- and so content_hash; the browser hashes the original file, and the dedup
-- pre-check finds the row by either. Rows written before this were stored as
-- received, so theirs is their content hash.
ALTER TABLE "studio_assets" ADD COLUMN "received_hash" varchar(64);--> statement-breakpoint
UPDATE "studio_assets" SET "received_hash" = "content_hash";--> statement-breakpoint
ALTER TABLE "studio_assets" ALTER COLUMN "received_hash" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "studio_assets_studio_received_hash_idx"
  ON "studio_assets" ("studio_id", "received_hash") WHERE "deleted_at" IS NULL;
