-- #2156: a task that makes more than one upstream call, and the studio's
-- cache of what it has had cloned upstream.
--
-- `task_upstream_steps` holds one row per upstream call of a task, in order.
-- The worker writes the list on the task's first run and advances each step
-- pending -> submitted -> done | failed; a redelivered job resumes from the
-- first step that is not done. No `deleted_at`: a step follows its task,
-- which is soft-deleted, and what the task is billed is summed over its
-- steps.
--
-- `studio_upstream_clones` holds the voice, vocal and element ids cloned from
-- a studio's sources. At most one live row per (studio, kind, source): the
-- partial unique index settles two runs cloning the same source at once.
--
-- Hand-written (same pattern as 0061 / 0079): .sql + _journal entry, no
-- snapshot. The CHECK constraints are maintained here, not declared in
-- drizzle, for the reason 0061 gives.

CREATE TABLE "task_upstream_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" varchar(24) NOT NULL,
	"endpoint" varchar(200) NOT NULL,
	"item_index" integer,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"prediction_id" text,
	"output" jsonb,
	"inline_cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_upstream_steps_task_id_tasks_id_fk"
		FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE restrict,
	CONSTRAINT "task_upstream_steps_kind_check"
		CHECK ("kind" IN ('upload_reference', 'upload_melody', 'vocal', 'voice', 'element', 'generate', 'speak')),
	CONSTRAINT "task_upstream_steps_status_check"
		CHECK ("status" IN ('pending', 'submitted', 'done', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "task_upstream_steps_task_position_key" ON "task_upstream_steps" ("task_id", "position");
--> statement-breakpoint

CREATE TABLE "studio_upstream_clones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"source_key" text NOT NULL,
	"upstream_id" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_upstream_clones_studio_id_studios_id_fk"
		FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE restrict,
	CONSTRAINT "studio_upstream_clones_kind_check"
		CHECK ("kind" IN ('voice', 'vocal', 'element'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "studio_upstream_clones_live_key" ON "studio_upstream_clones" ("studio_id", "kind", "source_key") WHERE "deleted_at" IS NULL;
