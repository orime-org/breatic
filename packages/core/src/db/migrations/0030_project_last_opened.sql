-- "Recent" landing: per-user project-open tracker.
--
-- One row per (user, project). Opening a project UPSERTs `last_opened_at =
-- now()` in place (composite PK (user_id, project_id)), so re-opening floats
-- the project to the top of that user's recent feed. Ordering is per-user.
--
--   last_opened_at — the viewer's most-recent open time (the sort key).
--   created_at     — first-open time (every-table-has-created_at rule).
--
-- No `updated_at` (the mutable timestamp IS `last_opened_at`) and no
-- `deleted_at` (no soft-delete semantics — a row for a deleted / now-
-- inaccessible project is filtered out by the recent query's JOIN + access
-- predicate, so a leftover row is harmless). Both FKs are `restrict`
-- (soft-delete-only project rule → references never dangle).
--
-- Hand-written (drizzle-kit generate needs a TTY here; same pattern as
-- 0018/0025/0026: .sql + _journal entry, no snapshot).
--
-- spec: breatic-inner/engineering/specs/2026-06-16-studio-recent-landing-design.md §3

CREATE TABLE IF NOT EXISTS "project_last_opened" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"last_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_last_opened_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "project_last_opened" ADD CONSTRAINT "project_last_opened_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "project_last_opened" ADD CONSTRAINT "project_last_opened_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "project_last_opened_user_idx" ON "project_last_opened" ("user_id","last_opened_at");
