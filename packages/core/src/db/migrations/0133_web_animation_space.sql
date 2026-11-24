-- Web animation becomes its own Space type, Motion (#1490).
--
-- An execution is now one of three kinds: a create, a modification of an earlier result, or an export of a result to
-- video. An export calls no model, so its engine is empty, and it ends with a registered video asset instead of a
-- source version. `origin` records where it was asked for, so a Motion Space can list what the Timeline made before.
--
-- A new row starts `queued`, the column's default, and names its `origin`; `origin` has a default only while this
-- migration marks the existing rows as made in a Timeline. A grant is written with its execution's creation time and
-- origin.

ALTER TABLE timeline_executions ALTER COLUMN status SET DEFAULT 'queued';--> statement-breakpoint

ALTER TABLE timeline_executions DROP CONSTRAINT timeline_executions_kind_check;--> statement-breakpoint
ALTER TABLE timeline_executions ADD CONSTRAINT timeline_executions_kind_check
  CHECK (kind IN ('web_animation_create', 'web_animation_modify', 'web_animation_export'));--> statement-breakpoint

ALTER TABLE timeline_executions DROP CONSTRAINT timeline_executions_phase_check;--> statement-breakpoint
ALTER TABLE timeline_executions ADD CONSTRAINT timeline_executions_phase_check
  CHECK (phase IS NULL OR phase IN ('writing', 'validating', 'saving', 'rendering'));--> statement-breakpoint

-- How far a running export's render got, as a whole percent; null for other kinds and phases.
ALTER TABLE timeline_executions ADD COLUMN progress smallint
  CONSTRAINT timeline_executions_progress_check CHECK (progress IS NULL OR progress BETWEEN 0 AND 100);--> statement-breakpoint

ALTER TABLE timeline_executions ALTER COLUMN engine DROP NOT NULL;--> statement-breakpoint
ALTER TABLE timeline_executions DROP CONSTRAINT timeline_executions_engine_check;--> statement-breakpoint
ALTER TABLE timeline_executions ADD CONSTRAINT timeline_executions_engine_check CHECK (
  (kind = 'web_animation_export' AND engine IS NULL)
  OR (kind <> 'web_animation_export' AND engine IS NOT NULL AND engine IN ('deepseek'))
);--> statement-breakpoint

ALTER TABLE timeline_executions
  ADD COLUMN result_asset_id uuid CONSTRAINT timeline_executions_result_asset_id_fkey REFERENCES studio_assets(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE timeline_executions ADD CONSTRAINT timeline_executions_result_check CHECK (
  (kind = 'web_animation_export' AND result_source_version_id IS NULL)
  OR (kind <> 'web_animation_export' AND result_asset_id IS NULL)
);--> statement-breakpoint

ALTER TABLE timeline_executions ADD COLUMN origin text NOT NULL DEFAULT 'timeline'
  CONSTRAINT timeline_executions_origin_check CHECK (origin IN ('timeline', 'web_animation_space'));--> statement-breakpoint
ALTER TABLE timeline_executions ALTER COLUMN origin DROP DEFAULT;--> statement-breakpoint

-- One live export of a source in a Motion Space; a failed, cancelled or expired one may be made again.
CREATE UNIQUE INDEX timeline_executions_export_source_idx
  ON timeline_executions (project_id, space_id, (input->>'sourceVersionId'))
  WHERE kind = 'web_animation_export' AND status NOT IN ('failed', 'cancelled', 'expired') AND deleted_at IS NULL;--> statement-breakpoint

-- A Motion Space's own list; each row is then checked against this Project's grants.
CREATE INDEX timeline_executions_space_order_idx
  ON timeline_executions (space_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;--> statement-breakpoint

-- The grant carries its execution's creation time and origin, so the Project's results and the Timeline-made group
-- are read from the grant table in order.
ALTER TABLE timeline_execution_grants ADD COLUMN execution_created_at timestamptz;--> statement-breakpoint
ALTER TABLE timeline_execution_grants ADD COLUMN execution_origin text;--> statement-breakpoint

UPDATE timeline_execution_grants g
SET execution_created_at = e.created_at, execution_origin = e.origin
FROM timeline_executions e
WHERE e.id = g.execution_id;--> statement-breakpoint

ALTER TABLE timeline_execution_grants ALTER COLUMN execution_created_at SET NOT NULL;--> statement-breakpoint
ALTER TABLE timeline_execution_grants ALTER COLUMN execution_origin SET NOT NULL;--> statement-breakpoint

CREATE INDEX timeline_execution_grants_order_idx
  ON timeline_execution_grants (project_id, execution_created_at DESC, execution_id DESC)
  WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE INDEX timeline_execution_grants_origin_order_idx
  ON timeline_execution_grants (project_id, execution_origin, execution_created_at DESC, execution_id DESC)
  WHERE deleted_at IS NULL;
