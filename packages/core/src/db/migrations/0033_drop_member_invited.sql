-- Drop the dead `studio.member_invited` notification type (2026-06-22). It was
-- declared in the type union + the CHECK + had a BellMenu rendering branch, but
-- NOTHING ever produced it (no constructor / insert) — confirmed by grep. Now
-- that the bell actor-identity work touches every notification type, the dead
-- type is fully retired here. Rebuild the CHECK with the 9 still-valid types
-- (everything 0032 left, minus studio.member_invited).
-- Hand-written (same pattern as 0032: .sql + _journal entry, no snapshot) — the
-- notifications CHECK is maintained manually.

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK (
	"type" IN (
		'access.role_upgrade_request',
		'access.role_upgrade_approved',
		'access.role_upgrade_rejected',
		'studio.transfer_request',
		'studio.transfer_approved',
		'studio.invite_request',
		'studio.invite_accepted',
		'project.invite_request',
		'project.invite_accepted'
	)
);
