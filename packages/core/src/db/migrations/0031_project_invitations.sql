-- project-member invite confirmation handshake (2026-06-18, #1337): the direct
-- mirror of 0029 (studio invitations) for the project membership layer. Pending
-- project invites live in their OWN table so project_members stays "active
-- members only" — a pending invitee never pollutes project auth
-- (`loadProjectRole`) / member-count, and the owner can see who is "invited
-- (pending)" and revoke it. Hand-written (same pattern as 0028 / 0029: .sql +
-- _journal entry, no snapshot) — drizzle's table builder does not emit the
-- partial unique index, and the notifications CHECK is manual.
--
-- spec: breatic-inner project-invite parity spec (2026-06-18)

CREATE TABLE "project_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"invited_user_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"invited_by" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"notification_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_user_id_users_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_invitations_project_id_idx" ON "project_invitations" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE INDEX "project_invitations_invited_user_id_idx" ON "project_invitations" USING btree ("invited_user_id");--> statement-breakpoint
-- Partial unique — at most one LIVE pending invite per (project, invitee).
-- Soft-deleted / non-pending rows are treated as gone, so a previously
-- declined / revoked invitee can be re-invited. Drizzle's table builder does
-- not emit partial unique indexes, so it is appended manually.
CREATE UNIQUE INDEX "project_invitations_one_pending" ON "project_invitations" USING btree ("project_id","invited_user_id") WHERE "project_invitations"."status" = 'pending' AND "project_invitations"."deleted_at" IS NULL;--> statement-breakpoint
-- Extend the notifications type CHECK with the two project invite-handshake
-- types (preserving every type added through 0029).
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK (
	"type" IN (
		'access.role_upgrade_request',
		'access.role_upgrade_approved',
		'access.role_upgrade_rejected',
		'access.member_joined',
		'studio.member_invited',
		'studio.transfer_request',
		'studio.transfer_approved',
		'studio.invite_request',
		'studio.invite_accepted',
		'project.invite_request',
		'project.invite_accepted'
	)
);
