-- What a node task row was doing, which the row's first line names
-- (inner#888). `kind` stays the behaviour the server settles by. Rows already
-- written take theirs from the job they ran as: an upload has none, a reading
-- and a mini-tool run name themselves in tasks.source, and every other
-- generation is a canvas generation.
ALTER TABLE "node_tasks" ADD COLUMN "action" varchar(20);--> statement-breakpoint
UPDATE "node_tasks" SET "action" = CASE
  WHEN "kind" = 'upload' THEN 'upload'
  ELSE COALESCE(
    (SELECT CASE t."source" WHEN 'understand' THEN 'understand' WHEN 'mini_tool' THEN 'mini_tool' END
     FROM "tasks" AS t WHERE t."id" = "node_tasks"."task_id"),
    'generate'
  )
END;--> statement-breakpoint
ALTER TABLE "node_tasks" ALTER COLUMN "action" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_action_check"
  CHECK ("action" IN ('upload', 'generate', 'understand', 'mini_tool'));--> statement-breakpoint

-- A mini-tool container run is one more step a task keeps across retries.
ALTER TABLE "task_upstream_steps" DROP CONSTRAINT "task_upstream_steps_kind_check";--> statement-breakpoint
ALTER TABLE "task_upstream_steps" ADD CONSTRAINT "task_upstream_steps_kind_check"
  CHECK ("kind" IN ('upload_reference', 'upload_melody', 'vocal', 'voice', 'element', 'generate', 'speak', 'container_job'));--> statement-breakpoint

-- Every attempt of a container run computes the same cost from the same
-- report; the row is written once per task whichever attempt gets there.
CREATE UNIQUE INDEX "agent_usage_records_container_operation_key"
  ON "agent_usage_records" ("operation_key") WHERE "source" = 'container';
