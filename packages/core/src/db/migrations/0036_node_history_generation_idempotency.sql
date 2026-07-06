-- node_history generation idempotency (#1618 Y). A billed generation must
-- land in node_history EXACTLY ONCE regardless of how many times the worker
-- records it: double-live concurrent executions, or a billed-redelivery
-- re-record (the crash-window that left a billed result unrecorded). Mirrors
-- project_activities' task_id partial unique (0034); node_history is
-- per-node, so the key is (task_id, node_id), scoped to successful
-- generations. Hand-written (drizzle-kit generate needs a TTY; same pattern
-- as 0025..0035: .sql + _journal entry, no snapshot).

-- Defensive dedup before the unique index (pre-launch: expected zero rows).
-- Keep the earliest success generation per (task_id, node_id); soft-delete
-- the rest (soft-delete only — never hard delete). The deleted_at IS NULL
-- scope on the index means soft-deleted duplicates free the slot.
UPDATE "node_history" nh SET "deleted_at" = now()
WHERE nh."entry_type" = 'generation' AND nh."status" = 'success'
  AND nh."task_id" IS NOT NULL AND nh."deleted_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "node_history" e
    WHERE e."task_id" = nh."task_id" AND e."node_id" = nh."node_id"
      AND e."entry_type" = 'generation' AND e."status" = 'success'
      AND e."deleted_at" IS NULL
      AND (e."created_at" < nh."created_at"
           OR (e."created_at" = nh."created_at" AND e."id" < nh."id"))
  );--> statement-breakpoint

-- One success generation row per (task_id, node_id). Uploads (task_id NULL)
-- and failed rows are excluded, so they are never deduped by this index.
CREATE UNIQUE INDEX IF NOT EXISTS "node_history_generation_task_node_unique"
  ON "node_history" ("task_id", "node_id")
  WHERE "task_id" IS NOT NULL AND "entry_type" = 'generation'
    AND "status" = 'success' AND "deleted_at" IS NULL;
