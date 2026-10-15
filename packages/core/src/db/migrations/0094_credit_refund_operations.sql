-- Credit-pack refund disposition (inner#1410).
--
-- The back office decides a refund request; the product executes it here.
-- One row of `credit_refund_operations` is one disposition, every step of it
-- is appended to `credit_refund_operation_events`, `credit_refunds` copies
-- what Stripe says about each refund of a pack's payment, and
-- `refund_mail_outbox` records each buyer email; `credit_refund_reconcile_status`
-- is the daily reconcile's progress row. The first four are money and mail
-- records that live as long as the payment they describe, and the fifth is an
-- internal marker, so none of the five carries deleted_at (NO_SOFT_DELETE,
-- with reasons, in schema-timestamps).

ALTER TABLE "credit_lots" ADD COLUMN "refund_requested_at" timestamp with time zone;--> statement-breakpoint

-- Until now nothing but the request moved a lot into refund_pending, and
-- nothing touched it afterwards, so updated_at is when the buyer asked.
UPDATE "credit_lots" SET "refund_requested_at" = "updated_at" WHERE "lifecycle" = 'refund_pending';--> statement-breakpoint

CREATE TABLE "credit_refund_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lot_id" uuid NOT NULL,
  "payment_id" uuid NOT NULL,
  "kind" varchar(20) NOT NULL,
  "status" varchar(20) NOT NULL,
  "result" varchar(20),
  "attention_reason" varchar(40),
  "attention_detail" text,
  "attention_closed_at" timestamp with time zone,
  "attention_closed_by" uuid,
  "idempotency_key" varchar(255) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "requested_by" varchar(64) NOT NULL,
  "reason" text NOT NULL,
  "notify" boolean NOT NULL,
  -- The ask this disposition answered, copied from the lot at insert: the
  -- buyer may ask again after a rejection, which rewrites the lot's column.
  "refund_requested_at" timestamp with time zone,
  "confirmed_refund_ids" text[] DEFAULT '{}' NOT NULL,
  "confirmed_succeeded_cents" bigint,
  -- resolve_outside and restore_credits: the failed refunds the operator
  -- answered for, as the confirmation page showed them.
  "failed_refund_ids" text[] DEFAULT '{}' NOT NULL,
  "settled_succeeded_cents" bigint,
  "stripe_refund_id" varchar(255),
  "first_called_at" timestamp with time zone,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "last_error" text,
  "lease_token" uuid,
  "locked_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "credit_refund_operations_idempotency_key_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "credit_refund_operations_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "credit_lots"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_refund_operations_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_refund_operations_closed_by_fk" FOREIGN KEY ("attention_closed_by") REFERENCES "credit_refund_operations"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_refund_operations_kind_check" CHECK (
    "kind" IN ('approve', 'reject', 'settle', 'send_back', 'retry', 'resolve_outside', 'restore_credits')
  ),
  CONSTRAINT "credit_refund_operations_status_check" CHECK (
    "status" IN ('started', 'awaiting_stripe', 'succeeded', 'needs_attention')
  ),
  -- A result exactly when the disposition is done. `IS NOT NULL` is spelled
  -- out because a CHECK that evaluates to NULL passes, and `NULL IN (...)` is
  -- NULL.
  CONSTRAINT "credit_refund_operations_result_check" CHECK (
    ("status" = 'succeeded' AND "result" IS NOT NULL
      AND "result" IN ('refunded', 'rejected', 'sent_back', 'resolved_outside', 'restored'))
    OR ("status" <> 'succeeded' AND "result" IS NULL)
  ),
  CONSTRAINT "credit_refund_operations_attention_check" CHECK (
    "attention_reason" IS NULL OR "attention_reason" IN (
      'partial_refund', 'unexpected_external_refund', 'stripe_refund_failed_later',
      'attempts_exhausted', 'stripe_result_unknown', 'already_refunded_elsewhere',
      'stripe_declined', 'stripe_request_invalid', 'state_mismatch'
    )
  )
);--> statement-breakpoint

-- At most one disposition in flight per lot: the second request for the same
-- lot is refused here even when two transactions race past the code's check.
CREATE UNIQUE INDEX "credit_refund_operations_one_in_flight" ON "credit_refund_operations" USING btree ("lot_id") WHERE "status" IN ('started', 'awaiting_stripe');--> statement-breakpoint
CREATE INDEX "credit_refund_operations_lot_idx" ON "credit_refund_operations" USING btree ("lot_id", "created_at");--> statement-breakpoint
-- The loop's two scans: claimable started rows and due awaiting_stripe rows.
CREATE INDEX "credit_refund_operations_due_idx" ON "credit_refund_operations" USING btree ("status", "next_attempt_at") WHERE "status" IN ('started', 'awaiting_stripe');--> statement-breakpoint

CREATE TABLE "credit_refund_operation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "operation_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "event" varchar(40) NOT NULL,
  -- NULL for the event that created the disposition.
  "from_status" varchar(20),
  "to_status" varchar(20) NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "credit_refund_operation_events_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "credit_refund_operations"("id") ON DELETE RESTRICT
);--> statement-breakpoint
CREATE INDEX "credit_refund_operation_events_operation_idx" ON "credit_refund_operation_events" USING btree ("operation_id", "created_at");--> statement-breakpoint

