-- Project lifecycle outbox + drop the abandoned business-DB yjs_documents.
--
-- The Yjs document store moved to its own database (YJS_DATABASE_URL,
-- migrations-yjs/). The business DB's copy of `yjs_documents` is now
-- abandoned — the repo + every runtime access target `yjsDb`. Drop it
-- here (this also clears the old dev rows; per the two-DB cutover
-- decision no data is migrated, the new yjs DB starts empty).
--
-- Add the transactional outbox that bridges a project delete / duplicate
-- (committed in the business tx) to collab's yjs-DB cascade, forwarded
-- via the `project-lifecycle` Redis Stream.
--
-- Hand-written (drizzle-kit generate needs a TTY to resolve the
-- add+drop as distinct tables rather than a rename); no snapshot, same
-- as migrations 0018-0021.
CREATE TABLE "project_lifecycle_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "project_lifecycle_outbox_unsent_idx" ON "project_lifecycle_outbox" ("created_at") WHERE "sent_at" IS NULL;
--> statement-breakpoint
DROP TABLE "yjs_documents";
