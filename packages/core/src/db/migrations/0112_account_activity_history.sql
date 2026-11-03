-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: Elastic-2.0

-- Product database: durable interaction history; intentionally no backfill.
CREATE TABLE account_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  visit_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT account_activity_kind_check CHECK (kind IN ('project_access','generation_started','project_action','agent_started','project_edit')),
  CONSTRAINT account_activity_project_check CHECK (kind NOT IN ('project_access','project_edit') OR project_id IS NOT NULL),
  CONSTRAINT account_activity_visit_check CHECK ((kind = 'project_access') = (visit_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX account_activity_user_visit_idx ON account_activity_events(user_id, visit_id);
--> statement-breakpoint
CREATE INDEX account_activity_user_time_idx ON account_activity_events(user_id, occurred_at);
--> statement-breakpoint
CREATE INDEX account_activity_time_user_idx ON account_activity_events(occurred_at, user_id);
--> statement-breakpoint
CREATE TABLE account_activity_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT account_activity_coverage_version_check CHECK (version > 0),
  CONSTRAINT account_activity_coverage_interval_check CHECK (ended_at IS NULL OR ended_at > started_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX account_activity_coverage_open_idx ON account_activity_coverage(version) WHERE ended_at IS NULL;
--> statement-breakpoint
CREATE INDEX account_activity_coverage_version_time_idx ON account_activity_coverage(version, started_at);
