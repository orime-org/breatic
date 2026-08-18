-- The bell can now say a membership ended (#106 §9).
--
-- Ratified 2026-08-18: an account that falls back to `base` is told, whichever
-- of the four paths brought it down — the subscription was cancelled and its
-- period ran out, the retries were exhausted into `unpaid`, the first invoice
-- expired, or the reconciliation found Stripe disagreeing with us.
--
-- The bell rather than only the email, because in this codebase the bell IS the
-- delivery guarantee: `notification-mail.ts` states in its header that the
-- email is an optional enhancement that fires only when an SMTP backend is
-- configured, and `EMAIL_BACKEND` defaults to `disabled`. A notice that exists
-- only in a channel that is off by default would not meet the acceptance item
-- it is there for — that nobody discovers one day that they are no longer a
-- member.
--
-- Informational, so no TTL and nothing to answer: it links nowhere and is read
-- on click, like the five `*_approved` / `*_accepted` rows already are.
--
-- Rebuild `notifications_type_check` with the existing 11 types + this one.
-- Hand-written (same pattern as 0039): .sql + _journal entry, no snapshot; the
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
		'project.transfer_approved',
		'membership.ended'
	)
);
