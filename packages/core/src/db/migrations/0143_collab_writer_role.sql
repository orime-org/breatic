-- collab's database role (inner#2043): it reads every product table and
-- writes only what COLLAB_WRITE_SCOPE (packages/core/src/db/collab-write-scope.ts)
-- lists. It cannot log in; the migration command creates collab's login and
-- grants it this role. Role names are cluster-wide, so several databases on
-- one cluster can each run this.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_writer') THEN
    CREATE ROLE collab_writer NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO collab_writer;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO collab_writer;
--> statement-breakpoint
-- Tables later migrations create, under the same migrating account, are readable and not writable.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO collab_writer;
--> statement-breakpoint
GRANT INSERT ON project_activities TO collab_writer;
--> statement-breakpoint
GRANT UPDATE (restored) ON project_activities TO collab_writer;
--> statement-breakpoint
GRANT INSERT ON account_activity_events TO collab_writer;
--> statement-breakpoint
GRANT INSERT ON project_edits TO collab_writer;
--> statement-breakpoint
GRANT UPDATE (last_edited_at) ON project_edits TO collab_writer;
--> statement-breakpoint
GRANT UPDATE (duplicate_completed_at) ON projects TO collab_writer;
