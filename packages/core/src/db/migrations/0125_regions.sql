-- Regions (inner#1955).
--
-- Every region runs this same migration. Global tables exist everywhere and
-- hold rows only in the global region; regional tables hold each region's own
-- Studios. Foreign keys that would cross that line are dropped: a row in one
-- database cannot point at a row that lives in another.
--
-- On a database that already has data (the global region before regions
-- existed, or a self-hosted deployment) the directory is filled from the
-- Studios, members and Projects already here, all with region NULL (the
-- global region). An empty database fills nothing.

-- ── 1. Foreign keys across the global / regional line ────────────────
-- An earlier migration in the same run may leave deferred constraint checks
-- pending on these tables, and ALTER TABLE refuses a table with pending
-- trigger events; run them now.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_project_id_fk";--> statement-breakpoint
ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_studio_id_fk";--> statement-breakpoint
ALTER TABLE "credit_lots" DROP CONSTRAINT "credit_lots_designated_studio_id_fk";--> statement-breakpoint
ALTER TABLE "studio_credit_debts" DROP CONSTRAINT "studio_credit_debts_studio_id_fk";--> statement-breakpoint
ALTER TABLE "credit_holds" DROP CONSTRAINT "credit_holds_studio_id_fk";--> statement-breakpoint
ALTER TABLE "credit_compensations" DROP CONSTRAINT "credit_compensations_studio_fk";--> statement-breakpoint
ALTER TABLE "credit_gifts" DROP CONSTRAINT "credit_gifts_studio_fk";--> statement-breakpoint
ALTER TABLE "agent_usage_records" DROP CONSTRAINT "agent_usage_records_actor_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_attachments" DROP CONSTRAINT "conversation_attachments_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_messages" DROP CONSTRAINT "conversation_messages_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "node_history" DROP CONSTRAINT "node_history_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "node_tasks" DROP CONSTRAINT "node_tasks_started_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_activities" DROP CONSTRAINT "project_activities_actor_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_invitations" DROP CONSTRAINT "project_invitations_invited_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_invitations" DROP CONSTRAINT "project_invitations_invited_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_join_requests" DROP CONSTRAINT "project_join_requests_decided_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_join_requests" DROP CONSTRAINT "project_join_requests_requester_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_last_opened" DROP CONSTRAINT "project_last_opened_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_members" DROP CONSTRAINT "project_members_added_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_members" DROP CONSTRAINT "project_members_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_memories" DROP CONSTRAINT "project_memories_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_memory_entries" DROP CONSTRAINT "project_memory_entries_author_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_transfers" DROP CONSTRAINT "project_transfers_from_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_transfers" DROP CONSTRAINT "project_transfers_to_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_archived_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_created_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" DROP CONSTRAINT "role_upgrade_requests_decided_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" DROP CONSTRAINT "role_upgrade_requests_requester_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "studio_assets" DROP CONSTRAINT "studio_assets_produced_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "studio_invitations" DROP CONSTRAINT "studio_invitations_invited_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "studio_invitations" DROP CONSTRAINT "studio_invitations_invited_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "studio_members" DROP CONSTRAINT "studio_members_added_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "studio_members" DROP CONSTRAINT "studio_members_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "studio_transfers" DROP CONSTRAINT "studio_transfers_from_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "studio_transfers" DROP CONSTRAINT "studio_transfers_to_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "studios" DROP CONSTRAINT "studios_owner_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "upload_grants" DROP CONSTRAINT "upload_grants_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "media_understanding_operations" DROP CONSTRAINT "media_understanding_operations_actor_user_id_fk";--> statement-breakpoint
ALTER TABLE "media_understanding_attempts" DROP CONSTRAINT "media_understanding_attempts_approval_actor_fk";--> statement-breakpoint
ALTER TABLE "usage_settlement_envelopes" DROP CONSTRAINT "usage_settlement_envelopes_actor_user_id_fk";--> statement-breakpoint
ALTER TABLE "credit_settlement_receipts" DROP CONSTRAINT "credit_settlement_receipts_actor_user_id_fk";--> statement-breakpoint
ALTER TABLE "account_activity_events" DROP CONSTRAINT "account_activity_events_user_id_fkey";--> statement-breakpoint
ALTER TABLE "agent_memories" DROP CONSTRAINT "agent_memories_user_id_fkey";--> statement-breakpoint
ALTER TABLE "timeline_executions" DROP CONSTRAINT "timeline_executions_actor_user_id_fkey";--> statement-breakpoint
ALTER TABLE "credit_charge_requests" DROP CONSTRAINT "credit_charge_requests_actor_user_id_fk";--> statement-breakpoint
ALTER TABLE "project_agent_instructions" DROP CONSTRAINT "project_agent_instructions_updated_by_fk";--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT "document_versions_created_by_user_id_fkey";--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT "document_versions_deleted_by_user_id_fkey";--> statement-breakpoint

-- ── 2. Global tables ─────────────────────────────────────────────────
CREATE TABLE "studio_directory" (
  "studio_id" uuid PRIMARY KEY NOT NULL,
  "slug" varchar(64) NOT NULL,
  "region" varchar(32),
  "type" varchar(16) NOT NULL,
  "name" varchar(255) NOT NULL,
  "avatar_url" text,
  "admin_user_id" uuid NOT NULL CONSTRAINT "studio_directory_admin_user_id_users_id_fk" REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_by_user_id" uuid NOT NULL CONSTRAINT "studio_directory_created_by_user_id_users_id_fk" REFERENCES "users" ("id") ON DELETE RESTRICT,
  "state" varchar(16) DEFAULT 'live' NOT NULL,
  "transfer_pending_until" timestamp with time zone,
  "last_admin_change_id" varchar(64),
  "version" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "studio_directory_type_check" CHECK ("type" IN ('personal', 'team')),
  CONSTRAINT "studio_directory_state_check" CHECK ("state" IN ('pending', 'live'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "studio_directory_slug_live" ON "studio_directory" ("slug") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "studio_directory_one_personal" ON "studio_directory" ("created_by_user_id") WHERE "type" = 'personal' AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "studio_directory_admin_idx" ON "studio_directory" ("admin_user_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "studio_directory_pending_idx" ON "studio_directory" ("created_at") WHERE "state" = 'pending' AND "deleted_at" IS NULL;--> statement-breakpoint

CREATE TABLE "studio_directory_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "studio_id" uuid NOT NULL CONSTRAINT "studio_directory_members_studio_id_fk" REFERENCES "studio_directory" ("studio_id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL CONSTRAINT "studio_directory_members_user_id_users_id_fk" REFERENCES "users" ("id") ON DELETE RESTRICT,
  "role" varchar(16) NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX "studio_directory_members_key" ON "studio_directory_members" ("studio_id", "user_id");--> statement-breakpoint
CREATE INDEX "studio_directory_members_user_idx" ON "studio_directory_members" ("user_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE TABLE "project_directory" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "studio_id" uuid NOT NULL CONSTRAINT "project_directory_studio_id_studio_directory_studio_id_fk" REFERENCES "studio_directory" ("studio_id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "project_directory_studio_idx" ON "project_directory" ("studio_id");--> statement-breakpoint

CREATE TABLE "user_regions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL CONSTRAINT "user_regions_user_id_users_id_fk" REFERENCES "users" ("id") ON DELETE RESTRICT,
  "region" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "user_regions_key" ON "user_regions" ("user_id", "region");--> statement-breakpoint

CREATE TABLE "slug_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(64) NOT NULL,
  "studio_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX "slug_reservations_slug_live" ON "slug_reservations" ("slug") WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE TABLE "credit_charge_settlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "region" varchar(32) NOT NULL,
  "request_id" uuid NOT NULL,
  "outcome" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "credit_charge_settlements_key" ON "credit_charge_settlements" ("region", "request_id");--> statement-breakpoint

CREATE TABLE "studio_storage_usage_global" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "studio_id" uuid NOT NULL,
  "region" varchar(32) NOT NULL,
  "bytes" bigint NOT NULL,
  "as_of" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "studio_storage_usage_global_key" ON "studio_storage_usage_global" ("studio_id", "region");--> statement-breakpoint

CREATE TABLE "region_outbox_applied" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "region" varchar(32) NOT NULL,
  "aggregate_key" varchar(160) NOT NULL,
  "last_id" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "region_outbox_applied_key" ON "region_outbox_applied" ("region", "aggregate_key");--> statement-breakpoint

CREATE TABLE "directory_reconciliations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

-- ── 3. Regional tables ───────────────────────────────────────────────
CREATE TABLE "region_outbox" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "aggregate_key" varchar(160) NOT NULL,
  "event_type" varchar(48) NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "region_outbox_unsent_idx" ON "region_outbox" ("id") WHERE "sent_at" IS NULL;--> statement-breakpoint

CREATE TABLE "region_outbox_dead_letters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outbox_id" bigint NOT NULL CONSTRAINT "region_outbox_dead_letters_outbox_id_region_outbox_id_fk" REFERENCES "region_outbox" ("id") ON DELETE RESTRICT,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "region_outbox_dead_letters_outbox_key" ON "region_outbox_dead_letters" ("outbox_id");--> statement-breakpoint

CREATE TABLE "studio_creation_tombstones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "studio_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "studio_creation_tombstones_studio_key" ON "studio_creation_tombstones" ("studio_id");--> statement-breakpoint

-- ── 4. Changed columns ───────────────────────────────────────────────
ALTER TABLE "credit_charge_requests" ADD COLUMN "studio_id" uuid;--> statement-breakpoint
ALTER TABLE "studio_transfers" DROP CONSTRAINT "studio_transfers_status_check";--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_status_check" CHECK ("status" IN ('pending', 'accepting', 'accepted', 'declined', 'cancelled', 'failed'));--> statement-breakpoint
DROP INDEX "studio_transfers_one_pending";--> statement-breakpoint
CREATE UNIQUE INDEX "studio_transfers_one_pending" ON "studio_transfers" USING btree ("studio_id") WHERE "studio_transfers"."status" IN ('pending', 'accepting') AND "studio_transfers"."deleted_at" IS NULL;--> statement-breakpoint

-- ── 5. Fill the directory from what is already here ──────────────────
INSERT INTO "studio_directory" (
  "studio_id", "slug", "region", "type", "name", "avatar_url", "admin_user_id",
  "created_by_user_id", "state", "transfer_pending_until", "created_at", "updated_at", "deleted_at"
)
SELECT
  s."id", s."slug", NULL, s."type", s."name", s."avatar_url",
  COALESCE(
    (SELECT m."user_id" FROM "studio_members" m
      WHERE m."studio_id" = s."id" AND m."role" = 'admin' AND m."deleted_at" IS NULL
      ORDER BY m."created_at" LIMIT 1),
    s."created_by_user_id"
  ),
  s."created_by_user_id", 'live',
  (SELECT t."expires_at" FROM "studio_transfers" t
    WHERE t."studio_id" = s."id" AND t."status" = 'pending' AND t."deleted_at" IS NULL AND t."expires_at" > now()
    LIMIT 1),
  s."created_at", s."updated_at", s."deleted_at"
FROM "studios" s;--> statement-breakpoint

INSERT INTO "studio_directory_members" ("studio_id", "user_id", "role", "created_at", "updated_at", "deleted_at")
SELECT DISTINCT ON (m."studio_id", m."user_id")
  m."studio_id", m."user_id", m."role", m."created_at", m."updated_at", m."deleted_at"
FROM "studio_members" m
ORDER BY m."studio_id", m."user_id", (m."deleted_at" IS NULL) DESC, m."updated_at" DESC;--> statement-breakpoint

INSERT INTO "project_directory" ("project_id", "studio_id", "created_at", "deleted_at")
SELECT p."id", p."studio_id", p."created_at", p."deleted_at" FROM "projects" p;--> statement-breakpoint

UPDATE "credit_charge_requests" r SET "studio_id" = p."studio_id"
FROM "projects" p WHERE r."project_id" = p."id";
