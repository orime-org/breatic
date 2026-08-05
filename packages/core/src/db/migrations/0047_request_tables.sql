-- Deferred-decision requests get their own tables.
--
-- Role upgrades, project transfers and studio transfers used to live as rows in
-- `notifications`, a table built to ANNOUNCE things: it has `read_at` and
-- nothing else — no status, no uniqueness, no expiry. All three flows therefore
-- inherited the same three defects. These tables are modelled on
-- `studio_invitations` / `project_invitations`, which own their state and
-- consequently have all three.

CREATE TABLE "role_upgrade_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"requested_role" varchar(16) NOT NULL,
	"message" text,
	"status" varchar(16) NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"notification_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD CONSTRAINT "role_upgrade_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD CONSTRAINT "role_upgrade_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD CONSTRAINT "role_upgrade_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD CONSTRAINT "role_upgrade_requests_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_upgrade_requests_project_id_idx" ON "role_upgrade_requests" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE INDEX "role_upgrade_requests_requester_user_id_idx" ON "role_upgrade_requests" USING btree ("requester_user_id");--> statement-breakpoint
-- Partial unique — at most one LIVE pending request per (project, requester).
-- Like the invite tables, a timed-out row keeps status='pending' and holds the
-- slot until something flips it: the predicate cannot reference now(). The
-- create path therefore reaps stale pendings on this key before inserting,
-- exactly as studioInvitations.expireStalePending does (#1769).
CREATE UNIQUE INDEX "role_upgrade_requests_one_pending" ON "role_upgrade_requests" USING btree ("project_id","requester_user_id") WHERE "role_upgrade_requests"."status" = 'pending' AND "role_upgrade_requests"."deleted_at" IS NULL;--> statement-breakpoint

CREATE TABLE "project_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"decided_at" timestamp with time zone,
	"notification_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_transfers_project_id_idx" ON "project_transfers" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE INDEX "project_transfers_to_user_id_idx" ON "project_transfers" USING btree ("to_user_id");--> statement-breakpoint
-- Partial unique — at most one LIVE pending transfer per PROJECT (not per
-- recipient): a project has exactly one owner, so it can never be offered to
-- two people at once.
CREATE UNIQUE INDEX "project_transfers_one_pending" ON "project_transfers" USING btree ("project_id") WHERE "project_transfers"."status" = 'pending' AND "project_transfers"."deleted_at" IS NULL;--> statement-breakpoint

-- studio_transfers is the mirror of project_transfers: same columns, same
-- constraints, with project_id → studio_id and every identifier renamed
-- accordingly; the partial unique keys on ("studio_id") alone.
CREATE TABLE "studio_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"decided_at" timestamp with time zone,
	"notification_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_transfers_studio_id_idx" ON "studio_transfers" USING btree ("studio_id","deleted_at");--> statement-breakpoint
CREATE INDEX "studio_transfers_to_user_id_idx" ON "studio_transfers" USING btree ("to_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_transfers_one_pending" ON "studio_transfers" USING btree ("studio_id") WHERE "studio_transfers"."status" = 'pending' AND "studio_transfers"."deleted_at" IS NULL;--> statement-breakpoint

-- Clear the field. Pre-launch, so these three types hold test data only: mark
-- every still-unread one read rather than migrating rows into the new tables.
-- `notifications_type_check` is untouched — the three notification types still
-- exist, they just no longer carry the request itself.
UPDATE "notifications" SET "read_at" = now()
	WHERE "type" IN ('access.role_upgrade_request', 'project.transfer_request', 'studio.transfer_request')
	AND "read_at" IS NULL AND "deleted_at" IS NULL;
