ALTER TABLE "conversations" RENAME COLUMN "last_consolidated_count" TO "last_consolidated_turn";--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "tokens_used" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "model" varchar(100);--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN "provider" varchar(50);