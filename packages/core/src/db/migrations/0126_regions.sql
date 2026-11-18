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
-- Found by table, column and referenced table: a database whose tables were
-- built by an earlier draft of a migration names the same key differently.
DO $$
DECLARE
  target record;
  fk record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('account_activity_events', 'user_id', 'users'),
    ('agent_memories', 'user_id', 'users'),
    ('agent_usage_records', 'actor_user_id', 'users'),
    ('conversation_attachments', 'user_id', 'users'),
    ('conversation_messages', 'user_id', 'users'),
    ('conversations', 'user_id', 'users'),
    ('credit_charge_requests', 'actor_user_id', 'users'),
    ('credit_compensations', 'personal_studio_id', 'studios'),
    ('credit_gifts', 'personal_studio_id', 'studios'),
    ('credit_holds', 'studio_id', 'studios'),
    ('credit_ledger', 'project_id', 'projects'),
    ('credit_ledger', 'studio_id', 'studios'),
    ('credit_lots', 'designated_studio_id', 'studios'),
    ('credit_settlement_receipts', 'actor_user_id', 'users'),
    ('document_versions', 'created_by_user_id', 'users'),
    ('document_versions', 'deleted_by_user_id', 'users'),
    ('media_understanding_attempts', 'approval_actor_user_id', 'users'),
    ('media_understanding_operations', 'actor_user_id', 'users'),
    ('node_history', 'user_id', 'users'),
    ('node_tasks', 'started_by_user_id', 'users'),
    ('notifications', 'user_id', 'users'),
    ('project_activities', 'actor_user_id', 'users'),
    ('project_agent_instructions', 'updated_by_user_id', 'users'),
    ('project_invitations', 'invited_by', 'users'),
    ('project_invitations', 'invited_user_id', 'users'),
    ('project_join_requests', 'decided_by_user_id', 'users'),
    ('project_join_requests', 'requester_user_id', 'users'),
    ('project_last_opened', 'user_id', 'users'),
    ('project_members', 'added_by', 'users'),
    ('project_members', 'user_id', 'users'),
    ('project_memories', 'user_id', 'users'),
    ('project_memory_entries', 'author_id', 'users'),
    ('project_transfers', 'from_user_id', 'users'),
    ('project_transfers', 'to_user_id', 'users'),
    ('projects', 'archived_by_user_id', 'users'),
    ('projects', 'created_by_user_id', 'users'),
    ('role_upgrade_requests', 'decided_by_user_id', 'users'),
    ('role_upgrade_requests', 'requester_user_id', 'users'),
    ('studio_assets', 'produced_by_user_id', 'users'),
    ('studio_credit_debts', 'studio_id', 'studios'),
    ('studio_invitations', 'invited_by', 'users'),
    ('studio_invitations', 'invited_user_id', 'users'),
    ('studio_members', 'added_by', 'users'),
    ('studio_members', 'user_id', 'users'),
    ('studio_transfers', 'from_user_id', 'users'),
    ('studio_transfers', 'to_user_id', 'users'),
    ('studios', 'created_by_user_id', 'users'),
    ('tasks', 'user_id', 'users'),
    ('timeline_executions', 'actor_user_id', 'users'),
    ('upload_grants', 'user_id', 'users'),
    ('usage_settlement_envelopes', 'actor_user_id', 'users')
  ) AS t(tbl, col, ref) LOOP
    FOR fk IN
      SELECT c.conname FROM pg_constraint c
      JOIN pg_class owner ON owner.oid = c.conrelid AND owner.relname = target.tbl
      JOIN pg_namespace ns ON ns.oid = owner.relnamespace AND ns.nspname = 'public'
      JOIN pg_class referenced ON referenced.oid = c.confrelid AND referenced.relname = target.ref
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = target.col
      WHERE c.contype = 'f' AND c.conkey = ARRAY[a.attnum]
    LOOP
      EXECUTE 'ALTER TABLE ' || quote_ident(target.tbl) || ' DROP CONSTRAINT ' || quote_ident(fk.conname);
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint

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
