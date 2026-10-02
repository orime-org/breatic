-- A node's history holds each content once (#2186). A successful row is a
-- version a reader can come back to; two live rows holding the same content
-- on one node are the same version twice, and the panel cannot say which of
-- them the node is on.
--
-- Defensive dedup before the unique index. Keep the earliest live success row
-- per (project_id, node_id, content) — by created_at, then id — and soft-delete
-- the rest (soft delete only: node_tasks.node_history_id references these rows,
-- and the task list still reads a soft-deleted row's content).
UPDATE "node_history" nh SET "deleted_at" = now()
WHERE nh."status" = 'success' AND nh."content" IS NOT NULL
  AND nh."deleted_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "node_history" e
    WHERE e."project_id" = nh."project_id" AND e."node_id" = nh."node_id"
      AND md5(e."content") = md5(nh."content")
      AND e."status" = 'success' AND e."content" IS NOT NULL
      AND e."deleted_at" IS NULL
      AND (e."created_at" < nh."created_at"
           OR (e."created_at" = nh."created_at" AND e."id" < nh."id"))
  );--> statement-breakpoint

-- One live success row per content per node, whatever wrote it. md5 because a
-- text node's content can exceed a btree row's size limit; it is only compared
-- for equality. Failed rows carry no content and stay out of the predicate.
CREATE UNIQUE INDEX IF NOT EXISTS "node_history_success_content_unique"
  ON "node_history" ("project_id", "node_id", md5("content"))
  WHERE "status" = 'success' AND "content" IS NOT NULL
    AND "deleted_at" IS NULL;
