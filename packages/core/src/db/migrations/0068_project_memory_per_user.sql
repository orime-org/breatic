-- Task #148 — project memory becomes one row per member per project.
--
-- The old rows are keyed by project alone, so there is no member to name when
-- the column arrives: `ADD COLUMN ... NOT NULL REFERENCES users(id)` rejects
-- any filler value, and a nullable column would leave rows that no read path
-- can attribute. They are cleared first.
--
-- Clearing loses nothing that cannot be produced again. The content is what a
-- consolidation wrote; the conversations it read are still in `messages`, and
-- the next consolidation writes a fresh row. The rows present today were all
-- made during development.
--
-- `deleted_at` is not the tool here: the three read functions in
-- `memory.repo.ts` do not filter on it, so a soft-deleted row is still handed
-- to the model.

DELETE FROM "project_memories";--> statement-breakpoint
ALTER TABLE "project_memories" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
DROP INDEX IF EXISTS "project_memories_project_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "project_memories_user_project_idx" ON "project_memories" ("user_id","project_id");
