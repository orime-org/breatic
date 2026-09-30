-- #296: one row per paid call the agent makes, written where the call
-- happens. Append-only, like credit_ledger: no updated_at, no deleted_at.

CREATE TABLE "agent_usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_key" varchar(255) NOT NULL,
	"feature" varchar(40) NOT NULL,
	"source" varchar(40) NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"project_id" uuid,
	"model" varchar(100) NOT NULL,
	"provider" varchar(50) NOT NULL,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"request_count" integer,
	"cost_usd" numeric(20, 8) NOT NULL,
	"cost_source" varchar(20) NOT NULL,
	"credits" numeric(20, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_usage_records" ADD CONSTRAINT "agent_usage_records_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_usage_records" ADD CONSTRAINT "agent_usage_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_usage_records_operation_key_idx" ON "agent_usage_records" USING btree ("operation_key");
