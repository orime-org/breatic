-- Every waiting-for-an-answer request carries the token that names it.
--
-- The five flows (studio invite, project invite, studio transfer, project
-- transfer, role upgrade) are reached through one landing page at
-- `/decision?token=`. Until now only the two invite flows had a token and it
-- lived in Redis on its own timer, which meant the LINK could die while the
-- invite was still open — the landing page then said "invalid link" for a
-- request that was perfectly answerable. Holding the token on the row ties it
-- to the request's own lifetime: the link stays valid as long as the row
-- exists, and what expires is the request.
--
-- The column is NOT NULL because a request without a token is one no email can
-- reach. Existing rows get a value here rather than being allowed to stay null:
-- two uuids with the dashes stripped give 64 hex characters, and uuid
-- uniqueness carries over to the concatenation.
--
-- The unique indexes deliberately have NO predicate on `deleted_at`. A request
-- whose project was deleted is soft-deleted along with it, and the landing page
-- still has to find that row — "this request is gone" and "this token was never
-- real" are different things to say to a user, and only a findable row can tell
-- them apart.

ALTER TABLE "studio_invitations" ADD COLUMN "share_token" varchar(64);--> statement-breakpoint
ALTER TABLE "project_invitations" ADD COLUMN "share_token" varchar(64);--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD COLUMN "share_token" varchar(64);--> statement-breakpoint
ALTER TABLE "project_transfers" ADD COLUMN "share_token" varchar(64);--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD COLUMN "share_token" varchar(64);--> statement-breakpoint

UPDATE "studio_invitations" SET "share_token" =
  replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  WHERE "share_token" IS NULL;--> statement-breakpoint
UPDATE "project_invitations" SET "share_token" =
  replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  WHERE "share_token" IS NULL;--> statement-breakpoint
UPDATE "role_upgrade_requests" SET "share_token" =
  replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  WHERE "share_token" IS NULL;--> statement-breakpoint
UPDATE "project_transfers" SET "share_token" =
  replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  WHERE "share_token" IS NULL;--> statement-breakpoint
UPDATE "studio_transfers" SET "share_token" =
  replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  WHERE "share_token" IS NULL;--> statement-breakpoint

ALTER TABLE "studio_invitations" ALTER COLUMN "share_token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_invitations" ALTER COLUMN "share_token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ALTER COLUMN "share_token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_transfers" ALTER COLUMN "share_token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_transfers" ALTER COLUMN "share_token" SET NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "studio_invitations_share_token_key" ON "studio_invitations" ("share_token");--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_share_token_key" ON "project_invitations" ("share_token");--> statement-breakpoint
CREATE UNIQUE INDEX "role_upgrade_requests_share_token_key" ON "role_upgrade_requests" ("share_token");--> statement-breakpoint
CREATE UNIQUE INDEX "project_transfers_share_token_key" ON "project_transfers" ("share_token");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_transfers_share_token_key" ON "studio_transfers" ("share_token");
