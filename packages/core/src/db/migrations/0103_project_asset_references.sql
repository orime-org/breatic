-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: LicenseRef-BSAL-1.0

CREATE TABLE project_asset_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES studio_assets(id) ON DELETE RESTRICT,
  display_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_asset_refs_live_key
  ON project_asset_refs (project_id, asset_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX project_asset_refs_page_idx
  ON project_asset_refs (project_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
