-- #96: a studio member who is not on a project asks its owner to let them in.
--
-- Opening a project used to write a baseline viewer row for any studio member
-- of a `visibility = 'studio'` project. Membership is now granted only by the
-- owner, so the column that decided who got that row goes away with it: every
-- project is listed to every studio member, and entry needs a member row.
--
-- The request table mirrors `role_upgrade_requests` (0047). `granted_role` is
-- the owner's choice at approval time and is set exactly when the request is
-- approved.

CREATE TABLE "project_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"message" text,
	"status" varchar(16) NOT NULL,
	"granted_role" varchar(16),
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"notification_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"share_token" varchar(64) NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_join_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "project_join_requests_granted_role_check" CHECK ("granted_role" IN ('viewer', 'editor')),
	CONSTRAINT "project_join_requests_granted_role_iff_approved" CHECK (("status" = 'approved') = ("granted_role" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD CONSTRAINT "project_join_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD CONSTRAINT "project_join_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD CONSTRAINT "project_join_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD CONSTRAINT "project_join_requests_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_join_requests_share_token_key" ON "project_join_requests" USING btree ("share_token");--> statement-breakpoint
CREATE INDEX "project_join_requests_project_id_idx" ON "project_join_requests" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE INDEX "project_join_requests_requester_user_id_idx" ON "project_join_requests" USING btree ("requester_user_id");--> statement-breakpoint
-- At most one pending request per (project, requester). A timed-out row keeps
-- status = 'pending' until the create path reaps it (the predicate cannot
-- reference now()), as with role_upgrade_requests_one_pending.
CREATE UNIQUE INDEX "project_join_requests_one_pending" ON "project_join_requests" USING btree ("project_id","requester_user_id") WHERE "project_join_requests"."status" = 'pending' AND "project_join_requests"."deleted_at" IS NULL;--> statement-breakpoint

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK (
	"type" IN (
		'access.role_upgrade_request',
		'access.role_upgrade_approved',
		'access.role_upgrade_rejected',
		'studio.transfer_request',
		'studio.transfer_approved',
		'studio.invite_request',
		'studio.invite_accepted',
		'project.invite_request',
		'project.invite_accepted',
		'project.transfer_request',
		'project.transfer_approved',
		'project.join_request',
		'project.join_approved',
		'project.join_rejected',
		'membership.ended',
		'membership.upgrade_incomplete',
		'storage.quota_exceeded'
	)
);--> statement-breakpoint

ALTER TABLE "projects" DROP COLUMN "visibility";
