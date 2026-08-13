-- Clear out the rows 0050 wrote in a vocabulary nothing reads any more.
--
-- 0050 translated the old flat message shape into parts as it moved messages
-- into rows: a `role='tool'` message became a `tool-result` part, and each
-- entry of `tool_calls` became a `tool-call` part. Both of those part types
-- have since been replaced by a single `tool` part carrying a status, and
-- `role` narrowed to user and assistant. So those rows are now written in
-- terms no reader has: the panel filters the parts out, the model never sees
-- them, and a `role='tool'` row amounts to nothing at all on screen.
--
-- They are cleared rather than translated because there is no history worth
-- keeping: chat has never run anywhere but a developer's own database, so a
-- translation would be a migration written for data that does not exist.
--
-- Cleared means soft deleted, which is what this repository does with every
-- table. Reads already filter on `deleted_at IS NULL`, so this is enough to
-- take them out of circulation without destroying anything.
--
-- The judgement is the vocabulary, never "everything written before now": a
-- developer mid-conversation has current-shape rows sitting beside these, and
-- a purge that cannot tell them apart would take those too.
--
-- The markers below are load-bearing: the migration test reads this exact
-- statement out of this file and runs it against rows it seeds, so the purge
-- that ships is the purge that was verified.
-- >>> purge
UPDATE "conversation_messages"
SET "deleted_at" = now(), "updated_at" = now()
WHERE "deleted_at" IS NULL
  AND (
    "role" NOT IN ('user', 'assistant')
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements("parts") AS part
      WHERE part->>'type' IN ('tool-call', 'tool-result')
    )
  );
-- <<< purge
