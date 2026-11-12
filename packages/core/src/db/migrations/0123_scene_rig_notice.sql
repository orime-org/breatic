-- Rigging a generated 3D model is one more upstream step (inner#1692), and a
-- rig that failed leaves the delivered model with a notice on its Space row.
ALTER TABLE "task_upstream_steps" DROP CONSTRAINT "task_upstream_steps_kind_check";--> statement-breakpoint
ALTER TABLE "task_upstream_steps" ADD CONSTRAINT "task_upstream_steps_kind_check"
  CHECK ("kind" IN ('upload_reference', 'upload_melody', 'vocal', 'voice', 'element', 'generate', 'speak', 'rig', 'container_job'));--> statement-breakpoint
ALTER TABLE "node_tasks" ADD COLUMN "notice" varchar(24);--> statement-breakpoint
ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_notice_check"
  CHECK ("notice" IN ('rig_failed'));
