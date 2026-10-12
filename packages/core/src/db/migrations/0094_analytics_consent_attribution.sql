-- Product analytics (inner#1442). `users.analytics_consent` holds the latest
-- consent the account's browsers reported, read by events no browser is
-- behind; `users.attribution` holds the first-touch and last-touch campaign
-- source written at sign-up; `upload_grants.analytics_consent` carries the
-- uploading browser's consent to the finish paths; `subscriptions.first_active_at`
-- marks the one write that counts as a subscription start. All nullable:
-- rows from before this have no choice on record and send nothing.
ALTER TABLE "users" ADD COLUMN "analytics_consent" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "attribution" jsonb;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "analytics_consent" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "first_active_at" timestamp with time zone;
--> statement-breakpoint
-- A subscription already on record has started, so its first activation is
-- back-filled: without it the next write to an existing subscription would be
-- reported as a new one. Stripe's `incomplete` and `incomplete_expired` are
-- the only states a subscription can hold without ever having been active.
UPDATE "subscriptions" SET "first_active_at" = "created_at"
  WHERE "status" NOT IN ('incomplete', 'incomplete_expired');--> statement-breakpoint
-- What was reported to the ad platform (inner#1442 §4.9). The key makes one
-- conversion queue once; the status lets a refund restate only a conversion
-- the platform received, since an unknown transaction id counts as new.
CREATE TABLE "ads_conversion_uploads" (
  "conversion" varchar(32) NOT NULL,
  "transaction_id" varchar(255) NOT NULL,
  "payment_id" uuid,
  "status" varchar(16) NOT NULL,
  "job" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ads_conversion_uploads_conversion_transaction_id_pk" PRIMARY KEY ("conversion", "transaction_id"),
  CONSTRAINT "ads_conversion_uploads_status_check"
    CHECK ("status" IN ('queued', 'uploaded', 'failed', 'restating', 'restated', 'restate_failed'))
);--> statement-breakpoint
ALTER TABLE "ads_conversion_uploads" ADD CONSTRAINT "ads_conversion_uploads_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ads_conversion_uploads_payment_idx" ON "ads_conversion_uploads" USING btree ("payment_id");
