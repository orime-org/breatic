ALTER TABLE "tasks" ADD COLUMN "space_id" uuid NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_project_space_idx" ON "tasks" USING btree ("project_id","space_id");