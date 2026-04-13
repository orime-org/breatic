CREATE TABLE "node_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"node_id" varchar(255) NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_type" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"content" text,
	"thumbnail_url" text,
	"error_message" text,
	"task_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT "node_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT "node_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT "node_history_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_history_node_idx" ON "node_history" USING btree ("project_id","node_id","created_at");