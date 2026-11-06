-- A 3D Space keeps its model uploads as Space-level task rows (inner#1690):
-- no node, the registered asset on the row, and only the scene import action
-- may leave the node empty.
ALTER TABLE "node_tasks" ALTER COLUMN "node_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "node_tasks" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "studio_assets"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "node_tasks" DROP CONSTRAINT "node_tasks_action_check";--> statement-breakpoint
ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_action_check"
  CHECK ("action" IN ('upload', 'generate', 'understand', 'mini_tool', 'transcribe', 'scene_import'));--> statement-breakpoint
ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_space_row_check"
  CHECK ("node_id" IS NOT NULL OR "action" = 'scene_import');--> statement-breakpoint
CREATE INDEX "node_tasks_space_live_idx" ON "node_tasks" ("project_id", "space_id", "started_at")
  WHERE "node_id" IS NULL AND "deleted_at" IS NULL;
