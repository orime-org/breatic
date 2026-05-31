-- PR3 (二次调整): migrate the per-user credit balance out of the
-- `users.credits` column into a dedicated `credit_balances` table so the
-- credit domain becomes self-contained (no longer coupled to the user
-- identity table) ahead of moving it into @breatic/domain (PR4).
--
-- Single source of truth, no dual-write:
--   1. Create credit_balances (one row per user).
--   2. Backfill every user's current balance from users.credits.
--   3. Drop the old users.credits column.

CREATE TABLE "credit_balances" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
INSERT INTO "credit_balances" ("user_id", "balance") SELECT "id", "credits" FROM "users";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "credits";
