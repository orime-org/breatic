-- Membership benefits (inner#1968): the per-person running-task limit and
-- studio spend limits. Every schema change of the feature is here, so later
-- steps need no further migration.

-- The studio a charge request counts against, backfilled from its project;
-- a request without a project keeps it empty.
ALTER TABLE "credit_charge_requests" ADD COLUMN "studio_id" uuid
	CONSTRAINT "credit_charge_requests_studio_id_fk" REFERENCES "studios"("id") ON DELETE restrict;
--> statement-breakpoint
UPDATE "credit_charge_requests" AS r SET "studio_id" = p."studio_id" FROM "projects" AS p WHERE p."id" = r."project_id";
--> statement-breakpoint
CREATE INDEX "credit_charge_requests_studio_actor_idx" ON "credit_charge_requests" ("studio_id", "actor_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "credit_charge_requests_release_hold_idx" ON "credit_charge_requests" ("release_hold") WHERE "status" = 'pending' AND "release_hold" IS NOT NULL;
--> statement-breakpoint

-- The running-task term of an agreement; agreements already saved get the
-- default.
ALTER TABLE "enterprise_memberships"
	ADD COLUMN "running_tasks_per_user" integer DEFAULT 10 NOT NULL
		CONSTRAINT "enterprise_memberships_running_tasks_per_user_check" CHECK ("running_tasks_per_user" BETWEEN 1 AND 30);
--> statement-breakpoint

-- Waiting for a running-task slot.
ALTER TABLE "tasks"
	ADD COLUMN "slot_wait_since" timestamp with time zone,
	ADD COLUMN "slot_checked_at" timestamp with time zone,
	ADD COLUMN "slot_wait_limit" integer;
--> statement-breakpoint
ALTER TABLE "timeline_executions"
	ADD COLUMN "slot_wait_since" timestamp with time zone,
	ADD COLUMN "slot_checked_at" timestamp with time zone,
	ADD COLUMN "slot_wait_limit" integer;
--> statement-breakpoint
ALTER TABLE "node_tasks" ADD COLUMN "waiting_since" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "tasks_user_running_idx" ON "tasks" ("user_id", "started_at") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX "tasks_user_slot_wait_idx" ON "tasks" ("user_id", "slot_wait_limit", "created_at") WHERE "status" = 'pending' AND "slot_wait_since" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "timeline_executions_actor_running_idx" ON "timeline_executions" ("actor_user_id", "deadline_at") WHERE "status" IN ('running', 'cancelling');
--> statement-breakpoint
CREATE INDEX "timeline_executions_actor_slot_wait_idx" ON "timeline_executions" ("actor_user_id", "slot_wait_limit", "created_at") WHERE "status" = 'queued' AND "slot_wait_since" IS NOT NULL;
--> statement-breakpoint

-- Monthly spend limits: a studio's per-member default and total, and one
-- member's override. Null means not set (unlimited).
CREATE TABLE "studio_spend_limits" (
	"studio_id" uuid PRIMARY KEY NOT NULL,
	"member_default_credits" numeric(20, 6),
	"studio_monthly_credits" numeric(20, 6),
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "studio_spend_limits_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE restrict,
	CONSTRAINT "studio_spend_limits_updated_by_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE restrict,
	CONSTRAINT "studio_spend_limits_member_default_credits_check" CHECK ("member_default_credits" >= 0),
	CONSTRAINT "studio_spend_limits_studio_monthly_credits_check" CHECK ("studio_monthly_credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "studio_member_spend_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"monthly_credits" numeric(20, 6),
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "studio_member_spend_limits_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE restrict,
	CONSTRAINT "studio_member_spend_limits_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE restrict,
	CONSTRAINT "studio_member_spend_limits_updated_by_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE restrict,
	CONSTRAINT "studio_member_spend_limits_monthly_credits_check" CHECK ("monthly_credits" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "studio_member_spend_limits_live_key" ON "studio_member_spend_limits" ("studio_id", "user_id") WHERE "deleted_at" IS NULL;
