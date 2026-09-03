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
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE RESTRICT,
  "space_id" uuid NOT NULL,
  "node_id" uuid NOT NULL,
  "kind" varchar(20) NOT NULL,
  "status" varchar(20) NOT NULL,
  "started_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "budget_ms" integer NOT NULL,
  "label" text NOT NULL,
  "error_message" text,
  "node_history_id" uuid REFERENCES "node_history"("id") ON DELETE RESTRICT,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "storage_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);

-- Every read starts from "which tasks are on this node", and the recount
-- after each state change runs the same way.
CREATE INDEX IF NOT EXISTS "node_tasks_node_idx"
  ON "node_tasks" ("project_id", "node_id");

-- The timer Durable Object is the one that judges expiry, so nothing here
-- scans by deadline. This index serves the list endpoint's live rows.
CREATE INDEX IF NOT EXISTS "node_tasks_live_idx"
  ON "node_tasks" ("node_id", "status")
  WHERE "deleted_at" IS NULL;
