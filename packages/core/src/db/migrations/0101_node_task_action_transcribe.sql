-- A transcription's row names itself apart from an understanding's
-- (inner#856), so the row's first line says which press it was.
ALTER TABLE "node_tasks" DROP CONSTRAINT "node_tasks_action_check";--> statement-breakpoint
ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_action_check"
  CHECK ("action" IN ('upload', 'generate', 'understand', 'mini_tool', 'transcribe'));
