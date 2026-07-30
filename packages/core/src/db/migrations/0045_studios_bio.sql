-- studios.bio — the studio's self-description, shown on its front door.
--
-- Nullable rather than NOT NULL DEFAULT '': a studio that has never written a
-- bio and one that wrote a bio and then cleared it are the same state to every
-- reader, and NULL says "unset" without every existing row having to be
-- rewritten. The API accepts the empty string to clear it and stores NULL, so
-- there is exactly one representation of "no bio" in the column.
--
-- varchar(500) matches the ceiling `updateStudioSchema` enforces. The limit is
-- an interface contract (what a client may send), not an operational knob, so
-- it lives in the schema and the column rather than in configuration.
--
-- Hand-written (same pattern as 0040/0041/0042/0043/0044: .sql + _journal
-- entry, no snapshot). Pre-launch — no backfill needed.
ALTER TABLE "studios"
  ADD COLUMN IF NOT EXISTS "bio" varchar(500);
