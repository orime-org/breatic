// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where each product table's rows live (inner#1955).
 *
 * `global` rows exist only in the global region and are reached from other
 * regions through the global API; `regional` rows live in the region of the
 * Studio they belong to; `both` tables keep account-level rows in the global
 * region and Studio or Project rows in their region. Every region runs the
 * same migrations, so a global table exists everywhere and stays empty
 * outside the global region. `table-placement.test.ts` fails on a table this
 * map does not place.
 */

/** Where a table's rows live. */
export type TablePlacement = "global" | "regional" | "both";

/**
 * Tables a migration renamed out of use but never dropped: they are still in
 * every database, so they are placed too, though the schema no longer
 * defines them.
 */
export const RETIRED_TABLES: readonly string[] = ["credit_transactions_archived"];

/** Each product table's placement, by table name. */
export const TABLE_PLACEMENT: Readonly<Record<string, TablePlacement>> = {
  // Retired by 0062: the old credit transactions, renamed and kept.
  credit_transactions_archived: "global",
  // Accounts, membership and subscriptions
  users: "global",
  membership_tier_changes: "global",
  subscriptions: "global",
  enterprise_memberships: "global",
  enterprise_membership_operations: "global",
  // Payments
  payments: "global",
  purchase_consents: "global",
  purchase_mail_outbox: "global",
  stripe_webhook_events: "global",
  stripe_webhook_attempts: "global",
  // The credit books
  credit_sources: "global",
  credit_grant_operations: "global",
  credit_compensations: "global",
  credit_gifts: "global",
  credit_lots: "global",
  credit_ledger: "global",
  studio_credit_debts: "global",
  credit_holds: "global",
  credit_charge_settlements: "global",
  // Refunds
  credit_refund_operations: "global",
  credit_refund_refusals: "global",
  credit_refund_operation_events: "global",
  credit_refunds: "global",
  refund_mail_outbox: "global",
  credit_refund_reconcile_status: "global",
  // Referral
  promoter_applications: "global",
  referral_codes: "global",
  referral_bindings: "global",
  referral_operations: "global",
  // Ads conversions
  ads_conversion_uploads: "global",
  // The directory of every region's Studios and Projects
  studio_directory: "global",
  studio_directory_members: "global",
  project_directory: "global",
  user_regions: "global",
  slug_reservations: "global",
  studio_storage_usage_global: "global",
  region_outbox_applied: "global",
  directory_reconciliations: "global",
  // Accounts' own upstream keys and per-model upstream choices (inner#1953)
  account_provider_keys: "global",
  account_model_upstreams: "global",
  // Account-level rows in the global region, Studio and Project rows in their region
  notifications: "both",
  analytics_milestones: "both",
  // Studios, members and their Projects
  studios: "regional",
  studio_members: "regional",
  studio_invitations: "regional",
  studio_transfers: "regional",
  projects: "regional",
  project_members: "regional",
  project_last_opened: "regional",
  project_edits: "regional",
  project_invitations: "regional",
  role_upgrade_requests: "regional",
  project_join_requests: "regional",
  project_transfers: "regional",
  project_activities: "regional",
  project_lifecycle_outbox: "regional",
  document_versions: "regional",
  // Agent conversations and memory
  conversations: "regional",
  conversation_messages: "regional",
  conversation_attachments: "regional",
  conversation_memories: "regional",
  memory_history_entries: "regional",
  project_memories: "regional",
  project_memory_entries: "regional",
  agent_memories: "regional",
  project_agent_instructions: "regional",
  // Generation, understanding and their usage
  tasks: "regional",
  task_upstream_steps: "regional",
  studio_upstream_clones: "regional",
  node_history: "regional",
  node_tasks: "regional",
  media_understanding_operations: "regional",
  media_understanding_steps: "regional",
  media_understanding_attempts: "regional",
  usage_settlement_envelopes: "regional",
  credit_settlement_receipts: "regional",
  agent_usage_records: "regional",
  credit_charge_requests: "regional",
  timeline_executions: "regional",
  timeline_web_animation_sources: "regional",
  timeline_execution_grants: "regional",
  // Assets and storage reclaim
  studio_assets: "regional",
  project_asset_refs: "regional",
  upload_grants: "regional",
  storage_reclaim_queue: "regional",
  storage_reclaim_previews: "regional",
  storage_reclaim_operations: "regional",
  storage_reclaim_controls: "regional",
  storage_reclaim_objects: "regional",
  storage_reclaim_runs: "regional",
  storage_reclaim_attempts: "regional",
  // Account activity, recorded in the transaction of the write it describes
  account_activity_events: "regional",
  account_activity_coverage: "regional",
  // A region's link to the global region
  region_outbox: "regional",
  region_outbox_dead_letters: "regional",
  studio_creation_tombstones: "regional",
};
