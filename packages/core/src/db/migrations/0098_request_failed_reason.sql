-- A request nobody could answer ends as `failed`, and `failed_reason` says why
-- (inner#1023): `expired` when its deadline passed, `invalidated` when what it
-- was about stopped holding (the studio or project changed hands, the
-- requester already got what they asked for, the project was archived).
--
-- The old status `expired` covered both. Rows carrying it are backfilled from
-- the trace the old premise-lost writers left: they pulled `expires_at` back
-- to `now()` in the same UPDATE that stamped `updated_at`, so the two sit
-- within seconds of each other. A timed-out row was reaped after its deadline
-- and keeps the deadline it had.
--
-- Each table's `status` gets a CHECK listing its own words, so a writer still
-- using the old word fails instead of writing a status nothing reads.
ALTER TABLE "project_join_requests" DROP CONSTRAINT "project_join_requests_status_check";--> statement-breakpoint
ALTER TABLE "studio_invitations" ADD COLUMN "failed_reason" varchar(16);--> statement-breakpoint
ALTER TABLE "project_invitations" ADD COLUMN "failed_reason" varchar(16);--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD COLUMN "failed_reason" varchar(16);--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD COLUMN "failed_reason" varchar(16);--> statement-breakpoint
ALTER TABLE "project_transfers" ADD COLUMN "failed_reason" varchar(16);--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD COLUMN "failed_reason" varchar(16);--> statement-breakpoint
-- >>> failed_reason backfill
UPDATE "studio_invitations" SET "status" = 'failed', "failed_reason" = CASE WHEN abs(extract(epoch FROM "updated_at" - "expires_at")) < 5 THEN 'invalidated' ELSE 'expired' END WHERE "status" = 'expired';--> statement-breakpoint
UPDATE "project_invitations" SET "status" = 'failed', "failed_reason" = CASE WHEN abs(extract(epoch FROM "updated_at" - "expires_at")) < 5 THEN 'invalidated' ELSE 'expired' END WHERE "status" = 'expired';--> statement-breakpoint
UPDATE "role_upgrade_requests" SET "status" = 'failed', "failed_reason" = CASE WHEN abs(extract(epoch FROM "updated_at" - "expires_at")) < 5 THEN 'invalidated' ELSE 'expired' END WHERE "status" = 'expired';--> statement-breakpoint
UPDATE "project_join_requests" SET "status" = 'failed', "failed_reason" = CASE WHEN abs(extract(epoch FROM "updated_at" - "expires_at")) < 5 THEN 'invalidated' ELSE 'expired' END WHERE "status" = 'expired';--> statement-breakpoint
UPDATE "project_transfers" SET "status" = 'failed', "failed_reason" = CASE WHEN abs(extract(epoch FROM "updated_at" - "expires_at")) < 5 THEN 'invalidated' ELSE 'expired' END WHERE "status" = 'expired';--> statement-breakpoint
UPDATE "studio_transfers" SET "status" = 'failed', "failed_reason" = CASE WHEN abs(extract(epoch FROM "updated_at" - "expires_at")) < 5 THEN 'invalidated' ELSE 'expired' END WHERE "status" = 'expired';--> statement-breakpoint
-- <<< failed_reason backfill
ALTER TABLE "studio_invitations" ADD CONSTRAINT "studio_invitations_status_check" CHECK ("status" IN ('pending', 'accepted', 'declined', 'revoked', 'failed'));--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_status_check" CHECK ("status" IN ('pending', 'accepted', 'declined', 'revoked', 'failed'));--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD CONSTRAINT "role_upgrade_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled', 'failed'));--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD CONSTRAINT "project_join_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled', 'failed'));--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_status_check" CHECK ("status" IN ('pending', 'accepted', 'declined', 'cancelled', 'failed'));--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_status_check" CHECK ("status" IN ('pending', 'accepted', 'declined', 'cancelled', 'failed'));--> statement-breakpoint
ALTER TABLE "studio_invitations" ADD CONSTRAINT "studio_invitations_failed_reason_check" CHECK (("status" = 'failed') = ("failed_reason" IS NOT NULL) AND ("failed_reason" IS NULL OR "failed_reason" IN ('expired', 'invalidated')));--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_failed_reason_check" CHECK (("status" = 'failed') = ("failed_reason" IS NOT NULL) AND ("failed_reason" IS NULL OR "failed_reason" IN ('expired', 'invalidated')));--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD CONSTRAINT "role_upgrade_requests_failed_reason_check" CHECK (("status" = 'failed') = ("failed_reason" IS NOT NULL) AND ("failed_reason" IS NULL OR "failed_reason" IN ('expired', 'invalidated')));--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD CONSTRAINT "project_join_requests_failed_reason_check" CHECK (("status" = 'failed') = ("failed_reason" IS NOT NULL) AND ("failed_reason" IS NULL OR "failed_reason" IN ('expired', 'invalidated')));--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_failed_reason_check" CHECK (("status" = 'failed') = ("failed_reason" IS NOT NULL) AND ("failed_reason" IS NULL OR "failed_reason" IN ('expired', 'invalidated')));--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_failed_reason_check" CHECK (("status" = 'failed') = ("failed_reason" IS NOT NULL) AND ("failed_reason" IS NULL OR "failed_reason" IN ('expired', 'invalidated')));
