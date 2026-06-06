CREATE TABLE "studio_members" (
	"studio_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_members_studio_id_user_id_pk" PRIMARY KEY("studio_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "studio_members" ADD CONSTRAINT "studio_members_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_members" ADD CONSTRAINT "studio_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_members" ADD CONSTRAINT "studio_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_members_user_id_idx" ON "studio_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "studio_members_studio_id_idx" ON "studio_members" USING btree ("studio_id","deleted_at");--> statement-breakpoint
-- Partial unique — one ACTIVE admin per studio. Drizzle's table builder
-- does not emit partial unique indexes (as of 0.45), so it is appended
-- here manually. Backs the "one studio one admin" invariant referenced in
-- schema.ts (`studio_members_one_admin_per_studio`). Soft-deleted rows
-- (deleted_at IS NOT NULL) are treated as gone, so a previously-removed
-- admin does not block a fresh one.
CREATE UNIQUE INDEX "studio_members_one_admin_per_studio" ON "studio_members" USING btree ("studio_id") WHERE "studio_members"."role" = 'admin' AND "studio_members"."deleted_at" IS NULL;
