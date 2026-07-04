-- Project activity feed (ADR 2026-07-04 project-activity-feed): one unified
-- append-only PG table replacing the meta-doc `projectMessages` Y.Array
-- (retired without data migration - pre-launch). Hand-written (drizzle-kit
-- generate needs a TTY; same pattern as 0025..0033: .sql + _journal entry,
-- no snapshot).
--
-- Append-only for INDIVIDUAL rows (never user-deleted; the only mutable
-- column is `restored`, the restore-consumption marker on space:deleted
-- rows), but project-scoped: it carries `deleted_at` and is soft-deleted
-- by the deleteProject cascade — same as node_history. No updated_at.

CREATE TABLE IF NOT EXISTS "project_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"type" varchar(64) NOT NULL,
	"space_id" uuid,
	"node_id" uuid,
	"task_id" uuid,
	"payload" jsonb NOT NULL,
	"restored" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "project_activities" ADD CONSTRAINT "project_activities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "project_activities" ADD CONSTRAINT "project_activities_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "project_activities" ADD CONSTRAINT "project_activities_type_check" CHECK (
	"type" IN (
		'asset:uploaded',
		'asset:deleted',
		'generation:succeeded',
		'generation:failed',
		'space:created',
		'space:deleted',
		'space:restored',
		'space:locked',
		'space:unlocked',
		'space:renamed',
		'member:joined',
		'member:removed',
		'member:role-changed',
		'member:ownership-transferred'
	)
);--> statement-breakpoint

-- Hot feed index: keyset pagination WHERE (created_at, id) < (?, ?)
-- ORDER BY created_at DESC, id DESC scoped to one project. Partial on
-- deleted_at IS NULL — the feed only ever serves live rows (a deleted
-- project's rows are cascade-soft-deleted), so the index stays lean.
CREATE INDEX IF NOT EXISTS "project_activities_feed_idx" ON "project_activities" ("project_id", "created_at" DESC, "id" DESC) WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Generation idempotency: worker Stage 4 re-runs on billed redelivery;
-- one activity row per task. Partial unique (Drizzle's builder does not
-- emit partial unique indexes - same note as project_invitations).
CREATE UNIQUE INDEX IF NOT EXISTS "project_activities_task_unique" ON "project_activities" ("task_id") WHERE "task_id" IS NOT NULL;
