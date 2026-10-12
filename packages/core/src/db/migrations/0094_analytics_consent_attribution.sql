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
