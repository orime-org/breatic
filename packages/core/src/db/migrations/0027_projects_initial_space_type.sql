-- B.2: projects gain `initial_space_type` — the Space type seeded on
-- first open. varchar(16) with NO check constraint (same pattern as
-- studio_members.role) so adding 3d/plan later is a zero-migration
-- change. Canvas is the only editable type today; document/timeline are
-- stored + seeded but disabled in the create picker until their editors
-- ship. Default 'canvas'; existing rows backfill to the default.
--
-- Hand-written (drizzle-kit generate needs a TTY here; same pattern as
-- 0025/0026: .sql + _journal entry, no snapshot).
--
-- spec: breatic-inner/engineering/specs/2026-06-07-project-create-spacetype-vertical-design.md

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "initial_space_type" varchar(16) NOT NULL DEFAULT 'canvas';
