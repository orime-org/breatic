-- inner#1611: credits reserved for work that has started and not yet been
-- charged. An admission counts what the studio's purchases hold, less its
-- debt, less every hold still counted here; the charge that settles the work
-- releases its hold in the same transaction.
--
-- `reference_id` is the task id of the run the hold stands for. A key is used
-- once.
--
-- A hold stops counting at `expires_at` without the row changing, so work that
-- dies without reaching its release still frees the credits.

CREATE TABLE "credit_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"reference_id" varchar(255) NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"status" varchar(16) DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- No `deleted_at`: a hold ends by being released, and that is recorded in
-- `status`. Soft-deleting a row would release it without saying so.

ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_studio_id_fk"
	FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_actor_user_id_fk"
	FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_amount_check" CHECK ("amount" >= 0);--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_status_check" CHECK ("status" IN ('held', 'released'));--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_released_at_check"
	CHECK (("status" = 'released') = ("released_at" IS NOT NULL));--> statement-breakpoint

CREATE UNIQUE INDEX "credit_holds_reference_id_idx" ON "credit_holds" ("reference_id");--> statement-breakpoint
-- What an admission sums: the holds of one studio still counted.
CREATE INDEX "credit_holds_studio_held_idx" ON "credit_holds" ("studio_id", "expires_at") WHERE "status" = 'held';
