-- #259: a lot of credits records what it came from, not that it was paid for.
--
-- `credit_lots.payment_id` was NOT NULL and referenced `payments`, which spelled
-- "a lot always comes from a payment" into the schema. Back-office compensation
-- credits have a compensation record and no payment, so the column is renamed
-- to `source_id` and repointed at a parent table that carries the kind.
--
-- A payment shares its source's primary key: `payments.id` IS the source id, so
-- no row carries a second column pointing elsewhere and `credit_lots` keeps the
-- values it already holds — this migration moves no data. The constant
-- `source_kind` column and the composite key beside it are what make the
-- database refuse a payment filed under some other kind; the plain single-column
-- key would take one, and `kind` is the only column that says where a lot's
-- money came from.
--
-- Hand-written (same pattern as 0061 / 0077): .sql + _journal entry, no
-- snapshot. The CHECK constraints are maintained here, not declared in drizzle,
-- for the reason 0061 gives: a `check()` beside the column would be a second
-- copy that no tool compares against this one.

CREATE TABLE "credit_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	-- What kind of receipt this is. Today every row is a payment; compensation,
	-- gift and discount each get their own child table when they are built.
	"kind" varchar(16) NOT NULL,
	-- Append-only, and no `deleted_at`: a receipt outlives the credits it
	-- opened, and one that could vanish would leave lots pointing at nothing.
	-- This is the written reason the soft-delete mandate is waived here.
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_sources_kind_check"
		CHECK ("kind" IN ('payment', 'compensation', 'gift', 'discount')),
	-- Nothing extra in row terms — `id` is already the primary key. It exists
	-- to give a child table something composite to reference.
	CONSTRAINT "credit_sources_id_kind_key" UNIQUE ("id", "kind")
);
--> statement-breakpoint

-- Every payment that already landed opens its own receipt, keeping its id and
-- the moment it was made. The date on a receipt is the date of the thing it
-- records, not of this migration.
INSERT INTO "credit_sources" ("id", "kind", "created_at")
	SELECT "id", 'payment', "created_at" FROM "payments";
--> statement-breakpoint

ALTER TABLE "payments" ADD COLUMN "source_kind" varchar(16) DEFAULT 'payment' NOT NULL;
--> statement-breakpoint

ALTER TABLE "payments" ADD CONSTRAINT "payments_source_kind_check"
	CHECK ("source_kind" = 'payment');
--> statement-breakpoint

ALTER TABLE "payments" ADD CONSTRAINT "payments_source_fk"
	FOREIGN KEY ("id", "source_kind") REFERENCES "credit_sources"("id", "kind")
	ON DELETE restrict;
--> statement-breakpoint

-- The values stay put: a lot's `payment_id` already holds the id its source row
-- was just given.
ALTER TABLE "credit_lots" DROP CONSTRAINT "credit_lots_payment_id_fk";
--> statement-breakpoint

ALTER TABLE "credit_lots" RENAME COLUMN "payment_id" TO "source_id";
--> statement-breakpoint

ALTER INDEX "credit_lots_payment_id_idx" RENAME TO "credit_lots_source_id_idx";
--> statement-breakpoint

ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_source_id_fk"
	FOREIGN KEY ("source_id") REFERENCES "credit_sources"("id")
	ON DELETE restrict;
