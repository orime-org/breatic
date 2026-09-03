-- One row per task running on a canvas node (#186).
--
-- Deliberately without any unique index over node_id: the point of the table
-- is that a node may carry several running tasks at once, and a partial
-- unique `(node_id) WHERE status = 'running'` would restore the single
-- handling lease this task exists to remove.
--
-- The result lives in node_history; node_history_id points at it, so one
-- result has one home. RESTRICT because a task must never be left pointing
-- at a row that went away.

CREATE TABLE IF NOT EXISTS "node_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "space_id" uuid NOT NULL,
  "node_id" uuid NOT NULL,
  "kind" varchar(20) NOT NULL,
  "status" varchar(20) NOT NULL,
  "started_by_user_id" uuid NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "budget_ms" integer NOT NULL,
  "label" text NOT NULL,
  "error_message" text,
  "node_history_id" uuid,
  "task_id" uuid,
  "storage_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_node_history_id_node_history_id_fk" FOREIGN KEY ("node_history_id") REFERENCES "public"."node_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Every read starts from "which tasks are on this node", and the recount
-- after each state change runs the same way.
CREATE INDEX IF NOT EXISTS "node_tasks_node_idx"
  ON "node_tasks" ("project_id", "node_id");--> statement-breakpoint

-- The timer Durable Object is the one that judges expiry, so nothing here
-- scans by deadline. This index serves the list endpoint's live rows.
CREATE INDEX IF NOT EXISTS "node_tasks_live_idx"
  ON "node_tasks" ("node_id", "status")
  WHERE "deleted_at" IS NULL;
