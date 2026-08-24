-- A debt has no payer. It is what a studio owes, recorded the moment a
-- charge could not be covered — the money for it is paid later, by whoever
-- assigns a purchase to that studio, and that payment is its own
-- `debt_repayment` row carrying that person.
--
-- Until now the debt row carried the person who ran the generation, which
-- put half of one generation on their account and the other half on the
-- funder's. Neither account's ledger added up.
ALTER TABLE "credit_ledger" ALTER COLUMN "payer_user_id" DROP NOT NULL;
--> statement-breakpoint

-- Existing debt rows were stamped with the actor. Clearing them makes the
-- column mean one thing.
UPDATE "credit_ledger" SET "payer_user_id" = NULL
WHERE "entry_type" = 'debt_incurred';
--> statement-breakpoint

-- Every other entry type still names a payer.
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_payer_present"
  CHECK ("entry_type" = 'debt_incurred' OR "payer_user_id" IS NOT NULL);
