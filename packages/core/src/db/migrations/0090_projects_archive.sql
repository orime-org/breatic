-- A project is archived instead of deleted (#1222). An archived project is
-- read-only for every member and can be restored by its studio's admin. The
-- two columns move together: both null on a live project, both set on an
-- archived one.
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_archived_pair" CHECK (("archived_at" IS NULL) = ("archived_by_user_id" IS NULL));
