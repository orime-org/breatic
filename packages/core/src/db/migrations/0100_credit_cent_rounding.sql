-- inner#1666: every charge now settles to whole hundredths of a credit,
-- rounded up. Balances written before that carry up to six decimals; this
-- settles them the same way the charges would have: a lot keeps what is left
-- cut down to two decimals, a studio's debt and a running hold are raised to
-- two decimals. Each change to a lot or a debt books a `rounding_adjustment`
-- row, so a lot still equals its ledger sum and a debt still reconciles as
-- sum(debt_repayment) - sum(debt_incurred) - sum(rounding_adjustment, no lot).
--
-- Servers on the previous release keep charging while this runs. The tables
-- are locked first, in EXCLUSIVE mode, which conflicts with the row locks a
-- charge or a hold takes: this waits for every transaction already in them
-- and holds new ones back until it commits, so each balance is read and
-- rewritten with nothing writing in between. The tables are taken one at a
-- time in the order a charge locks them (a studio's debt, its holds, its
-- lots: `creditLotService.chargeForGeneration`), so a charge already holding
-- a debt row is never waiting on a lot this has locked. The ledger's CHECK
-- change needs its own exclusive lock until commit; taking row locks after it
-- would wait on a charge that is itself waiting to write the ledger.
--
-- Every statement touches only rows that still carry more than two decimals,
-- so running the data part again changes nothing; a later migration runs it
-- again for what the previous release wrote after this one.

LOCK TABLE "studio_credit_debts", "credit_holds", "credit_lots", "credit_ledger" IN EXCLUSIVE MODE;--> statement-breakpoint

ALTER TABLE "credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_entry_type_check";--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_entry_type_check" CHECK (
	"entry_type" IN ('topup', 'spend', 'refund', 'refund_rejected',
	                 'debt_incurred', 'debt_repayment', 'refund_reversed',
	                 'rounding_adjustment')
);--> statement-breakpoint

-- A debt has no payer, and neither does the row raising one.
ALTER TABLE "credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_payer_present";--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_payer_present"
	CHECK ("entry_type" IN ('debt_incurred', 'rounding_adjustment') OR "payer_user_id" IS NOT NULL);--> statement-breakpoint

-- A lot cut to nothing is spent, the state a charge leaves it in.
WITH "cut" AS (
	UPDATE "credit_lots" AS "l"
	SET "remaining_credits" = trunc("l"."remaining_credits", 2),
	    "lifecycle" = CASE
	      WHEN trunc("l"."remaining_credits", 2) = 0 AND "l"."lifecycle" = 'active' THEN 'depleted'
	      ELSE "l"."lifecycle"
	    END,
	    "updated_at" = now()
	FROM (
	  SELECT "id", "remaining_credits" AS "before" FROM "credit_lots"
	  WHERE "remaining_credits" <> trunc("remaining_credits", 2)
	) AS "o"
	WHERE "l"."id" = "o"."id"
	RETURNING "l"."id", "l"."user_id", "o"."before" - "l"."remaining_credits" AS "delta"
)
INSERT INTO "credit_ledger" ("payer_user_id", "lot_id", "entry_type", "amount", "description")
SELECT "user_id", "id", 'rounding_adjustment', -"delta", 'rounding adjustment' FROM "cut";--> statement-breakpoint

WITH "raised" AS (
	UPDATE "studio_credit_debts" AS "d"
	SET "amount" = ceil("d"."amount" * 100) / 100,
	    "updated_at" = now()
	FROM (
	  SELECT "id", "amount" AS "before" FROM "studio_credit_debts"
	  WHERE "amount" <> trunc("amount", 2)
	) AS "o"
	WHERE "d"."id" = "o"."id"
	RETURNING "d"."studio_id", "d"."amount" - "o"."before" AS "delta"
)
INSERT INTO "credit_ledger" ("studio_id", "entry_type", "amount", "description")
SELECT "studio_id", 'rounding_adjustment', -"delta", 'rounding adjustment' FROM "raised";--> statement-breakpoint

-- A hold is a reservation, not a movement of credits: it books no row.
UPDATE "credit_holds"
SET "amount" = ceil("amount" * 100) / 100,
    "updated_at" = now()
WHERE "status" = 'held' AND "amount" <> trunc("amount", 2);
