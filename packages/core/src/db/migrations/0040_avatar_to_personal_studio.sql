-- Move the avatar field off `users` onto the studio (#1808). Finishes the
-- 2026-06-06 identity migration that moved name/slug to the personal studio
-- but left avatar behind. `studios.avatar_url` is the new home (personal =
-- user avatar, team = logo); reads switch to the personal-studio pointer,
-- same as `name`.
--
-- Pre-launch, empty DB (Google OAuth frontend is a placeholder, so no avatar
-- was ever written; email users are always null) — so this is a plain
-- ADD + DROP with NO backfill/guard. This is NOT a safe pattern for a table
-- holding real data; that would require a backfill into each user's personal
-- studio + a pre-drop reconciliation. The simplification is bound to the
-- empty-DB premise (user 2026-07-22).
--
-- Hand-written (same pattern as 0039: .sql + _journal entry, no snapshot).

ALTER TABLE "studios" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "avatar_url";
