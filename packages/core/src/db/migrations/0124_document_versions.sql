-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: Elastic-2.0

-- Product database (inner#1129): snapshots a user keeps of a document
-- Space's body. `content` is the editor's ProseMirror JSON, comment marks
-- included, so a restore puts the comments back where they stood. The Space
-- lives in Yjs, so `space_id` has no foreign key, as with timeline_executions.
CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL CONSTRAINT document_versions_project_id_fkey REFERENCES projects(id) ON DELETE RESTRICT,
  space_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL CONSTRAINT document_versions_created_by_user_id_fkey REFERENCES users(id) ON DELETE RESTRICT,
  name text,
  content jsonb NOT NULL,
  schema_version text NOT NULL,
  content_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid CONSTRAINT document_versions_deleted_by_user_id_fkey REFERENCES users(id) ON DELETE RESTRICT
);
--> statement-breakpoint
-- The list a document's panel reads, newest first, and the count its ceiling takes.
CREATE INDEX document_versions_space_list_idx
  ON document_versions (project_id, space_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
