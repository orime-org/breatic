-- The terms an account agreed to when it was created (#302). The sign-in and
-- sign-up cards both carry the terms line; a new account records the version
-- from config/legal.yaml and the moment it was made. Existing accounts keep
-- null: nothing records what they saw.
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_version" varchar(32);
