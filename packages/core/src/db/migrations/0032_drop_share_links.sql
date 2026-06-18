-- drop the legacy `share_links` table (#1337 follow-up, 2026-06-18). Project
-- invites now go through the same invite-confirm handshake as studio
-- (`project_invitations`, migration 0031) — the old public/email share-link
-- model (and its `access.member_joined` notification) is gone, so the table and
-- that notification type are removed. This is a structural schema migration, not
-- a soft delete: the table is physically dropped (pre-launch, no data to keep).
-- Hand-written (same pattern as 0028 / 0029 / 0031: .sql + _journal entry, no
-- snapshot) — drizzle's headless `generate` needs a TTY to drop a table, and the
-- notifications CHECK is maintained manually.

DROP TABLE IF EXISTS "share_links";--> statement-breakpoint
-- Drop `access.member_joined` from the notifications type CHECK — it was only
-- ever emitted when someone consumed a share link to join. Rebuild the CHECK
-- with the full set of still-valid types (everything 0031 left, minus
-- member_joined).
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK (
	"type" IN (
		'access.role_upgrade_request',
		'access.role_upgrade_approved',
		'access.role_upgrade_rejected',
		'studio.member_invited',
		'studio.transfer_request',
		'studio.transfer_approved',
		'studio.invite_request',
		'studio.invite_accepted',
		'project.invite_request',
		'project.invite_accepted'
	)
);
