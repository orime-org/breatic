-- A 3D Space's generations are Space-level task rows too (inner#1691): no
-- node, the generate action, and where the run was started from.
ALTER TABLE "node_tasks" DROP CONSTRAINT "node_tasks_space_row_check";--> statement-breakpoint
ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_space_row_check"
  CHECK ("node_id" IS NOT NULL OR "action" IN ('scene_import', 'generate'));--> statement-breakpoint
ALTER TABLE "node_tasks" ADD COLUMN "origin" varchar(16);--> statement-breakpoint
ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_origin_check"
  CHECK ("origin" IN ('space', 'agent'));
