-- slice 3: notifications gain `expires_at` (actionable-notification TTL — the
-- 7-day transfer-admin confirmation window) and three studio notification
-- types. Hand-written (drizzle-kit generate needs a TTY here; same pattern as
-- 0025/0026/0027: .sql + _journal entry, no snapshot).
--
-- spec: breatic-inner/engineering/specs/2026-06-08-studio-slice3-members-design.md § 2.5

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";--> statement-breakpoint

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK (
	"type" IN (
		'access.role_upgrade_request',
		'access.role_upgrade_approved',
		'access.role_upgrade_rejected',
		'access.member_joined',
		'studio.member_invited',
		'studio.transfer_request',
		'studio.transfer_approved'
	)
);
