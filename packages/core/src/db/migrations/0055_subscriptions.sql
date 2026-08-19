-- Accounts can now pay a monthly subscription, and we can tell whose it is.
--
-- 0052 put the tier on `users` and 0053 wrote down every move of it, both
-- saying the same thing: what makes the tier change is the Stripe work that
-- comes later. This is that work's data model — three pieces, each answering
-- a question the other two cannot.
--
-- ── who is paying ────────────────────────────────────────────────────
--
-- `users.stripe_customer_id` is the root of the identification chain.
-- Subscription events carry nothing of ours: `client_reference_id` reaches
-- the Checkout Session object only, and never the subscription. So the
-- customer must exist BEFORE checkout and be stored here — letting Stripe
-- create one during checkout would mean first meeting that id inside an event
-- with nothing to match it against, and the account that just paid would be
-- unidentifiable.
--
-- Nullable: an account that never tried to pay us has no customer, and
-- creating one per registration would make a Stripe object per signup.
--
-- ── what they are paying for ─────────────────────────────────────────
--
-- `subscriptions` holds every subscription an account has ever had, not its
-- current one. A subscription that ends stays as a ledger entry and a new one
-- is inserted beside it, which is why the unique constraint is on the Stripe
-- id and deliberately NOT on `user_id`: one there would refuse the second
-- subscription of anybody who cancelled and came back, and that refusal would
-- land on somebody who had already paid. "Does this account subscribe" is a
-- query over `status`, never "is there a row".
--
-- `status` stores Stripe's own word unchanged. Which tier a given word earns
-- was reworked once during design; had the conclusion been stored instead,
-- every historical row would have become wrong at that moment.
--
-- `has_pending_update` is its own column rather than an inference from
-- `payable_invoice_url`, because an account behind on payment carries a
-- payable invoice too — an unpaid upgrade and an unpaid renewal look alike in
-- that field and offer different actions.
--
-- `user_id` is ON DELETE RESTRICT like the credit ledger's: accounts are
-- soft-deleted, so a hard delete that would orphan this history is refused by
-- the database rather than by convention.
--
-- ── what has already been handled ────────────────────────────────────
--
-- `stripe_webhook_events` is the idempotency guard, and its primary key is
-- the whole mechanism: the insert goes in the same transaction as the tier
-- change, so a redelivery collides and the transaction is abandoned.
-- `changeMembershipTier` compares tiers rather than event identity, so it
-- converges on the last call and cannot distinguish a replay from a new
-- event — 0053's own comment says so, and this table is the answer it names.
--
-- Append-only: `created_at` alone, no `deleted_at`. Deleting a row is exactly
-- what would make its event replayable.
--
-- Hand-written (drizzle-kit generate needs a TTY here; same pattern as
-- 0018/0025/0026/0049/0052/0053: .sql + _journal entry, no snapshot).

ALTER TABLE "users"
	ADD COLUMN IF NOT EXISTS "stripe_customer_id" varchar(255);--> statement-breakpoint

-- One query shape: given a Stripe customer from an event, whose account is it.
CREATE INDEX IF NOT EXISTS "users_stripe_customer_id_idx"
	ON "users" ("stripe_customer_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_subscription_id" varchar(255) NOT NULL,
	"tier" varchar(16) NOT NULL,
	"status" varchar(30) NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"stripe_item_id" varchar(255),
	"has_pending_update" boolean DEFAULT false NOT NULL,
	"pending_tier" varchar(16),
	"payable_invoice_url" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_tier_check" CHECK (
		"tier" IN ('base', 'pro', 'team', 'self_hosted', 'enterprise')
	),
	CONSTRAINT "subscriptions_pending_tier_check" CHECK (
		"pending_tier" IS NULL
		OR "pending_tier" IN ('base', 'pro', 'team', 'self_hosted', 'enterprise')
	)
);--> statement-breakpoint

ALTER TABLE "subscriptions"
	ADD CONSTRAINT "subscriptions_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Everything one account has ever subscribed to.
CREATE INDEX IF NOT EXISTS "subscriptions_user_id_idx"
	ON "subscriptions" ("user_id");--> statement-breakpoint

-- One row per Stripe subscription, many per account. See the note above on
-- why this is not on user_id.
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_stripe_subscription_id_idx"
	ON "subscriptions" ("stripe_subscription_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
	"event_id" varchar(255) PRIMARY KEY NOT NULL,
	"type" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
