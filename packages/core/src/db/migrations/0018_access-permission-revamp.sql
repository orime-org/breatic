-- Access permission revamp — supersedes the 2026-05-28 spec discussion.
--
-- Changes:
--   1. share_links: drop `is_permanent`. Link semantics are now expressed
--      by an explicit `kind` discriminator column ('email' vs 'link'),
--      not by overloading `bound_email` nullness — one column carrying
--      both data ("which email") and type ("which mode") is the classic
--      "boolean as enum" smell, so each gets its own column.
--   2. share_links: add `kind` (NOT NULL, CHECK in ('email','link'))
--      plus a paired CHECK that keeps `kind` and `bound_email` in sync:
--        kind='email' ⇒ bound_email IS NOT NULL
--        kind='link'  ⇒ bound_email IS NULL
--      so the table cannot drift into a contradictory state via a
--      buggy INSERT/UPDATE.
--   3. share_links: add `bound_email` (nullable) — recipient address for
--      kind='email'; only the user logged in with this email can consume.
--   4. notifications: new table. Per-user inbox for role-upgrade requests
--      / approvals / member-joined events. PG truth + Yjs invalidate
--      signal (sticks to the existing § 7.2.5 pattern in permissions spec).
--
-- spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md

-- ── share_links: drop is_permanent + add bound_email + add kind ─────

ALTER TABLE "share_links" DROP COLUMN IF EXISTS "is_permanent";--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "bound_email" varchar(255);--> statement-breakpoint

-- `kind` column: default 'link' so legacy rows (none in prod, but covers
-- dev DBs) satisfy NOT NULL on add; the backfill UPDATE then aligns
-- existing rows to the actual `bound_email` value before the CHECK
-- constraints lock the invariant in.
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "kind" varchar(16) NOT NULL DEFAULT 'link';--> statement-breakpoint

UPDATE "share_links" SET "kind" = 'email' WHERE "bound_email" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "share_links" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "share_links"
	ADD CONSTRAINT "share_links_kind_enum_check"
	CHECK ("kind" IN ('email', 'link'));--> statement-breakpoint

ALTER TABLE "share_links"
	ADD CONSTRAINT "share_links_kind_bound_email_check"
	CHECK (
		("kind" = 'email' AND "bound_email" IS NOT NULL)
		OR ("kind" = 'link' AND "bound_email" IS NULL)
	);--> statement-breakpoint

-- ── notifications: new table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"project_id" uuid,
	"read_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK (
		"type" IN (
			'access.role_upgrade_request',
			'access.role_upgrade_approved',
			'access.role_upgrade_rejected',
			'access.member_joined'
		)
	)
);--> statement-breakpoint

ALTER TABLE "notifications"
	ADD CONSTRAINT "notifications_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "notifications"
	ADD CONSTRAINT "notifications_project_id_projects_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
	ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Hot index for BellMenu: per-user unread list newest first.
CREATE INDEX IF NOT EXISTS "notifications_user_unread_idx"
	ON "notifications"
	USING btree ("user_id", "created_at", "read_at", "deleted_at");
