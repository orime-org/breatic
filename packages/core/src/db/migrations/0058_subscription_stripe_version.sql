-- Which of two views of a subscription is the newer one (#106 §6.5.5, revised).
--
-- The design settled the ordering question by holding the account's row lock
-- across the call to Stripe: lock, then fetch, then write, so two events for
-- one account cannot each fetch and then race to commit. The webhook was built
-- that way and the panel's reconciliation was not — it fetched first and wrote
-- second, so between them there was no protection at all.
--
-- Making both do it the design's way turned out to cost more than it was
-- worth: the fetch is a network call, the Stripe SDK's default timeout is 80
-- seconds with two retries, and the lock is on `users` — a row every path that
-- changes a tier needs. A slow Stripe would have held one database connection
-- and one account's row for minutes at a time.
--
-- So the ordering moves off the lock and onto the data. Every Stripe
-- subscription object carries a `created` timestamp and, once fetched, is a
-- snapshot of a moment; what it does not carry is a version counter. What we
-- can record is WHEN WE FETCHED IT: a writer stamps the moment its snapshot
-- was taken, and a write whose snapshot is older than the stored one is
-- discarded. Both writers then fetch outside any lock, take the lock only to
-- write, and the later snapshot wins regardless of who commits first.
--
-- `NOT NULL DEFAULT now()` rather than nullable: every row is written by one
-- of those two paths, so there is no such thing as a subscription row with no
-- snapshot behind it, and a nullable column would make every comparison ask
-- what a missing value means.
--
-- Hand-written (same pattern as 0018 onward): .sql + _journal entry, no
-- snapshot.

ALTER TABLE "subscriptions"
	ADD COLUMN IF NOT EXISTS "observed_at" timestamp with time zone
	DEFAULT now() NOT NULL;
