ALTER TABLE "users" ADD COLUMN "recovery_code_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_code_used_at" timestamp with time zone;