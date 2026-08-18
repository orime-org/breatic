-- The bell can now speak about a membership (#106 §9, §7.3).
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
-- The second type covers the other end of an upgrade: the difference was never
-- paid, so after 23 hours Stripe discards the change. Nothing failed on our
-- side and nothing is owed, but somebody who clicked upgrade and saw nothing
-- happen deserves to be told why.
--
-- Both are informational: no TTL and nothing to answer, read on click, like
-- the five `*_approved` / `*_accepted` rows already are.
--
-- Rebuild `notifications_type_check` with the existing 11 types + these two.
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
		'membership.ended',
		'membership.upgrade_incomplete'
	)
);
