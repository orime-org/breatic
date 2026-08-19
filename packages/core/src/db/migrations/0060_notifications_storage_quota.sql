-- #89 (membership block five): the storage gate tells a studio's admin when
-- their account has run out of room, because nobody else can act on it —
-- a member who is refused can neither upgrade the membership nor delete
-- assets.
--
-- Rebuild `notifications_type_check` with the existing 13 types + this one.
-- Hand-written (same pattern as 0039 / 0056): .sql + _journal entry, no
-- snapshot; the notifications CHECK is maintained manually.

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
		'project.invite_accepted',
		'project.transfer_request',
		'project.transfer_approved',
		'membership.ended',
		'membership.upgrade_incomplete',
		'storage.quota_exceeded'
	)
);
