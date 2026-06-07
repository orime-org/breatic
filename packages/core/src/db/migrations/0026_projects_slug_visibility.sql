-- Slice 2: projects gain `slug` + `visibility`.
--
--   slug       — URL slug for /project/{slug}-{uuid}. NOT NULL (every
--                project needs a slug for its URL), format-validated
--                app-side, NOT unique (same-name disambiguated by uuid).
--   visibility — 'studio' (open baseline, visible to all studio members)
--                | 'private' (explicit project_members only). Default
--                'studio'.
--
-- Hand-written (drizzle-kit generate needs a TTY here; same pattern as
-- 0018/0025: .sql + _journal entry, no snapshot).
--
-- Backfill existing rows (dev only, no prod data pre-launch): visibility
-- takes the column default; slug is derived from the id so it satisfies
-- the format ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ and NOT NULL.
--
-- spec: breatic-inner/engineering/specs/2026-06-06-studio-slice2-projects-design.md

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "visibility" varchar(16) NOT NULL DEFAULT 'studio';--> statement-breakpoint

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "slug" varchar(120);--> statement-breakpoint

UPDATE "projects" SET "slug" = 'p-' || substr(replace("id"::text, '-', ''), 1, 12) WHERE "slug" IS NULL;--> statement-breakpoint

ALTER TABLE "projects" ALTER COLUMN "slug" SET NOT NULL;
