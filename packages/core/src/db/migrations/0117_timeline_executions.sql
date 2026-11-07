-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: Elastic-2.0

-- Product database (inner#1711): one row per Timeline execution the user
-- accepted. `status` moves only through `timelineExecutionRepo.transition`;
-- `fence` names the attempt allowed to finish it, and `billed_at` lets the
-- execution be charged at most once. space_id has no foreign key, as with
-- tasks.space_id: Spaces live in the project's Yjs document.
CREATE TABLE timeline_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL CONSTRAINT timeline_executions_project_id_fkey REFERENCES projects(id) ON DELETE RESTRICT,
  space_id uuid NOT NULL,
  actor_user_id uuid NOT NULL CONSTRAINT timeline_executions_actor_user_id_fkey REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  action_id text NOT NULL,
  input jsonb NOT NULL,
  input_hash text NOT NULL,
  engine text NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_landing',
  phase text,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempt integer NOT NULL DEFAULT 0,
  fence uuid,
  deadline_at timestamptz NOT NULL,
  next_dispatch_at timestamptz,
  dispatched_at timestamptz,
  result_source_version_id uuid,
  failure_reason text,
  billed_credits numeric,
  billed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT timeline_executions_kind_check CHECK (kind IN ('web_animation_create')),
  CONSTRAINT timeline_executions_engine_check CHECK (engine IN ('deepseek')),
  CONSTRAINT timeline_executions_status_check CHECK (status IN (
    'awaiting_landing', 'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'expired'
  )),
  CONSTRAINT timeline_executions_phase_check CHECK (phase IS NULL OR phase IN ('writing', 'validating', 'saving'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX timeline_executions_action_idx ON timeline_executions(project_id, space_id, action_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX timeline_executions_space_idx ON timeline_executions(project_id, space_id, status, created_at DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX timeline_executions_open_idx ON timeline_executions(created_at)
  WHERE deleted_at IS NULL AND status IN ('awaiting_landing', 'queued', 'running', 'cancelling');
