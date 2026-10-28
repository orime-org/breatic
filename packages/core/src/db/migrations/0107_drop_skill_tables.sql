-- inner#1310 — what the retired skill mechanism left in the database goes.
--
-- Generation templates replaced skills, and nothing has read or written these
-- two tables or the two `tasks` columns since: they are no longer declared in
-- `schema.ts`, and no production code names them.
--
-- `skill_installs` holds the only foreign key into `custom_skills`, so it is
-- dropped first. `IF EXISTS` lets the migration run on databases where these
-- objects were already dropped by hand.

DROP TABLE IF EXISTS "skill_installs";--> statement-breakpoint
DROP TABLE IF EXISTS "custom_skills";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "skill_name";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "resolved_skills";
