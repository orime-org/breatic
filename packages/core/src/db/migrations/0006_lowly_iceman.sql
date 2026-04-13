ALTER TABLE "tasks" ADD COLUMN "provider_result_url" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "billed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "billed_credits" double precision;