-- One account, at most one live subscription — held by the database (#106 §6.5.5).
--
-- The design named this invariant and named a fallback for it ("refuse to
-- insert when a live row already exists"), and neither existed in code. What
-- stood in for it was an ordering: the reading took the newest row and hoped
-- it was the right one. That hope has no basis — `created_at` defaults to
-- `now()`, which in PostgreSQL is the TRANSACTION's start time, so two rows
-- written in one transaction carry the same timestamp, and the primary key is
-- a random UUID rather than a sequence. The webhook writes a subscription row
-- and reads it back inside one transaction, so the tie is not hypothetical.
--
-- Two live subscriptions is not a display problem: both were paid for, and
-- which one governs the account would be decided by whichever row the database
-- happened to return first.
--
-- A partial unique index rather than a check in application code, because the
-- two ways to get here are concurrent: two checkout sessions completing at
-- once, and an event arriving while the panel reconciles. A check-then-insert
-- in either path cannot see what the other is midway through; a unique index
-- can. The predicate names only `status` and `deleted_at` — no `now()`, which
-- a partial index may not reference (it must be immutable).
--
-- The live set is the same three statuses the reading treats as live
-- (`subscription-state.ts`): a first invoice not yet settled still holds the
-- account, and so does one Stripe is retrying. `trialing` and `paused` are
-- absent for the same reason they are absent there — we never create them.
--
-- Writers must demote an ending subscription before inserting its replacement.
-- The reconciliation loop therefore writes ended subscriptions first.
--
-- Hand-written (same pattern as 0018/0025/0026/0049/0052/0053/0054/0055):
-- .sql + _journal entry, no snapshot.

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_one_live_per_user_idx"
	ON "subscriptions" ("user_id")
	WHERE "deleted_at" IS NULL
	  AND "status" IN ('incomplete', 'active', 'past_due');
