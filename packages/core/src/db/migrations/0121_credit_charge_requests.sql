-- inner#1617: a charge for delivered work, recorded in the same transaction as
-- the delivery and settled exactly once. The settlement locks the row, applies
-- the charge and marks it settled in one transaction; a worker sweep retries
-- rows still pending.
--
-- `reference_id` is what the ledger rows of the settlement carry: a task id, a
-- Timeline execution id, or the caller's operation key. One row per kind,
-- actor and reference, the same scope the charge key has always had.

CREATE TABLE "credit_charge_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(24) NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"reference_id" varchar(255) NOT NULL,
	"project_id" uuid,
	"amount" numeric(20, 6) NOT NULL,
	"description" text,
	"model" varchar(100),
	"provider" varchar(50),
	"tokens_used" integer,
	"release_hold" varchar(255),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- No `deleted_at`: soft-deleting a pending row would drop a charge without
-- saying so.

ALTER TABLE "credit_charge_requests" ADD CONSTRAINT "credit_charge_requests_actor_user_id_fk"
	FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "credit_charge_requests" ADD CONSTRAINT "credit_charge_requests_project_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "credit_charge_requests" ADD CONSTRAINT "credit_charge_requests_kind_check"
	CHECK ("kind" IN ('task', 'timeline_execution', 'operation'));--> statement-breakpoint
ALTER TABLE "credit_charge_requests" ADD CONSTRAINT "credit_charge_requests_amount_check" CHECK ("amount" > 0);--> statement-breakpoint
ALTER TABLE "credit_charge_requests" ADD CONSTRAINT "credit_charge_requests_status_check"
	CHECK ("status" IN ('pending', 'settled'));--> statement-breakpoint
ALTER TABLE "credit_charge_requests" ADD CONSTRAINT "credit_charge_requests_settled_at_check"
	CHECK (("status" = 'settled') = ("settled_at" IS NOT NULL));--> statement-breakpoint

CREATE UNIQUE INDEX "credit_charge_requests_key_idx"
	ON "credit_charge_requests" ("kind", "actor_user_id", "reference_id");--> statement-breakpoint
-- What the sweep reads: pending rows, least recently tried first.
CREATE INDEX "credit_charge_requests_pending_idx" ON "credit_charge_requests" ("updated_at") WHERE "status" = 'pending';
