-- Which billing period a subscription was bought over (#253).
--
-- The tier alone no longer says what somebody pays: PRO monthly and PRO
-- annual are the same tier at two prices, over two lengths of time.
--
-- Existing rows are all monthly. `upsertSubscription` is the only writer, and
-- the read that feeds it refuses a price it does not recognise, so every row
-- here came from one of the two monthly prices that existed before this.
--
-- `period` carries no default on purpose. With one, a writer that forgot the
-- column would land silently on monthly, and a subscription that quietly
-- claims the cheaper period is worse than one that fails loudly.
--
-- The CHECK is written by hand rather than declared in drizzle, for the same
-- reason `subscriptions.tier`'s is (0055): migrations here are hand-written,
-- so a declaration beside the column would be a second copy with nothing
-- comparing it against this one.
ALTER TABLE subscriptions ADD COLUMN period varchar(8);
--> statement-breakpoint
UPDATE subscriptions SET period = 'month' WHERE period IS NULL;
--> statement-breakpoint
ALTER TABLE subscriptions ALTER COLUMN period SET NOT NULL;
--> statement-breakpoint
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_period_check
  CHECK (period IN ('month', 'year'));
--> statement-breakpoint

-- Nullable: most subscriptions have no move in flight. It answers "the period
-- this account is moving to", which is a different question from "the period
-- it is on" whenever a change is waiting on a payment.
ALTER TABLE subscriptions ADD COLUMN pending_period varchar(8);
--> statement-breakpoint
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_pending_period_check
  CHECK (pending_period IS NULL OR pending_period IN ('month', 'year'));
