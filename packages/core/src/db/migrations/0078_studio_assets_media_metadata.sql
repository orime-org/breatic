-- What the media container reports about an asset's bytes (#209 + #210).
--
-- Read once at ingest, by the ffprobe running in the media container, and kept
-- so every reader gets the same answer: a dedup hit resolves to an existing
-- row and has nothing of its own to measure, and a node that has not loaded
-- its media yet has nothing to measure either.
--
-- All three nullable, for two separate reasons. No medium carries all three —
-- audio has no dimensions, a still image has no duration — and reading them is
-- best-effort: a container that times out leaves the row without them, which
-- reads the same as a medium that never had them, and the node falls back to
-- measuring what it loaded.
--
-- Existing rows stay null. There is no backfill: before launch there is no
-- real user data, and a backfill would have to re-read every stored object.
ALTER TABLE "studio_assets" ADD COLUMN "width" integer;--> statement-breakpoint

ALTER TABLE "studio_assets" ADD COLUMN "height" integer;--> statement-breakpoint

-- Numeric rather than integer: ffprobe answers 5.043265, and rounding to whole
-- seconds would make a five-second clip and a five-and-a-bit one the same row.
-- Scale 3 keeps milliseconds, which is finer than any reader shows; precision
-- 12 holds a duration far past anything anyone uploads.
ALTER TABLE "studio_assets" ADD COLUMN "duration_seconds" numeric(12, 3);
