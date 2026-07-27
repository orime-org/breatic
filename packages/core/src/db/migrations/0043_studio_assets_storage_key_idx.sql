-- studio_assets.storage_key index (#1826, Gate-2 R9) — makes the reclaim
-- queue's safety guard a lookup instead of a sequential scan.
--
-- `queueForReclaim` refuses to enqueue a key that still has a live ledger row
-- (the last check before an offline job deletes bytes), and it does that check
-- INSIDE the INSERT so it is atomic:
--
--   INSERT ... SELECT ... WHERE NOT EXISTS (
--     SELECT 1 FROM studio_assets WHERE storage_key = $1 AND deleted_at IS NULL
--   )
--
-- studio_assets is unique on (studio_id, content_hash) and indexed on
-- studio_id, but had NOTHING on storage_key — so every dedup-hit registration
-- paid a full sequential scan. Partial (deleted_at IS NULL) to match the
-- predicate exactly and to stay small: soft-deleted rows are never live
-- references, so they cannot block a reclaim.
--
-- NOT unique: one key legitimately appears on several rows over time (a
-- soft-deleted row plus its replacement), and the design deliberately does not
-- make storage_key unique — dedup is keyed on content, not on key.
--
-- Also serves the offline reclaim job itself, which resolves each queued
-- storage_key back to its (absent) asset row before deleting.
--
-- Hand-written (same pattern as 0034/0040/0041/0042: .sql + _journal entry, no
-- snapshot). Pre-launch, empty DB — no backfill.
CREATE INDEX IF NOT EXISTS "studio_assets_storage_key_idx"
  ON "studio_assets" ("storage_key")
  WHERE "deleted_at" IS NULL;
