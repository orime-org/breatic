-- Remove regions (#1556): take back what 0126_regions added.
--
-- 0126 stays in the journal because databases may have run it. This returns
-- the schema to the single-region shape it had before: the region tables and
-- column go, the Studio transfer status and its one-live-offer index lose
-- 'accepting', and every foreign key 0126 dropped comes back under the name
-- and delete rule it had before 0126.

-- ── 1. Pending constraint checks ─────────────────────────────────────
-- ALTER TABLE refuses a table with deferred checks still pending.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint

-- ── 2. Transfers left accepting ──────────────────────────────────────
-- Finishing one swaps roles, updates the directory and tells the old admin;
-- that logic lives in the previous release's server, whose sweep finishes
-- them within minutes, so this migration stops and names them.
DO $$
DECLARE
  stuck text;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO stuck FROM studio_transfers WHERE status = 'accepting';
  IF stuck IS NOT NULL THEN
    RAISE EXCEPTION 'Studio transfers still accepting: %. Run the previous release''s server until it finishes them, then migrate again.', stuck;
  END IF;
END $$;--> statement-breakpoint

-- ── 3. Studio transfer status and the one-live-offer index ───────────
ALTER TABLE "studio_transfers" DROP CONSTRAINT "studio_transfers_status_check";--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_status_check" CHECK ("status" IN ('pending', 'accepted', 'declined', 'cancelled', 'failed'));--> statement-breakpoint
DROP INDEX "studio_transfers_one_pending";--> statement-breakpoint
CREATE UNIQUE INDEX "studio_transfers_one_pending" ON "studio_transfers" USING btree ("studio_id") WHERE "studio_transfers"."status" = 'pending' AND "studio_transfers"."deleted_at" IS NULL;--> statement-breakpoint

-- ── 4. Region column and tables ──────────────────────────────────────
ALTER TABLE "credit_charge_requests" DROP COLUMN "studio_id";--> statement-breakpoint
DROP TABLE "region_outbox_dead_letters";--> statement-breakpoint
DROP TABLE "region_outbox";--> statement-breakpoint
DROP TABLE "region_outbox_applied";--> statement-breakpoint
DROP TABLE "directory_reconciliations";--> statement-breakpoint
DROP TABLE "studio_creation_tombstones";--> statement-breakpoint
DROP TABLE "studio_storage_usage_global";--> statement-breakpoint
DROP TABLE "credit_charge_settlements";--> statement-breakpoint
DROP TABLE "slug_reservations";--> statement-breakpoint
DROP TABLE "user_regions";--> statement-breakpoint
DROP TABLE "project_directory";--> statement-breakpoint
DROP TABLE "studio_directory_members";--> statement-breakpoint
DROP TABLE "studio_directory";--> statement-breakpoint

-- ── 5. Foreign keys 0126 dropped ─────────────────────────────────────
-- Each as it stood after 0125: same name, column and delete rule.
ALTER TABLE "account_activity_events" ADD CONSTRAINT "account_activity_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_records" ADD CONSTRAINT "agent_usage_records_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_charge_requests" ADD CONSTRAINT "credit_charge_requests_actor_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_compensations" ADD CONSTRAINT "credit_compensations_studio_fk" FOREIGN KEY ("personal_studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_gifts" ADD CONSTRAINT "credit_gifts_studio_fk" FOREIGN KEY ("personal_studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_designated_studio_id_fk" FOREIGN KEY ("designated_studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_settlement_receipts" ADD CONSTRAINT "credit_settlement_receipts_actor_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_understanding_attempts" ADD CONSTRAINT "media_understanding_attempts_approval_actor_fk" FOREIGN KEY ("approval_actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_understanding_operations" ADD CONSTRAINT "media_understanding_operations_actor_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT "node_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_tasks" ADD CONSTRAINT "node_tasks_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activities" ADD CONSTRAINT "project_activities_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_instructions" ADD CONSTRAINT "project_agent_instructions_updated_by_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_user_id_users_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD CONSTRAINT "project_join_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_join_requests" ADD CONSTRAINT "project_join_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_last_opened" ADD CONSTRAINT "project_last_opened_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memory_entries" ADD CONSTRAINT "project_memory_entries_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD CONSTRAINT "role_upgrade_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_upgrade_requests" ADD CONSTRAINT "role_upgrade_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_assets" ADD CONSTRAINT "studio_assets_produced_by_user_id_users_id_fk" FOREIGN KEY ("produced_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_credit_debts" ADD CONSTRAINT "studio_credit_debts_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_invitations" ADD CONSTRAINT "studio_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_invitations" ADD CONSTRAINT "studio_invitations_invited_user_id_users_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_members" ADD CONSTRAINT "studio_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_members" ADD CONSTRAINT "studio_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_transfers" ADD CONSTRAINT "studio_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studios" ADD CONSTRAINT "studios_owner_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_executions" ADD CONSTRAINT "timeline_executions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_settlement_envelopes" ADD CONSTRAINT "usage_settlement_envelopes_actor_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
