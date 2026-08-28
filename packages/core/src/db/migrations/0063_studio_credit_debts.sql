-- #11: a studio can end a generation owing credits, and the debt has to live
-- somewhere that can be locked, read and paid off.
--
-- The gap it closes: the precheck reads what is spendable and freezes nothing
-- (`credit-precheck.service.ts`, decided 2026-07-03), and what it asks for is
-- a floor — `MIN_TASK_CREDIT_COST = 5` for every mini-tool, and the same 5
-- whenever a model's `cost_per_call` is missing. The worker then bills what
-- the run actually used. So a studio with 5 credits left, one person, no
-- concurrency at all, can finish a generation owing tens of credits.
--
-- Hand-written (same pattern as 0061 / 0062): .sql + _journal entry, no
-- snapshot. The CHECKs are maintained here, not in drizzle, for the reason
-- 0061 states: a `check()` beside the column is a second copy nothing
-- compares against this one.

CREATE TABLE "studio_credit_debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	-- What this studio owes right now. A mutable current value rather than a
	-- sum over the ledger, for the same reason `credit_lots.remaining_credits`
	-- is one: two write paths have to be serialised against each other, and a
	-- sum cannot be locked. Both reconcile against the ledger.
	"amount" numeric(20, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- No `deleted_at`, and this is the repository's soft-delete mandate being
-- waived with its reason stated: soft-deleting a debt row is the debt
-- vanishing, which is the one thing this table exists to prevent. What
-- happens to a debt when its studio is deleted is a business decision that
-- belongs to that work, not a row being hidden.

ALTER TABLE "studio_credit_debts" ADD CONSTRAINT "studio_credit_debts_studio_id_fk"
	FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE restrict;--> statement-breakpoint

-- One row per studio, and the row both write paths lock. Not partial: the
-- table has no soft delete, so there is no second row to exclude.
CREATE UNIQUE INDEX "studio_credit_debts_studio_id_idx" ON "studio_credit_debts" ("studio_id");--> statement-breakpoint

-- Paying off more than is owed would leave the studio with a credit balance
-- expressed as a negative debt — a second place where spendable credits live.
ALTER TABLE "studio_credit_debts" ADD CONSTRAINT "studio_credit_debts_amount_non_negative_check"
	CHECK ("amount" >= 0);--> statement-breakpoint

-- Two more entry types. `debt_incurred` is the shortfall a charge could not
-- cover; `debt_repayment` is a designation paying it down.
ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_entry_type_check";--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_entry_type_check" CHECK (
	"entry_type" IN ('topup', 'spend', 'refund', 'refund_rejected',
	                 'debt_incurred', 'debt_repayment')
);--> statement-breakpoint

-- A lot on its way out of the account belongs to no studio.
--
-- The rule (decided 2026-08-21; how the lot gets there revised 2026-08-28):
-- a refund is asked for on a lot the buyer has already released, and until
-- the refund resolves it cannot be designated to any studio — a rejection
-- returns it to `active`, still unassigned, and only then may it be
-- designated again.
--
-- This constraint is what a machine can see of that rule. Without it the only
-- statement of it is prose in the refund task, and the invariant the debt
-- model rests on — a studio that owes credits has no spendable lots — would
-- fail silently the day a lot under refund kept its designation.
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_refund_undesignated_check" CHECK (
	"lifecycle" NOT IN ('refund_pending', 'refunding', 'refunded')
	OR "designated_studio_id" IS NULL
);
