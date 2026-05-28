-- PR-c: hard-delete legacy NoAccount mode mock user (dev@localhost) and its
-- orphan studio. The NoAccount login mode was removed in PR-a (#147) and
-- PR-b (#150); this migration cleans up the residual seed row.
--
-- Exception to the soft-delete mandate in CLAUDE.md: dev-mode mock data is
-- exempt per spec § 4.4 (engineering/specs/2026-05-26-deprecate-noaccount-email-auth-spec.md).
--
-- Audit (pre-migration, 2026-05-28):
--   users   (id='00000000-...')             = 1 row (dev@localhost / "Dev User")
--   studios (owner_user_id='00000000-...')  = 1 row ("Dev User's Studio", 0 projects)
--   all 12 other FK-referencing tables      = 0 rows (verified via SQL count)
--
-- In production this migration is a no-op: the NoAccount mock user only
-- exists in development databases that ran the legacy seed.

DELETE FROM "studios" WHERE "owner_user_id" = '00000000-0000-0000-0000-000000000000';--> statement-breakpoint
DELETE FROM "users" WHERE "id" = '00000000-0000-0000-0000-000000000000';
