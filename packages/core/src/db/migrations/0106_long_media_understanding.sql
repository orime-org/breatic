-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: LicenseRef-BSAL-1.0

CREATE TABLE media_understanding_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL CONSTRAINT media_understanding_operations_actor_user_id_fk REFERENCES users(id) ON DELETE RESTRICT,
  project_id uuid CONSTRAINT media_understanding_operations_project_id_fk REFERENCES projects(id) ON DELETE RESTRICT,
  origin_kind varchar(24) NOT NULL,
  origin_key varchar(255) NOT NULL,
  request_digest varchar(128) NOT NULL,
  sources jsonb NOT NULL,
  question text NOT NULL,
  mode varchar(32) NOT NULL,
  locale varchar(16) NOT NULL,
  model varchar(100) NOT NULL,
  prompt_version varchar(64) NOT NULL,
  deadline_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  recovery_group_id uuid NOT NULL,
  logical_request_id uuid NOT NULL,
  logical_root_operation_id uuid CONSTRAINT media_understanding_operations_root_operation_fk REFERENCES media_understanding_operations(id) ON DELETE RESTRICT,
  user_action_id uuid NOT NULL,
  request_input_revision integer NOT NULL DEFAULT 1,
  revision integer NOT NULL DEFAULT 1,
  root_deadline_at timestamptz NOT NULL,
  new_intent_receipt jsonb,
  delivery_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  lease_epoch bigint NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_applied_at timestamptz,
  dispatch_sequence integer NOT NULL DEFAULT 1,
  dispatch_state varchar(16) NOT NULL DEFAULT 'pending',
  dispatch_due_at timestamptz NOT NULL DEFAULT now(),
  local_abort_sequence integer NOT NULL DEFAULT 0,
  delivery_revision_cursor integer NOT NULL DEFAULT 0,
  delivery_publications jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT media_understanding_operations_status_check
    CHECK (status IN ('queued', 'running', 'blocked', 'ready', 'partial', 'failed', 'cancelled', 'expired')),
  CONSTRAINT media_understanding_operations_dispatch_state_check
    CHECK (dispatch_state IN ('pending', 'sent', 'claimed', 'retired')),
  CONSTRAINT media_understanding_operations_input_revision_check
    CHECK (request_input_revision > 0 AND revision > 0 AND dispatch_sequence > 0 AND delivery_revision_cursor >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX media_understanding_operations_actor_action_key
  ON media_understanding_operations (actor_user_id, user_action_id, logical_request_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX media_understanding_operations_recovery_group_idx
  ON media_understanding_operations (recovery_group_id, created_at)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX media_understanding_operations_dispatch_idx
  ON media_understanding_operations (dispatch_due_at, created_at)
  WHERE status IN ('queued', 'running', 'blocked') AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE media_understanding_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL CONSTRAINT media_understanding_steps_operation_id_fk REFERENCES media_understanding_operations(id) ON DELETE RESTRICT,
  step_key varchar(255) NOT NULL,
  kind varchar(24) NOT NULL,
  subtype varchar(32),
  source_index integer,
  media_input_id varchar(255),
  media_input_descriptor jsonb,
  segment_index integer,
  plan_version integer,
  input_digest varchar(128) NOT NULL,
  context_dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'pending',
  active_attempt_id uuid,
  accepted_attempt_id uuid,
  result jsonb,
  job_id varchar(255),
  manifest_revision integer,
  parent_manifest_revision integer,
  manifest_digest varchar(128),
  parent_manifest_digest varchar(128),
  required_media_inputs jsonb,
  required_media_inputs_digest varchar(128),
  selected_leaves jsonb,
  sealed_snapshot jsonb,
  candidate_id varchar(255),
  target_segment_id varchar(255),
  canonical_checkpoint jsonb,
  control_mutation_id uuid,
  control_mutation_digest varchar(128),
  control_expected_version integer,
  control_receipt jsonb,
  control_effect_state varchar(16),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT media_understanding_steps_kind_check
    CHECK (kind IN ('prepare_source', 'read_batch', 'read_segment', 'aggregate')),
  CONSTRAINT media_understanding_steps_status_check
    CHECK (status IN ('pending', 'running', 'blocked', 'ready', 'partial', 'failed', 'cancelled', 'superseded')),
  CONSTRAINT media_understanding_steps_source_index_check
    CHECK (source_index IS NULL OR source_index >= 0),
  CONSTRAINT media_understanding_steps_segment_index_check
    CHECK (segment_index IS NULL OR segment_index >= 0),
  CONSTRAINT media_understanding_steps_revision_check
    CHECK ((manifest_revision IS NULL OR manifest_revision > 0)
      AND (parent_manifest_revision IS NULL OR parent_manifest_revision > 0)
      AND (plan_version IS NULL OR plan_version > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX media_understanding_steps_operation_step_key
  ON media_understanding_steps (operation_id, step_key)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX media_understanding_steps_candidate_key
  ON media_understanding_steps (operation_id, source_index, candidate_id)
  WHERE candidate_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX media_understanding_steps_adoption_key
  ON media_understanding_steps (operation_id, source_index, target_segment_id)
  WHERE subtype = 'prepare_adoption' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX media_understanding_steps_operation_status_idx
  ON media_understanding_steps (operation_id, status, source_index, segment_index)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE media_understanding_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL CONSTRAINT media_understanding_attempts_operation_id_fk REFERENCES media_understanding_operations(id) ON DELETE RESTRICT,
  step_id uuid NOT NULL CONSTRAINT media_understanding_attempts_step_id_fk REFERENCES media_understanding_steps(id) ON DELETE RESTRICT,
  attempt_no integer NOT NULL,
  input_digest varchar(128) NOT NULL,
  epoch bigint NOT NULL,
  request_state varchar(24) NOT NULL,
  provider varchar(50),
  generation_id varchar(255),
  response jsonb,
  finish_reason varchar(40),
  cost_state varchar(24) NOT NULL DEFAULT 'unknown',
  price_snapshot jsonb,
  cost_usd numeric(28, 12),
  credits numeric(20, 6),
  usage_record_id uuid,
  model_permit_state varchar(16) NOT NULL DEFAULT 'waiting',
  model_permit_expires_at timestamptz,
  send_authority_epoch bigint NOT NULL,
  revoked_at timestamptz,
  superseded_by_attempt_id uuid CONSTRAINT media_understanding_attempts_superseded_by_fk REFERENCES media_understanding_attempts(id) ON DELETE RESTRICT,
  local_abort_requested boolean NOT NULL DEFAULT false,
  approval_request_id uuid,
  approval_actor_user_id uuid CONSTRAINT media_understanding_attempts_approval_actor_fk REFERENCES users(id) ON DELETE RESTRICT,
  approval_warning_version varchar(64),
  approved_unknown_digest varchar(128),
  approved_input_revision integer,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT media_understanding_attempts_attempt_no_check CHECK (attempt_no > 0),
  CONSTRAINT media_understanding_attempts_request_state_check
    CHECK (request_state IN ('prepared', 'sending', 'unknown', 'responded', 'rejected', 'cancelled')),
  CONSTRAINT media_understanding_attempts_cost_state_check
    CHECK (cost_state IN ('unknown', 'known', 'missing', 'settled')),
  CONSTRAINT media_understanding_attempts_permit_state_check
    CHECK (model_permit_state IN ('waiting', 'held', 'released', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX media_understanding_attempts_step_number_key
  ON media_understanding_attempts (step_id, attempt_no)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX media_understanding_attempts_usage_record_key
  ON media_understanding_attempts (usage_record_id)
  WHERE usage_record_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX media_understanding_attempts_generation_key
  ON media_understanding_attempts (provider, generation_id)
  WHERE generation_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX media_understanding_attempts_approval_key
  ON media_understanding_attempts (approval_actor_user_id, approval_request_id, step_id)
  WHERE approval_request_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE media_understanding_steps
  ADD CONSTRAINT media_understanding_steps_active_attempt_fk
  FOREIGN KEY (active_attempt_id) REFERENCES media_understanding_attempts(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE media_understanding_steps
  ADD CONSTRAINT media_understanding_steps_accepted_attempt_fk
  FOREIGN KEY (accepted_attempt_id) REFERENCES media_understanding_attempts(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE usage_settlement_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL CONSTRAINT usage_settlement_envelopes_actor_user_id_fk REFERENCES users(id) ON DELETE RESTRICT,
  origin_kind varchar(24) NOT NULL,
  origin_key varchar(255) NOT NULL,
  project_id uuid CONSTRAINT usage_settlement_envelopes_project_id_fk REFERENCES projects(id) ON DELETE RESTRICT,
  producer_closed_at timestamptz,
  settlement_mode varchar(16) NOT NULL DEFAULT 'durable',
  canvas_execution_terminal_at timestamptz,
  terminal_operation_revision integer,
  hold_release_receipt_id uuid,
  exact_cumulative_usd numeric(28, 12) NOT NULL DEFAULT 0,
  rounded_cumulative_credits numeric(20, 6) NOT NULL DEFAULT 0,
  settled_exact_usd numeric(28, 12) NOT NULL DEFAULT 0,
  settled_rounded_credits numeric(20, 6) NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0,
  settlement_pending boolean NOT NULL DEFAULT false,
  settlement_due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT usage_settlement_envelopes_mode_check CHECK (settlement_mode IN ('durable', 'legacy')),
  CONSTRAINT usage_settlement_envelopes_nonnegative_check
    CHECK (exact_cumulative_usd >= 0 AND rounded_cumulative_credits >= 0
      AND settled_exact_usd >= 0 AND settled_rounded_credits >= 0 AND revision >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX usage_settlement_envelopes_actor_origin_key
  ON usage_settlement_envelopes (actor_user_id, origin_kind, origin_key)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX usage_settlement_envelopes_pending_idx
  ON usage_settlement_envelopes (settlement_due_at, created_at)
  WHERE settlement_pending AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE credit_settlement_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL CONSTRAINT credit_settlement_receipts_envelope_id_fk REFERENCES usage_settlement_envelopes(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL CONSTRAINT credit_settlement_receipts_actor_user_id_fk REFERENCES users(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  ref_key varchar(255) NOT NULL,
  exact_cumulative_usd numeric(28, 12) NOT NULL,
  rounded_cumulative_credits numeric(20, 6) NOT NULL,
  exact_delta_usd numeric(28, 12) NOT NULL,
  credit_delta numeric(20, 6) NOT NULL,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT credit_settlement_receipts_revision_check CHECK (revision > 0),
  CONSTRAINT credit_settlement_receipts_amount_check
    CHECK (exact_cumulative_usd >= 0 AND rounded_cumulative_credits >= 0
      AND exact_delta_usd >= 0 AND credit_delta >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX credit_settlement_receipts_envelope_revision_key
  ON credit_settlement_receipts (envelope_id, revision)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX credit_settlement_receipts_actor_ref_key
  ON credit_settlement_receipts (actor_user_id, ref_key)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX credit_settlement_receipts_envelope_created_idx
  ON credit_settlement_receipts (envelope_id, created_at)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE conversation_messages
  ADD COLUMN closed_producer_origin_key varchar(255);
--> statement-breakpoint
ALTER TABLE agent_usage_records
  ADD COLUMN settlement_envelope_id uuid CONSTRAINT agent_usage_records_settlement_envelope_fk REFERENCES usage_settlement_envelopes(id) ON DELETE RESTRICT,
  ADD COLUMN settlement_receipt_id uuid CONSTRAINT agent_usage_records_settlement_receipt_fk REFERENCES credit_settlement_receipts(id) ON DELETE RESTRICT,
  ADD COLUMN cost_identity varchar(255);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_usage_records_cost_identity_key
  ON agent_usage_records (cost_identity)
  WHERE cost_identity IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_usage_records_settlement_envelope_idx
  ON agent_usage_records (settlement_envelope_id)
  WHERE settlement_envelope_id IS NOT NULL;
