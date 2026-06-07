-- ProjectRole rename: edit -> editor, view -> viewer.
--
-- Aligns the backend ProjectRole vocabulary ('owner' | 'edit' | 'view')
-- with the frontend ItemRole that already uses the full words
-- ('owner' | 'editor' | 'viewer'), removing the cross-layer drift.
--
-- Hand-written (data-value rename can't be drizzle-generated; drizzle-kit
-- generate also needs a TTY here) — same pattern as 0016/0018: .sql +
-- _journal entry, no snapshot.
--
-- Two columns carry ProjectRole values:
--   1. project_members.role (varchar 16, no default)
--   2. share_links.role     (varchar 16, default was 'view')
--
-- Backfill existing rows (covers dev DBs; no prod data pre-launch), then
-- move the share_links default to the renamed value.
--
-- spec: breatic-inner/engineering/specs/2026-06-06-studio-slice2-projects-design.md

UPDATE "project_members" SET "role" = 'editor' WHERE "role" = 'edit';--> statement-breakpoint
UPDATE "project_members" SET "role" = 'viewer' WHERE "role" = 'view';--> statement-breakpoint

UPDATE "share_links" SET "role" = 'editor' WHERE "role" = 'edit';--> statement-breakpoint
UPDATE "share_links" SET "role" = 'viewer' WHERE "role" = 'view';--> statement-breakpoint

ALTER TABLE "share_links" ALTER COLUMN "role" SET DEFAULT 'viewer';
