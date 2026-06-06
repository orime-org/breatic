-- Slice 1 — drop users.username + studios slug/type (email registration
-- rewrite, 2026-06-06).
--
-- A user's business identity (display name + URL handle) moves entirely to
-- their personal studio: studios.name = display name, studios.slug = URL
-- handle. `users` becomes the pure auth/account table → DROP username.
--
-- studios: rename owner_user_id → created_by_user_id (admin role moved to
-- studio_members; this column is now pure creator audit + the personal-
-- studio uniqueness key); add `slug` (URL handle) + `type`. The old
-- "one studio per user" index is swapped for "one PERSONAL studio per
-- user" (scoped to type='personal') + a global-unique slug index. Runs on
-- a fresh/empty table (clean rebuild, no rows) so the NOT NULL adds + the
-- column drop are safe.
ALTER TABLE "studios" RENAME COLUMN "owner_user_id" TO "created_by_user_id";--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN "slug" varchar(40) NOT NULL;--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN "type" varchar(16) NOT NULL;--> statement-breakpoint
DROP INDEX "studios_owner_user_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "studios_slug_idx" ON "studios" USING btree ("slug") WHERE "studios"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "studios_owner_personal_idx" ON "studios" USING btree ("created_by_user_id") WHERE "studios"."type" = 'personal' AND "studios"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "username";
