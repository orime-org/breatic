-- Membership benefits (inner#1968): monthly operations, the per-person
-- running-task limit, and studio spend limits. Every schema change of the
-- feature is here, so later steps need no further migration.

-- One row per operation: reserved at admission, counted with its success, or
-- released. Append-only, so no deleted_at.
CREATE TABLE "operation_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_key" varchar(255) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"account_user_id" uuid NOT NULL,
	"studio_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"status" varchar(10) NOT NULL,
	"admitted_as" varchar(8) NOT NULL,
	"overage_hold" varchar(255),
	"asset_id" uuid,
	"absorbed_by" varchar(255),
	"absorbed_hold_released" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"input_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"slot" varchar(10),
	"period_start" timestamp with time zone,
	"counted_at" timestamp with time zone,
	"charge_request_id" uuid,
	"released_at" timestamp with time zone,
	"release_reason" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_ledger_operation_key_key" UNIQUE ("operation_key"),
	CONSTRAINT "operation_ledger_account_user_id_fk" FOREIGN KEY ("account_user_id") REFERENCES "users"("id") ON DELETE restrict,
	CONSTRAINT "operation_ledger_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE restrict,
	CONSTRAINT "operation_ledger_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE restrict,
	CONSTRAINT "operation_ledger_actor_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE restrict,
	CONSTRAINT "operation_ledger_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "studio_assets"("id") ON DELETE restrict,
	CONSTRAINT "operation_ledger_kind_check" CHECK ("kind" IN ('generation', 'tool_run', 'upload', 'url_paste', 'chat_message', 'text_tool', 'timeline')),
	CONSTRAINT "operation_ledger_status_check" CHECK ("status" IN ('reserved', 'deferred', 'counted', 'released')),
	CONSTRAINT "operation_ledger_admitted_as_check" CHECK ("admitted_as" IN ('covered', 'held')),
	CONSTRAINT "operation_ledger_slot_check" CHECK ("slot" IN ('allowance', 'overage')),
	CONSTRAINT "operation_ledger_counted_check" CHECK (("status" = 'counted') = ("slot" IS NOT NULL AND "period_start" IS NOT NULL AND "counted_at" IS NOT NULL)),
	CONSTRAINT "operation_ledger_released_check" CHECK (("status" = 'released') = ("released_at" IS NOT NULL)),
	CONSTRAINT "operation_ledger_held_check" CHECK ("admitted_as" <> 'held' OR "overage_hold" IS NOT NULL),
	CONSTRAINT "operation_ledger_deferred_check" CHECK ("status" <> 'deferred' OR "asset_id" IS NOT NULL),
	CONSTRAINT "operation_ledger_project_check" CHECK ("project_id" IS NOT NULL OR "kind" = 'upload')
);
--> statement-breakpoint
ALTER TABLE "operation_ledger" ADD CONSTRAINT "operation_ledger_charge_request_id_fk"
	FOREIGN KEY ("charge_request_id") REFERENCES "credit_charge_requests"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX "operation_ledger_period_idx" ON "operation_ledger" ("account_user_id", "period_start") WHERE "status" = 'counted';
--> statement-breakpoint
CREATE INDEX "operation_ledger_in_flight_idx" ON "operation_ledger" ("account_user_id", "expires_at") WHERE "status" IN ('reserved', 'deferred');
--> statement-breakpoint
CREATE INDEX "operation_ledger_deferred_asset_idx" ON "operation_ledger" ("studio_id", "asset_id") WHERE "status" = 'deferred';
--> statement-breakpoint
CREATE INDEX "operation_ledger_deferred_expiry_idx" ON "operation_ledger" ("expires_at") WHERE "status" = 'deferred';
--> statement-breakpoint

-- A charge for an operation past the monthly allowance.
ALTER TABLE "credit_charge_requests" DROP CONSTRAINT "credit_charge_requests_kind_check";
--> statement-breakpoint
ALTER TABLE "credit_charge_requests" ADD CONSTRAINT "credit_charge_requests_kind_check"
	CHECK ("kind" IN ('task', 'timeline_execution', 'operation', 'operation_overage'));
--> statement-breakpoint

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

-- The two operation terms of an agreement; agreements already saved get the
-- defaults.
ALTER TABLE "enterprise_memberships"
	ADD COLUMN "monthly_operations" integer DEFAULT 16000 NOT NULL
		CONSTRAINT "enterprise_memberships_monthly_operations_check" CHECK ("monthly_operations" >= 0),
	ADD COLUMN "running_tasks_per_user" integer DEFAULT 10 NOT NULL
		CONSTRAINT "enterprise_memberships_running_tasks_per_user_check" CHECK ("running_tasks_per_user" BETWEEN 1 AND 30);
--> statement-breakpoint

-- Stripe's billing cycle anchor, which the monthly periods count from.
ALTER TABLE "subscriptions" ADD COLUMN "billing_cycle_anchor" timestamp with time zone;
--> statement-breakpoint

-- The ledger key an upload grant counts under, written when it is issued.
ALTER TABLE "upload_grants" ADD COLUMN "operation_key" varchar(255);
--> statement-breakpoint
CREATE INDEX "upload_grants_operation_key_idx" ON "upload_grants" ("operation_key") WHERE "operation_key" IS NOT NULL;
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
