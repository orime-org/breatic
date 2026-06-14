-- studio-member invite confirmation handshake (2026-06-14): pending invites
-- live in their OWN table so studio_members stays "active members only" — a
-- pending invitee never pollutes studio auth / member-count, and admins can see
-- who is "invited (pending)" in the Members tab. Hand-written (same pattern as
-- 0028: .sql + _journal entry, no snapshot) — drizzle's table builder does not
-- emit the partial unique index, and the notifications CHECK is manual.
--
-- spec: breatic-inner DD + spec 2026-06-14-studio-invite-confirmation

CREATE TABLE "studio_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
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
ALTER TABLE "studio_invitations" ADD CONSTRAINT "studio_invitations_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_invitations" ADD CONSTRAINT "studio_invitations_invited_user_id_users_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_invitations" ADD CONSTRAINT "studio_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_invitations" ADD CONSTRAINT "studio_invitations_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_invitations_studio_id_idx" ON "studio_invitations" USING btree ("studio_id","deleted_at");--> statement-breakpoint
CREATE INDEX "studio_invitations_invited_user_id_idx" ON "studio_invitations" USING btree ("invited_user_id");--> statement-breakpoint
-- Partial unique — at most one LIVE pending invite per (studio, invitee).
-- Soft-deleted / non-pending rows are treated as gone, so a previously
-- declined / expired / revoked invitee can be re-invited. Drizzle's table
-- builder does not emit partial unique indexes, so it is appended manually.
CREATE UNIQUE INDEX "studio_invitations_one_pending" ON "studio_invitations" USING btree ("studio_id","invited_user_id") WHERE "studio_invitations"."status" = 'pending' AND "studio_invitations"."deleted_at" IS NULL;--> statement-breakpoint
-- Extend the notifications type CHECK with the two invite-handshake types.
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
		'studio.invite_accepted'
	)
);
