ALTER TABLE "node_history" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD COLUMN "deleted_at" timestamp with time zone;