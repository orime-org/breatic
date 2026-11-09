-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: Elastic-2.0

-- Product database (inner#1711): the immutable source version a web-animation
-- execution produced, and which Projects may resolve and preview it.
--
-- A source row is inserted once per execution and never updated: every
-- settlement of the same terminal report lands on the row the first wrote.
-- Its package and Manifest live under the private `web-animation/` prefix and
-- are not studio assets.
CREATE TABLE timeline_web_animation_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL
    CONSTRAINT timeline_web_animation_sources_execution_id_fkey REFERENCES timeline_executions(id) ON DELETE RESTRICT
    CONSTRAINT timeline_web_animation_sources_execution_id_key UNIQUE,
  package_key text NOT NULL,
  manifest_key text NOT NULL,
  package_sha256 text NOT NULL,
  package_bytes bigint NOT NULL,
  manifest_sha256 text NOT NULL,
  runtime_version text NOT NULL,
  font_set_version integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  fps_num integer NOT NULL,
  fps_den integer NOT NULL,
  duration_frames integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
-- One live row per execution and Project: the accepting Project gets one at
-- acceptance, and duplicating a Project copies every live row of the source.
CREATE TABLE timeline_execution_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL CONSTRAINT timeline_execution_grants_execution_id_fkey REFERENCES timeline_executions(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL CONSTRAINT timeline_execution_grants_project_id_fkey REFERENCES projects(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX timeline_execution_grants_live_idx ON timeline_execution_grants(execution_id, project_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX timeline_execution_grants_project_idx ON timeline_execution_grants(project_id)
  WHERE deleted_at IS NULL;