CREATE TABLE "credit_refunds" (
  "stripe_refund_id" varchar(255) PRIMARY KEY NOT NULL,
  "payment_id" uuid NOT NULL,
  "lot_id" uuid NOT NULL,
  -- NULL for a refund made outside the product (the Stripe dashboard).
  "operation_id" uuid,
  "amount_cents" bigint NOT NULL,
  "currency" varchar(3) NOT NULL,
  "status" varchar(20) NOT NULL,
  "failure_reason" varchar(64),
  -- Stripe's reason while the refund is pending; NULL in every other status.
  "pending_reason" varchar(20),
  -- Stripe's refund object keeps no memory of having succeeded; this column
  -- does, and only ever turns from false to true.
  "ever_succeeded" boolean DEFAULT false NOT NULL,
  "resolved_by_operation_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credit_refunds_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_refunds_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "credit_lots"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_refunds_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "credit_refund_operations"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_refunds_resolved_by_fk" FOREIGN KEY ("resolved_by_operation_id") REFERENCES "credit_refund_operations"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_refunds_status_check" CHECK (
    "status" IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')
  ),
  CONSTRAINT "credit_refunds_pending_reason_check" CHECK (
    "pending_reason" IS NULL OR "pending_reason" IN ('processing', 'insufficient_funds', 'charge_pending')
  )
);--> statement-breakpoint
CREATE INDEX "credit_refunds_payment_idx" ON "credit_refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "credit_refunds_lot_idx" ON "credit_refunds" USING btree ("lot_id");--> statement-breakpoint

CREATE TABLE "refund_mail_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "operation_id" uuid NOT NULL,
  "kind" varchar(20) NOT NULL,
  "origin" varchar(10) NOT NULL,
  -- Filled on `resend` rows only.
  "requested_by" varchar(64),
  "reason" text,
  "idempotency_key" varchar(255),
  "request_hash" varchar(64),
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "last_error" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The `sending` timeout reads this column, as purchase_mail_outbox does.
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "refund_mail_outbox_idempotency_key_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "refund_mail_outbox_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "credit_refund_operations"("id") ON DELETE RESTRICT,
  CONSTRAINT "refund_mail_outbox_kind_check" CHECK ("kind" IN ('refund_completed', 'refund_rejected', 'refund_restored')),
  CONSTRAINT "refund_mail_outbox_origin_check" CHECK ("origin" IN ('auto', 'resend')),
  CONSTRAINT "refund_mail_outbox_status_check" CHECK (
    "status" IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'unknown')
  )
);--> statement-breakpoint
-- Each disposition sends its automatic mail once; resends are new rows.
CREATE UNIQUE INDEX "refund_mail_outbox_one_auto" ON "refund_mail_outbox" USING btree ("operation_id") WHERE "origin" = 'auto';--> statement-breakpoint
CREATE INDEX "refund_mail_outbox_status_idx" ON "refund_mail_outbox" USING btree ("status", "created_at") WHERE "status" IN ('pending', 'sending');--> statement-breakpoint

CREATE TABLE "credit_refund_reconcile_status" (
  "name" varchar(32) PRIMARY KEY NOT NULL,
  "last_started_at" timestamp with time zone,
  "last_finished_at" timestamp with time zone,
  "last_ok_at" timestamp with time zone,
  "last_error" text,
  "failing_payment_ids" uuid[] DEFAULT '{}' NOT NULL,
  "next_retry_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

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
		'project.join_request',
		'project.join_approved',
		'project.join_rejected',
		'membership.ended',
		'membership.upgrade_incomplete',
		'storage.quota_exceeded',
		'credit.refund_completed',
		'credit.refund_rejected',
		'credit.refund_restored'
	)
);--> statement-breakpoint

-- Restoring a pack's credits after a failed refund books a reversing row.
ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_entry_type_check";--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_entry_type_check" CHECK (
	"entry_type" IN ('topup', 'spend', 'refund', 'refund_rejected',
	                 'debt_incurred', 'debt_repayment', 'refund_reversed')
);--> statement-breakpoint

-- The one definition of an unresolved failed refund (inner#1410 §5.3): failed
-- or canceled, answered by no disposition, on a lot still in the refund flow;
-- on a booked lot only one that failed after it had succeeded counts, since
-- booking answered for those already failed. The product and the back office
-- both read this view.
CREATE VIEW "credit_refunds_unresolved_failed" AS
SELECT r."lot_id", r."payment_id", r."stripe_refund_id", r."amount_cents", r."currency", r."status"
FROM "credit_refunds" r
JOIN "credit_lots" l ON l."id" = r."lot_id"
WHERE r."status" IN ('failed', 'canceled')
  AND r."resolved_by_operation_id" IS NULL
  AND (l."lifecycle" IN ('refund_pending', 'refunding')
       OR (l."lifecycle" = 'refunded' AND r."ever_succeeded"));--> statement-breakpoint

-- The lots on the back office's "refund failed" list (§5.3): an unresolved
-- failed refund, or a lot still refunding, with nothing in flight, that
-- Stripe once refused outright (no refund object, so no copy to point at).
CREATE VIEW "credit_lot_refund_failures" AS
SELECT u."lot_id" FROM "credit_refunds_unresolved_failed" u
UNION
SELECT l."id" AS "lot_id"
FROM "credit_lots" l
WHERE l."lifecycle" = 'refunding'
  AND EXISTS (
    SELECT 1 FROM "credit_refund_operations" o
    WHERE o."lot_id" = l."id" AND o."attention_reason" = 'stripe_declined'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "credit_refund_operations" o
    WHERE o."lot_id" = l."id" AND o."status" IN ('started', 'awaiting_stripe')
  );
