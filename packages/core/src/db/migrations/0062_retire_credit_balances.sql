-- #11: the account-wide balance and the lot-less ledger retire, now that every
-- reader has moved to `credit_lots` / `credit_ledger` (0061).
--
-- The two tables go different ways, because they held different things.
--
-- `credit_balances` is dropped. Once credits are spendable only where they are
-- assigned, one number per account is not an amount anybody can spend — it
-- answers no question, and leaving it in place leaves something for a future
-- reader to make a decision from.
--
-- `credit_transactions` is renamed and kept read-only. Its rows record real
-- spending, but they carry no lot, so there is nothing to carry them into the
-- new ledger with. The new books start empty and the old rows stay where
-- anyone auditing the period before this change can still read them.
--
-- Hand-written (same pattern as 0039 / 0056 / 0060 / 0061): .sql + _journal
-- entry, no snapshot.

DROP TABLE IF EXISTS "credit_balances";--> statement-breakpoint

ALTER TABLE "credit_transactions" RENAME TO "credit_transactions_archived";--> statement-breakpoint
COMMENT ON TABLE "credit_transactions_archived" IS
	'Read-only. Credit movements recorded before the per-purchase model (#11, 0062). No lot dimension, so these rows are not part of any balance.';
