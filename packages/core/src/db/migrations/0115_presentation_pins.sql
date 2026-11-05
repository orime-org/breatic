-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: Elastic-2.0

-- Presentation pins (inner#1306 frames-split design §7.15): the only record of
-- which derived presentation objects are still referenced. A pin is live while
-- deleted_at is null; its referenced keys are appended to the child table when
-- the pin is acquired.
CREATE TABLE presentation_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_kind text NOT NULL CONSTRAINT presentation_pins_holder_kind_check
    CHECK (holder_kind IN ('execution', 'analysis', 'prepared', 'candidate', 'selected')),
  holder_id text NOT NULL,
  tool_input_id varchar(64) NOT NULL,
  prepared_key text,
  version_id varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT presentation_pins_prepared_key_check CHECK ((holder_kind = 'prepared') = (prepared_key IS NOT NULL)),
  CONSTRAINT presentation_pins_version_check CHECK ((holder_kind = 'selected') = (version_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX presentation_pins_selected_live_unique ON presentation_pins (holder_id)
  WHERE holder_kind = 'selected' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX presentation_pins_holder_live_unique ON presentation_pins (holder_kind, holder_id, tool_input_id)
  WHERE holder_kind IN ('execution', 'analysis', 'candidate') AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX presentation_pins_prepared_live_unique ON presentation_pins (holder_id, prepared_key)
  WHERE holder_kind = 'prepared' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE presentation_pin_objects (
  pin_id uuid NOT NULL CONSTRAINT presentation_pin_objects_pin_fk REFERENCES presentation_pins(id) ON DELETE RESTRICT,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT presentation_pin_objects_pkey PRIMARY KEY (pin_id, storage_key)
);
--> statement-breakpoint
CREATE INDEX presentation_pin_objects_storage_key_idx ON presentation_pin_objects (storage_key);
--> statement-breakpoint
-- The reclaim queue now also carries derived presentation objects, which belong
-- to a canonical key rather than a Studio and have no surviving twin.
ALTER TABLE storage_reclaim_queue ADD COLUMN kind text NOT NULL DEFAULT 'dedup_loser'
  CONSTRAINT storage_reclaim_queue_kind_check CHECK (kind IN ('dedup_loser', 'derived'));
--> statement-breakpoint
ALTER TABLE storage_reclaim_queue
  ALTER COLUMN content_hash DROP NOT NULL,
  ALTER COLUMN studio_id DROP NOT NULL,
  ALTER COLUMN kept_storage_key DROP NOT NULL,
  ALTER COLUMN source DROP NOT NULL,
  ADD CONSTRAINT storage_reclaim_queue_dedup_loser_check CHECK (
    kind = 'derived' OR (content_hash IS NOT NULL AND studio_id IS NOT NULL AND kept_storage_key IS NOT NULL AND source IS NOT NULL)
  );
