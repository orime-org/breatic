ALTER TABLE storage_reclaim_queue ADD COLUMN origin_storage_key text;
--> statement-breakpoint
CREATE TABLE storage_reclaim_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by text NOT NULL,
  items jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE TABLE storage_reclaim_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  decision jsonb NOT NULL,
  scope jsonb NOT NULL,
  state text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL,
  next_check_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX storage_reclaim_operations_due_idx ON storage_reclaim_operations(next_check_at);
--> statement-breakpoint
CREATE TABLE storage_reclaim_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  operation_id uuid NOT NULL CONSTRAINT storage_reclaim_controls_operation_fk REFERENCES storage_reclaim_operations(id) ON DELETE RESTRICT,
  fingerprint text NOT NULL,
  kind text NOT NULL,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE TABLE storage_reclaim_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL UNIQUE,
  operation_id uuid NOT NULL CONSTRAINT storage_reclaim_objects_operation_fk REFERENCES storage_reclaim_operations(id) ON DELETE RESTRICT,
  scope jsonb NOT NULL,
  retired_at timestamptz,
  lease_version integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  in_flight boolean NOT NULL DEFAULT false,
  latest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE TABLE storage_reclaim_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL CONSTRAINT storage_reclaim_runs_operation_fk REFERENCES storage_reclaim_operations(id) ON DELETE RESTRICT,
  number integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE TABLE storage_reclaim_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL CONSTRAINT storage_reclaim_attempts_operation_fk REFERENCES storage_reclaim_operations(id) ON DELETE RESTRICT,
  object_id uuid NOT NULL CONSTRAINT storage_reclaim_attempts_object_fk REFERENCES storage_reclaim_objects(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL CONSTRAINT storage_reclaim_attempts_run_fk REFERENCES storage_reclaim_runs(id) ON DELETE RESTRICT,
  lease_version integer NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX storage_reclaim_runs_operation_number_unique ON storage_reclaim_runs(operation_id, number);
--> statement-breakpoint
CREATE INDEX storage_reclaim_objects_operation_key_idx ON storage_reclaim_objects(operation_id,storage_key);
