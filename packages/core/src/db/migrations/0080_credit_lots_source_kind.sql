-- #267: a lot carries what it came from, so no reader has to join for it.
--
-- Trial credits are the first lot that is not a payment, and three decisions
-- turn on the kind: a non-purchased lot cannot be re-designated, cannot be
-- refunded, and prints its origin instead of a price. Each of those readers
-- holds a lot row and nothing else — `designateLot` and `requestRefund` see
-- only what `lockLot` returns, and that read takes a row lock the charge loop
-- runs per candidate lot on every generation.
--
-- So the kind lives on the lot, exactly as `payments` already carries it
-- (0079): a `source_kind` column beside `source_id`, and a composite key over
-- the pair. `credit_sources_id_kind_key` was created for this. The plain
-- single-column key already here would take a lot claiming `payment` while
-- its receipt says `gift`, and the kind is what all three decisions read.
--
-- Unlike `payments.source_kind` this column has no CHECK pinning it to one
-- value and no default: a lot may come from any of the four kinds, and which
-- one is the caller's to state.
--
-- Hand-written (same pattern as 0079): .sql + _journal entry, no snapshot.

ALTER TABLE "credit_lots" ADD COLUMN "source_kind" varchar(16);
--> statement-breakpoint

-- Read from the receipt each lot already points at rather than written as a
-- constant: every lot today came from a payment, and asking the parent says
-- so for each row instead of asserting it for all of them.
UPDATE "credit_lots" SET "source_kind" = "credit_sources"."kind"
	FROM "credit_sources" WHERE "credit_sources"."id" = "credit_lots"."source_id";
--> statement-breakpoint

ALTER TABLE "credit_lots" ALTER COLUMN "source_kind" SET NOT NULL;
--> statement-breakpoint

-- Replaced rather than kept alongside: the composite key implies the single
-- column one, and leaving both would have two constraints enforcing the same
-- reference with only one of them checking the kind.
ALTER TABLE "credit_lots" DROP CONSTRAINT "credit_lots_source_id_fk";
--> statement-breakpoint

ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_source_fk"
	FOREIGN KEY ("source_id", "source_kind") REFERENCES "credit_sources"("id", "kind")
	ON DELETE restrict;
