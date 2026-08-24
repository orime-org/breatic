-- Which studios an account has run up debt in, read once per opening of the
-- account's credits overview. It is the only read that filters this table by
-- the actor, and the four existing indexes are all on the payer, the studio
-- or the lot — so without this one it scans the whole ledger every time.
--
-- The payer index cannot stand in for it: 0064 cleared `payer_user_id` on
-- exactly the rows this read wants.
--
-- Partial and two-column, because the read asks one question: for this actor,
-- which studios does a `debt_incurred` row name. Restricting the index to
-- that entry type keeps it to the rows that can answer.
CREATE INDEX "credit_ledger_actor_debt_idx"
  ON "credit_ledger" ("actor_user_id", "studio_id")
  WHERE "entry_type" = 'debt_incurred';
