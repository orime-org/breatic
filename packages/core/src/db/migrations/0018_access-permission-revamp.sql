-- Access permission revamp — supersedes the 2026-05-28 spec discussion.
--
-- Changes:
--   1. share_links: drop `is_permanent` (no longer used — link semantics
--      now derived from `bound_email`: NULL = multi-use Generate link,
--      NOT NULL = single-use email-invite link).
--   2. share_links: add `bound_email` (nullable) — email-invite links bind
--      to the recipient's email address; only matching login can consume.
--   3. notifications: new table. Per-user inbox for role-upgrade requests
--      / approvals / member-joined events. PG truth + Yjs invalidate
--      signal (sticks to the existing § 7.2.5 pattern in permissions spec).
--
-- spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md

-- ── share_links: drop is_permanent + add bound_email ─────────────────

ALTER TABLE "share_links" DROP COLUMN IF EXISTS "is_permanent";--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "bound_email" varchar(255);--> statement-breakpoint

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
