-- When each project was last edited, for the studio list's "last edited" sort
-- (#1020). One row per project, moved forward in place; written by collab
-- after a Space document's store lands or a Space changes, and by the server
-- with a rename, description or cover change.
CREATE TABLE "project_edits" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"last_edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "project_edits" ADD CONSTRAINT "project_edits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
