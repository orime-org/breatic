-- #11: credits become per-purchase. `credit_lots` is one top-up, `credit_ledger`
-- is the append-only record of every movement. This migration only CREATES —
-- the old `credit_balances` / `credit_transactions` are retired in 0062, after
-- every reader has been moved across, because the auth middleware reads the
-- balance on every authenticated request until then.
--
-- Hand-written (same pattern as 0039 / 0056 / 0060): .sql + _journal entry, no
-- snapshot. The CHECK constraints below are maintained here, not declared in
-- drizzle, for the same reason the membership-tier ones are: a `check()` beside
-- the column would be a second copy that no tool compares against this one.

CREATE TABLE "credit_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Unique, and this is the whole of "a payment grants credits exactly once":
	-- `payments` cannot hold that line, since `stripe_payment_intent_id` has no
	-- unique index and the one on `stripe_session_id` sits on a nullable column,
	-- where Postgres admits any number of NULLs.
	"payment_id" uuid NOT NULL,
	-- The buyer. Never changes: it is where the money came from, not where it
	-- goes. Copied from `payments.user_id` so spending needs no join.
	"user_id" uuid NOT NULL,
	-- numeric, not double precision: a charge is a fraction of a cent and is
	-- summed across lots, so binary floating point would strand a residue that
	-- can neither be spent nor refunded.
	"purchased_credits" numeric(20, 6) NOT NULL,
	"remaining_credits" numeric(20, 6) NOT NULL,
	-- NULL means unassigned, which means unspendable.
	"designated_studio_id" uuid,
	"lifecycle" varchar(16) NOT NULL,
	-- The only trace of a refund that was refused: the lifecycle returns to
	-- `active` afterwards and would otherwise show nothing.
	"refund_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_payment_id_fk"
	FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_designated_studio_id_fk"
	FOREIGN KEY ("designated_studio_id") REFERENCES "studios"("id") ON DELETE restrict;--> statement-breakpoint

-- The five states of the lot lifecycle. A row carrying anything else is
-- invisible to every query that filters on `active`, so the credits would stop
-- existing for their owner with nothing raised.
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_lifecycle_check" CHECK (
	"lifecycle" IN ('active', 'depleted', 'refund_pending', 'refunding', 'refunded')
);--> statement-breakpoint
-- Spending subtracts across lots; an overdraw must fail here rather than leave
-- a lot owing credits.
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_remaining_non_negative_check"
	CHECK ("remaining_credits" >= 0);--> statement-breakpoint

CREATE UNIQUE INDEX "credit_lots_payment_id_idx" ON "credit_lots" ("payment_id");--> statement-breakpoint
CREATE INDEX "credit_lots_user_id_created_at_idx" ON "credit_lots" ("user_id", "created_at");--> statement-breakpoint
-- "The next lot this studio may spend from", oldest first.
CREATE INDEX "credit_lots_studio_lifecycle_idx" ON "credit_lots" ("designated_studio_id", "lifecycle", "created_at");--> statement-breakpoint

CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Whose credits moved. NOT NULL even with payments disabled, where the row
	-- records usage against a person but against no purchase — the account
	-- ledger reads by payer and those rows have to appear in it.
	"payer_user_id" uuid NOT NULL,
	-- Who did the spending. Routinely a different person: a studio's guest can
	-- be an editor on a project and spends the admin's credits there. NULL on
	-- top-ups and refunds, which have no actor.
	"actor_user_id" uuid,
	-- Which purchase was drawn down. NULL wherever usage is recorded without
	-- one: payments disabled, no project to pick a pool from, or a studio with
	-- nothing spendable left.
	"lot_id" uuid,
	"studio_id" uuid,
	"project_id" uuid,
	"entry_type" varchar(24) NOT NULL,
	-- Positive in, negative out.
	"amount" numeric(20, 6) NOT NULL,
	"model" varchar(100),
	"provider" varchar(50),
	"tokens_used" integer,
	"description" text,
	"reference_id" varchar(255),
	-- `created_at` only. No `updated_at`, because nothing here is ever edited,
	-- and no `deleted_at`: this is the soft-delete mandate waived with its
	-- reason stated. A row says something already happened, and deleting it
	-- would make that thing repeatable — which is the single reason this table
	-- exists.
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_payer_user_id_fk"
	FOREIGN KEY ("payer_user_id") REFERENCES "users"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_actor_user_id_fk"
	FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_lot_id_fk"
	FOREIGN KEY ("lot_id") REFERENCES "credit_lots"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_studio_id_fk"
	FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_project_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE restrict;--> statement-breakpoint

-- Every sum over this table filters on one of the four, so a fifth spelling
-- would be money that no balance and no ledger view accounts for.
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_entry_type_check" CHECK (
	"entry_type" IN ('topup', 'spend', 'refund', 'refund_rejected')
);--> statement-breakpoint

-- The account ledger, always taken by payer.
CREATE INDEX "credit_ledger_payer_created_idx" ON "credit_ledger" ("payer_user_id", "created_at" DESC);--> statement-breakpoint
-- A studio's ledger.
CREATE INDEX "credit_ledger_studio_created_idx" ON "credit_ledger" ("studio_id", "created_at" DESC) WHERE "studio_id" IS NOT NULL;--> statement-breakpoint
-- Per-lot reconciliation: `remaining_credits` must equal the sum here.
CREATE INDEX "credit_ledger_lot_idx" ON "credit_ledger" ("lot_id");--> statement-breakpoint
-- "How much of MY money has this studio spent." The payer is part of the
-- question, so the studio-only index above cannot answer it: after a studio is
-- transferred, rows paid for by the previous admin still carry this studio_id.
CREATE INDEX "credit_ledger_payer_studio_created_idx" ON "credit_ledger" ("payer_user_id", "studio_id", "created_at" DESC) WHERE "studio_id" IS NOT NULL;
