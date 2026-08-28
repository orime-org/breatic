-- Task #13 — connecting the Stripe top-up path.
--
-- Three things this migration establishes.
--
-- `payments` learns what Stripe works this purchase out to be. `amount_cents`
-- is the pre-tax face value taken from our own price table; `total_cents` and
-- `tax_cents` are read back off the Checkout Session. They are filled the
-- first time we read a session Stripe has already priced: for a delayed
-- payment method that is when its session completes, days before the money
-- moves; for every other purchase it is settlement itself, written alongside
-- the CAS. So carrying them says nothing about whether the money moved, which
-- `status` answers. Both stay NULL until then, because Stripe cannot work out
-- the tax without knowing where the buyer is. A refund of a landed
-- purchase pays back `total_cents`, since the confirmation email promises a
-- full refund while itemising the tax.
--
-- `payments.status` gains a CHECK listing its four values. `expired` is new:
-- it is how an abandoned checkout leaves "processing". Without it the purchase
-- record would show a payment as in flight for as long as the session lives,
-- with nothing in flight.
--
-- Two tables carry what a purchase leaves behind. `purchase_consents` is legal
-- evidence and `purchase_mail_outbox` is the record of the confirmation email.
-- Both key on `payment_id` UNIQUE: all four callers of the fulfillment
-- function reach these writes, and the constraint is what makes the later ones
-- no-ops rather than duplicates. Neither carries `deleted_at` — they live as
-- long as the payment they describe, and deleting a consent record would
-- destroy the evidence it exists to be.

ALTER TABLE "payments" ADD COLUMN "tax_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "total_cents" integer;--> statement-breakpoint

ALTER TABLE "payments" ADD CONSTRAINT "payments_status_check"
  CHECK ("status" IN ('pending', 'completed', 'failed', 'expired'));--> statement-breakpoint

CREATE TABLE "purchase_consents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "locale" varchar(10) NOT NULL,
  "consent_text_version" varchar(20) NOT NULL,
  "refund_text_version" varchar(20),
  -- When the buyer ticked, by our own clock. The tick happens on our confirm
  -- dialog, and the checkout request that follows is refused without it, so
  -- the instant is taken there and kept on the `payments` row's own metadata
  -- until settlement writes this row. Stripe is told nothing of it: the two
  -- instants Hosted Checkout does report — when the session was created and
  -- when it expires — are two hours apart, and neither is that moment.
  "consented_at" timestamp with time zone NOT NULL,
  "stripe_payment_intent_id" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "purchase_consents_payment_id_unique" UNIQUE ("payment_id")
);--> statement-breakpoint

ALTER TABLE "purchase_consents" ADD CONSTRAINT "purchase_consents_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "purchase_consents" ADD CONSTRAINT "purchase_consents_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "purchase_consents_user_id_idx" ON "purchase_consents" ("user_id");--> statement-breakpoint

CREATE TABLE "purchase_mail_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_id" uuid NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The `sending` timeout reads this column: a process replaced between
  -- claiming `sending` and writing the result would otherwise strand the row,
  -- with no background sweep to free it.
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "purchase_mail_outbox_payment_id_unique" UNIQUE ("payment_id"),
  CONSTRAINT "purchase_mail_outbox_status_check"
    CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'skipped'))
);--> statement-breakpoint

ALTER TABLE "purchase_mail_outbox" ADD CONSTRAINT "purchase_mail_outbox_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE restrict;
