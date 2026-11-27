-- A copied Project is being copied until collab has copied its documents (inner#1706). The duplicate request writes
-- the Project it was copied from; collab writes the completion time once the documents are in. A Project with a
-- source and no completion time is still being copied and does not open. Both stay null on every other Project.
ALTER TABLE "projects" ADD COLUMN "duplicated_from_id" uuid CONSTRAINT "projects_duplicated_from_id_projects_id_fk" REFERENCES "projects"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "duplicate_completed_at" timestamp with time zone;
