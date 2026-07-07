-- Add the project transfer-owner notification types (#1611). The project-owner
-- transfer handshake mirrors studio transfer-admin, so its two actionable /
-- confirmation notification types join the CHECK. Rebuild
-- `notifications_type_check` with the existing 9 types + the 2 new
-- `project.transfer_*` types.
-- Hand-written (same pattern as 0033: .sql + _journal entry, no snapshot) — the
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
		'project.invite_accepted',
		'project.transfer_request',
		'project.transfer_approved'
	)
);
