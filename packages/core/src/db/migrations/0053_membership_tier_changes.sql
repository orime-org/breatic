-- An account's tier can now change, and every change is written down.
--
-- 0052 put the tier on `users` and said in as many words that what makes it
-- change is the work that comes later. This is that work's data model: a
-- ledger of moves, and a constraint on the value itself.
--
-- ── the ledger ───────────────────────────────────────────────────────
--
-- The column answers "what is this account on"; it cannot answer "how did it
-- get there", and that is the question a tier eventually raises. Somebody
-- paid for it, so "when did my team plan start" and "why am I on base" have
-- to come out of our own records rather than a Stripe dashboard that may have
-- been reconciled since.
--
-- Same shape as `credit_transactions`, for the same reason: the current value
-- is a scalar elsewhere and every change to it is appended here. Append-only,
-- so `created_at` alone and no `deleted_at` — a row is written once, and
-- deleting one would leave a history that no longer adds up to the value on
-- the account. `user_id` is ON DELETE RESTRICT like the credit ledger's:
-- accounts are soft-deleted, so a hard delete that would orphan this history
-- is refused by the database rather than by convention.
--
-- `reference_id` carries whatever the trigger was identified by upstream (a
-- Stripe subscription or event id once subscriptions land). It is NOT what
-- makes a redelivered webhook safe: comparing tiers converges on the last
-- call and cannot tell a replay from a new event, so that work keys its
-- idempotency on event identity.
--
-- ── the constraint ───────────────────────────────────────────────────
--
-- The tier column has been a bare varchar since 0052, so a hand-written
-- UPDATE could put `Pro` in it and nothing would notice until somebody read
-- the row. The read side already refuses an unknown value by name; this is
-- the other half, and it refuses the write.
--
-- Five values, not four. `enterprise` is a real tier of the product,
-- negotiated per customer. A constraint that omitted it would make setting an
-- account to it impossible rather than explicit — and the two guards would
-- then contradict each other, since the code knows the word. What the tier
-- may not have is ceilings out of `config/membership.yaml`: those are agreed
-- per customer and will be read from the database, so asking for them fails
-- loudly and names the account instead of returning numbers nobody agreed to.
--
-- Added validated rather than NOT VALID: since 0052 the only writer is
-- registration, which writes a value the config schema already validated, so
-- no deployment can hold a row this rejects. If one somehow does, the
-- migration failing is the right outcome — that row needs fixing, not
-- grandfathering.
--
-- Hand-written (drizzle-kit generate needs a TTY here; same pattern as
-- 0018/0025/0026/0049/0052: .sql + _journal entry, no snapshot).

CREATE TABLE IF NOT EXISTS "membership_tier_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_tier" varchar(16) NOT NULL,
	"to_tier" varchar(16) NOT NULL,
	"reason" varchar(32) NOT NULL,
	"reference_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_tier_changes_from_tier_check" CHECK (
		"from_tier" IN ('base', 'pro', 'team', 'self_hosted', 'enterprise')
	),
	CONSTRAINT "membership_tier_changes_to_tier_check" CHECK (
		"to_tier" IN ('base', 'pro', 'team', 'self_hosted', 'enterprise')
	)
);--> statement-breakpoint

ALTER TABLE "membership_tier_changes"
	ADD CONSTRAINT "membership_tier_changes_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- One query shape: everything that happened to one account, newest last.
CREATE INDEX IF NOT EXISTS "membership_tier_changes_user_id_idx"
	ON "membership_tier_changes" ("user_id");--> statement-breakpoint

ALTER TABLE "users"
	ADD CONSTRAINT "users_membership_tier_check"
	CHECK ("membership_tier" IN ('base', 'pro', 'team', 'self_hosted', 'enterprise'));
