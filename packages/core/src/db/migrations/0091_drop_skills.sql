-- The skill mechanism is replaced by generation templates written in code
-- (inner#977). Neither table had a writer, `tasks.skill_name` was only set by
-- skill runs, which nothing could start, and `tasks.resolved_skills` held `[]`
-- on every other row. Deploy the code that stops reading and writing them
-- before running this.
DROP TABLE "skill_installs";--> statement-breakpoint
DROP TABLE "custom_skills";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "skill_name";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "resolved_skills";
