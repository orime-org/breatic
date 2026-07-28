-- Split "who owns this asset" from "who produced it" (#1839).
--
-- Attribution (studio_id) now always follows the PROJECT's studio, for
-- personal and team studios alike. Before this change a personal-studio
-- project attributed to the acting user's own studio, which meant the
-- producer was recoverable by reading studios.created_by_user_id off the
-- owner studio. Removing that branch would have dropped the producer for
-- every upload-type asset (AI assets can still reach it via
-- generation_task_id -> tasks.user_id; uploads and covers have no task).
--
-- So the two facts get two columns. On a dedup HIT the existing row wins
-- and keeps its original producer — this records who FIRST brought the
-- content into the studio, which is the meaningful answer for storage
-- accounting, abuse triage and GDPR erasure.
--
-- Three steps because dev databases already hold rows. The backfill
-- exploits the very coupling this migration removes: under the old rule a
-- PERSONAL-studio asset was attributed to the acting user's own studio, so
-- that studio's created_by_user_id IS the producer — exact for those rows.
--
--   ⚠️ For rows owned by a TEAM studio the backfill is an APPROXIMATION:
--   created_by_user_id is whoever created the studio, not necessarily who
--   uploaded the bytes. The old rule attributed team-studio assets to the
--   studio "regardless of who acted", so the producer was never recorded
--   and cannot be recovered. Pre-launch, these are dev fixtures; production
--   starts empty. Do NOT treat pre-#1839 team-studio rows as authoritative
--   for attribution-of-action questions.
--
-- Hand-written (same pattern as 0034/0040/0041/0042/0043: .sql +
-- _journal entry, no snapshot).
ALTER TABLE "studio_assets"
  ADD COLUMN "produced_by_user_id" uuid
  REFERENCES "users"("id") ON DELETE restrict;

UPDATE "studio_assets" AS sa
  SET "produced_by_user_id" = s."created_by_user_id"
  FROM "studios" AS s
  WHERE sa."studio_id" = s."id"
    AND sa."produced_by_user_id" IS NULL;

ALTER TABLE "studio_assets"
  ALTER COLUMN "produced_by_user_id" SET NOT NULL;
